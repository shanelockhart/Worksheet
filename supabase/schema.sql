-- Fitment Expert chat: usage tracking and rate limiting.
-- Run this once in the Supabase SQL editor (safe to re-run).
--
-- Only the server (service_role key) may touch these objects. The browser never talks to Supabase.
--
-- Model: every submitted question inserts one row per "subject" (guest session or user, plus network)
-- and one 'global' row. Limits are counted over a rolling window of those rows. A row is inserted as
-- 'reserved' BEFORE the AI provider is called and deleted again if the provider fails, so failed
-- requests never use up the allowance. All checks and inserts happen inside one function call, under
-- advisory locks, so concurrent requests cannot slip past a limit.

create or replace function public.fx_now()
returns timestamptz
language sql
stable
as $$ select now() $$;

create table if not exists public.fx_usage (
  id          bigint generated always as identity primary key,
  reservation uuid        not null,
  subject     text        not null,
  scope       text        not null check (scope in ('session', 'user', 'ip', 'new_session', 'global')),
  status      text        not null default 'reserved' check (status in ('reserved', 'committed')),
  tokens_in   integer,
  tokens_out  integer,
  created_at  timestamptz not null default now()
);

create index if not exists fx_usage_subject_created_idx on public.fx_usage (subject, created_at);
create index if not exists fx_usage_reservation_idx     on public.fx_usage (reservation);
create index if not exists fx_usage_global_created_idx  on public.fx_usage (created_at) where scope = 'global';

alter table public.fx_usage enable row level security;   -- no policies: only service_role (bypasses RLS) can use it

-- Subject prefixes: g: guest session, u: signed-in user, ip: network (hashed), ipn: new-session counter, global
create or replace function public.fx_scope(p_subject text)
returns text
language sql
immutable
as $$
  select case
    when p_subject like 'g:%'   then 'session'
    when p_subject like 'u:%'   then 'user'
    when p_subject like 'ipn:%' then 'new_session'
    when p_subject like 'ip:%'  then 'ip'
    else 'global'
  end
$$;

-- State of one rolling-window bucket: how many used, how many left, and when a slot frees up.
create or replace function public.fx_bucket_state(p_subject text, p_limit int, p_window interval, p_now timestamptz)
returns jsonb
language plpgsql
stable
as $$
declare
  v_used int;
  v_next timestamptz;
begin
  select count(*) into v_used
    from public.fx_usage
   where subject = p_subject and created_at > p_now - p_window;

  if v_used >= p_limit then
    -- The count drops below the limit when the (used - limit + 1)th oldest event leaves the window.
    select created_at + p_window into v_next
      from public.fx_usage
     where subject = p_subject and created_at > p_now - p_window
     order by created_at asc, id asc
     offset (v_used - p_limit) limit 1;
  end if;

  return jsonb_build_object(
    'subject',   p_subject,
    'scope',     public.fx_scope(p_subject),
    'limit',     p_limit,
    'used',      v_used,
    'remaining', greatest(p_limit - v_used, 0),
    'next_at',   v_next
  );
end
$$;

-- Daily (UTC) global usage.
create or replace function public.fx_daily_state(p_cap int, p_now timestamptz)
returns jsonb
language plpgsql
stable
as $$
declare
  v_start timestamptz := date_trunc('day', p_now at time zone 'utc') at time zone 'utc';
  v_used  int;
begin
  select count(*) into v_used from public.fx_usage where scope = 'global' and created_at >= v_start;
  return jsonb_build_object(
    'used',      v_used,
    'cap',       p_cap,
    'reset_at',  v_start + interval '1 day',
    'reached',   (p_cap > 0 and v_used >= p_cap)
  );
end
$$;

-- Read-only status (does not consume anything).
create or replace function public.fx_status(p_subjects text[], p_limits int[], p_window_seconds int, p_daily_cap int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := public.fx_now();
  v_window  interval := make_interval(secs => p_window_seconds);
  v_buckets jsonb := '[]'::jsonb;
  v_i       int;
begin
  for v_i in 1 .. coalesce(array_length(p_subjects, 1), 0) loop
    v_buckets := v_buckets || public.fx_bucket_state(p_subjects[v_i], p_limits[v_i], v_window, v_now);
  end loop;
  return jsonb_build_object('ok', true, 'buckets', v_buckets, 'daily', public.fx_daily_state(p_daily_cap, v_now));
end
$$;

-- Check every limit and, only if all pass, reserve one question against each subject plus the global counter.
-- p_subjects are ordered most specific first (session/user, then network).
create or replace function public.fx_reserve(
  p_reservation   uuid,
  p_subjects      text[],
  p_limits        int[],
  p_window_seconds int,
  p_daily_cap     int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now      timestamptz := public.fx_now();
  v_window   interval := make_interval(secs => p_window_seconds);
  v_subject  text;
  v_sorted   text[];
  v_state    jsonb;
  v_buckets  jsonb := '[]'::jsonb;
  v_daily    jsonb;
  v_reason   text;
  v_retry    timestamptz;
  v_next     timestamptz;
  v_i        int;
begin
  if p_subjects is null or array_length(p_subjects, 1) is null
     or array_length(p_subjects, 1) <> array_length(p_limits, 1) then
    raise exception 'subjects and limits must be non-empty and the same length';
  end if;

  -- Serialize competing requests per subject (sorted order avoids deadlocks); the global lock goes last.
  select array_agg(s order by s) into v_sorted from unnest(p_subjects) as s;
  foreach v_subject in array v_sorted loop
    perform pg_advisory_xact_lock(hashtextextended(v_subject, 0));
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('fx:global', 0));

  -- Opportunistic cleanup of old rows (keeps the table small).
  delete from public.fx_usage
   where id in (select id from public.fx_usage where created_at < v_now - interval '3 days' limit 200);

  v_daily := public.fx_daily_state(p_daily_cap, v_now);
  if (v_daily->>'reached')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'daily_cap', 'retry_at', v_daily->>'reset_at',
                              'buckets', '[]'::jsonb, 'daily', v_daily);
  end if;

  for v_i in 1 .. array_length(p_subjects, 1) loop
    v_state := public.fx_bucket_state(p_subjects[v_i], p_limits[v_i], v_window, v_now);
    v_buckets := v_buckets || v_state;
    if (v_state->>'remaining')::int = 0 then
      v_reason := coalesce(v_reason, v_state->>'scope');
      v_next := (v_state->>'next_at')::timestamptz;
      v_retry := case when v_retry is null then v_next else greatest(v_retry, v_next) end;
    end if;
  end loop;

  if v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v_reason, 'retry_at', v_retry,
                              'buckets', v_buckets, 'daily', v_daily);
  end if;

  for v_i in 1 .. array_length(p_subjects, 1) loop
    insert into public.fx_usage (reservation, subject, scope, status, created_at)
    values (p_reservation, p_subjects[v_i], public.fx_scope(p_subjects[v_i]), 'reserved', v_now);
  end loop;
  insert into public.fx_usage (reservation, subject, scope, status, created_at)
  values (p_reservation, 'global', 'global', 'reserved', v_now);

  v_buckets := '[]'::jsonb;
  for v_i in 1 .. array_length(p_subjects, 1) loop
    v_buckets := v_buckets || public.fx_bucket_state(p_subjects[v_i], p_limits[v_i], v_window, v_now);
  end loop;

  return jsonb_build_object('ok', true, 'reason', null, 'retry_at', null,
                            'buckets', v_buckets, 'daily', public.fx_daily_state(p_daily_cap, v_now));
end
$$;

-- The provider call failed: give the question back.
create or replace function public.fx_release(p_reservation uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  delete from public.fx_usage where reservation = p_reservation and status = 'reserved';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- The provider call succeeded: keep the question and record token usage for monitoring.
create or replace function public.fx_commit(p_reservation uuid, p_tokens_in int, p_tokens_out int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  update public.fx_usage
     set status = 'committed',
         tokens_in  = case when scope = 'global' then p_tokens_in  else tokens_in  end,
         tokens_out = case when scope = 'global' then p_tokens_out else tokens_out end
   where reservation = p_reservation;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Limit how many new guest sessions one network can create per window.
create or replace function public.fx_new_session(p_subject text, p_limit int, p_window_seconds int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now    timestamptz := public.fx_now();
  v_window interval := make_interval(secs => p_window_seconds);
  v_state  jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_subject, 0));
  v_state := public.fx_bucket_state(p_subject, p_limit, v_window, v_now);
  if (v_state->>'remaining')::int = 0 then
    return jsonb_build_object('ok', false, 'retry_at', v_state->>'next_at');
  end if;
  insert into public.fx_usage (reservation, subject, scope, status, created_at)
  values (gen_random_uuid(), p_subject, 'new_session', 'committed', v_now);
  return jsonb_build_object('ok', true, 'retry_at', null);
end
$$;

-- Lock everything down: server (service_role) only.
revoke all on table public.fx_usage from public, anon, authenticated;
revoke all on function public.fx_status(text[], int[], int, int)      from public, anon, authenticated;
revoke all on function public.fx_reserve(uuid, text[], int[], int, int) from public, anon, authenticated;
revoke all on function public.fx_release(uuid)                         from public, anon, authenticated;
revoke all on function public.fx_commit(uuid, int, int)                from public, anon, authenticated;
revoke all on function public.fx_new_session(text, int, int)           from public, anon, authenticated;
grant execute on function public.fx_status(text[], int[], int, int)      to service_role;
grant execute on function public.fx_reserve(uuid, text[], int[], int, int) to service_role;
grant execute on function public.fx_release(uuid)                         to service_role;
grant execute on function public.fx_commit(uuid, int, int)                to service_role;
grant execute on function public.fx_new_session(text, int, int)           to service_role;
