import { createSessionApprovalHandlers } from '../../src/session-approval.mjs';

const ROUTES = new Map([
  ['GET /api/session-approval/status', 'status'],
  ['POST /api/session-approval/request', 'request'],
]);

export function createSessionApprovalApiHandler(options = {}) {
  const handlers = createSessionApprovalHandlers(options);
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const name = ROUTES.get(`${request.method.toUpperCase()} ${pathname}`);
      if (!name) {
        return Response.json({ error: 'Not found' }, {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return handlers[name].fetch(request);
    },
  };
}

export default createSessionApprovalApiHandler();
