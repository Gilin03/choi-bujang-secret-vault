import { createSessionApprovalHandlers, createSessionProtectedHandler } from '../../src/session-approval.mjs';
import { createOperationsHandler } from '../../src/operations-api.mjs';
import { recordOperationResult } from '../../src/operations-log.mjs';

const ROUTES = new Map([
  ['GET /api/session-approval/status', 'status'],
  ['POST /api/session-approval/request', 'request'],
  ['GET /api/session-approval/operations', 'operations'],
]);

export function createSessionApprovalApiHandler(options = {}) {
  const handlers = createSessionApprovalHandlers({ recordResult: recordOperationResult, ...options });
  handlers.operations = createSessionProtectedHandler(createOperationsHandler(options), { ...options, recordResult: null });
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
