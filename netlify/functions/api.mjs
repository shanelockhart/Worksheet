import { handle } from '../../server/handler.mjs';

export default async (request, context) => {
  const ip = context?.ip || request.headers.get('x-nf-client-connection-ip') || '';
  return handle(request, { ip, env: process.env });
};

export const config = { path: '/api/*' };
