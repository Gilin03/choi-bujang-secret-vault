export const RESOURCE_IDS = Object.freeze({
  personalNotes: 'student_notes',
  instructorAnnouncements: 'instructor_announcements',
});

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SAFE_RESOURCE_ID = '(?!\\.{1,2}$)[^/?#%\\\\\\x00-\\x1f]+';
const RESERVED_RESOURCE_IDS = new Set(['export', 'backup', 'restore', 'admin', 'all', 'upload']);
const NOTE_ITEM = new RegExp(`^/notes/${SAFE_RESOURCE_ID}$`, 'iu');
const ANNOUNCEMENT_ITEM = new RegExp(`^/announcements/${UUID}$`, 'iu');

function hasReservedResourceId(path, prefix) {
  const id = path.slice(`${prefix}/`.length).toLowerCase();
  return RESERVED_RESOURCE_IDS.has(id);
}

function verifiedPathContext(request) {
  return request && typeof request === 'object'
    && typeof request.classId === 'string' && request.classId.trim().length > 0
    && typeof request.projectId === 'string' && request.projectId.trim().length > 0
    && typeof request.subjectId === 'string' && request.subjectId.trim().length > 0
    && /^[0-9a-f]{16}$/u.test(request.deviceId ?? '')
    && request.queryLength === 0
    && typeof request.service === 'string'
    && typeof request.method === 'string'
    && typeof request.path === 'string'
    && typeof request.route === 'string';
}

function normalizeApiPrefix(request, resource) {
  const apiPrefix = `/api/${resource}`;
  const routePrefix = `${request.method} ${apiPrefix}`;
  const hasApiPath = request.path === apiPrefix || request.path.startsWith(`${apiPrefix}/`);
  const hasApiRoute = request.route === routePrefix || request.route.startsWith(`${routePrefix}/`);

  if (request.service !== resource || !hasApiPath || !hasApiRoute) return request;

  return {
    ...request,
    path: request.path.slice('/api'.length),
    route: request.route.replace(routePrefix, `${request.method} /${resource}`),
  };
}

export function classifyResourceRequest(request) {
  if (!verifiedPathContext(request)) return null;
  const normalized = normalizeApiPrefix(normalizeApiPrefix(request, 'notes'), 'announcements');
  const { service, method, path, route } = normalized;

  if (service === 'notes') {
    if (path === '/api/my/notes' && method === 'GET' && route === 'GET /api/my/notes') {
      return { resourceId: RESOURCE_IDS.personalNotes, operation: 'read' };
    }
    if (path === '/notes' && route === `${method} /notes` && method === 'POST') {
      return { resourceId: RESOURCE_IDS.personalNotes, operation: method.toLowerCase() };
    }
    if (NOTE_ITEM.test(path) && !hasReservedResourceId(path, '/notes')
        && route === `${method} /notes/:id`
        && ['GET', 'PUT', 'DELETE'].includes(method)) {
      return { resourceId: RESOURCE_IDS.personalNotes, operation: method.toLowerCase() };
    }
    return null;
  }

  if (service === 'announcements') {
    if (path === '/announcements' && method === 'GET' && route === 'GET /announcements') {
      return { resourceId: RESOURCE_IDS.instructorAnnouncements, operation: 'read' };
    }
    if (ANNOUNCEMENT_ITEM.test(path) && method === 'GET' && route === 'GET /announcements/:id') {
      return { resourceId: RESOURCE_IDS.instructorAnnouncements, operation: 'read' };
    }
    if (ANNOUNCEMENT_ITEM.test(path) && method === 'PUT' && route === 'PUT /announcements/:id') {
      return { resourceId: RESOURCE_IDS.instructorAnnouncements, operation: 'instructor_update' };
    }
  }

  return null;
}
