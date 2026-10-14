import K from './knowledge.generated.mjs';

const line = (v) => [v.years, `lug ${v.lugPattern}`, `CB ${v.centerBore}`, v.thread, `offset ${v.offset}`, v.notes].filter(Boolean).join(' | ');

const cache = new Map();

export function buildSystemPrompt({ includeArchive = true } = {}) {
  const key = includeArchive ? 1 : 0;
  if (cache.has(key)) return cache.get(key);

  const site = K.site.map((v) => `${v.group} ${v.vehicle} | ${[v.years, `lug ${v.lugPattern}`, `CB ${v.centerBore}`, v.thread, `offset ${v.offset}`, v.notes].filter(Boolean).join(' | ')}`).join('\n');
  const vendors = K.vendors.map((v) => `${v.vendor}: ${v.brands}`).join('\n');
  let out = `${K.instructions}\n\n## Glossary and formulas\n${K.glossary}\n\n` +
    `## DATABASE (label answers "From our database (unsourced):")\nOnly these vehicles are in the database. No record has a cited source and none is independently verified. Values are reference values; "Recent" means the year range was not recorded. Fields: years | lug pattern | center bore | thread | offset | notes.\n${site}\n\n` +
    `## WHEEL VENDOR DIRECTORY (who distributes which brands; not inventory)\n${vendors}\n`;

  if (includeArchive) {
    const arch = K.archive.map((e) => {
      const flag = e.conflictingFields.length ? ` [records disagree on: ${e.conflictingFields.join(', ')}]` : '';
      const base = e.onCurrentSite ? ' [also in DATABASE; older values below]' : '';
      return `${e.manufacturer} ${e.vehicle}${base}${flag}\n` + e.variants.map((v) => `  - ${line(v)}`).join('\n');
    }).join('\n');
    out += `\n## UNVERIFIED ARCHIVE (label answers "Unverified archive:")\nOlder, unreviewed records. Not confirmed current. Never present these as verified or confirmed. If records disagree, show the range and say so.\n${arch}\n`;
  } else {
    out += `\n## UNVERIFIED ARCHIVE\nNone loaded. Anything not in the DATABASE is unverified.\n`;
  }
  cache.set(key, out);
  return out;
}
