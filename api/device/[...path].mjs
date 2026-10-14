import { createDeviceApprovalHandlers } from '../../src/device-approval.mjs';

const ROUTES = new Map([
  ['GET /api/device/status', 'status'],
  ['POST /api/device/status/verify', 'verifyStatus'],
  ['POST /api/device/status-verify', 'verifyStatus'],
  ['POST /api/device/register/options', 'registerOptions'],
  ['POST /api/device/register-options', 'registerOptions'],
  ['POST /api/device/register', 'register'],
  ['POST /api/device/challenge', 'challenge'],
]);

export function createDeviceApiHandler(options = {}) {
  const handlers = createDeviceApprovalHandlers(options);
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

export default createDeviceApiHandler();
