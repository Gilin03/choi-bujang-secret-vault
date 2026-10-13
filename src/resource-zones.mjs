export const RESOURCE_IDS = Object.freeze({
  personalNotes: 'student_notes',
  instructorAnnouncements: 'instructor_announcements',
});

const NOTE_ITEM = /^\/notes\/(?!export$|exports$|download$|all$|list$|search$|bulk$|batch$|share$|shared$|public$|admin$|backup$|dump$|import$|sync$|raw$|query$|count$|report$|stats$|owner$|owners$|user$|users$|others$|any$|notices$|notes$)[A-Za-z0-9_-]{1,64}$/iu;

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

function stripApiPrefix(path) {
  return path.replace(/^\/api(?=\/)/u, '');
}

export function classifyResourceRequest(request) {
  if (!verifiedPathContext(request)) return null;
  const { service, method } = request;
  if (service !== 'notes') return null;

  const path = stripApiPrefix(request.path);
  const routeParts = request.route.split(' ');
  if (routeParts.length !== 2 || routeParts[0] !== method) return null;
  const route = stripApiPrefix(routeParts[1]);

  if (method === 'GET' && path === '/my/notes' && route === '/my/notes') {
    return { resourceId: RESOURCE_IDS.personalNotes, operation: 'read' };
  }
  if (method === 'POST' && path === '/notes' && route === '/notes') {
    return { resourceId: RESOURCE_IDS.personalNotes, operation: 'post' };
  }
  if (NOTE_ITEM.test(path) && route === '/notes/:id'
      && ['GET', 'PUT', 'DELETE'].includes(method)) {
    return { resourceId: RESOURCE_IDS.personalNotes, operation: method.toLowerCase() };
  }

  return null;
}
