export const RESOURCE_IDS = Object.freeze({
  personalNotes: 'student_notes',
  instructorAnnouncements: 'instructor_announcements',
});

const NOTE_ID = '[A-Za-z0-9_-]{1,64}';
const NOTE_ITEM = new RegExp(`^/notes/${NOTE_ID}$`, 'u');
const NOTE_RESTORE = new RegExp(`^/notes/${NOTE_ID}/restore$`, 'u');
const NOTE_FUNCTION_SEGMENTS = new Set([
  'export', 'exports', 'download', 'all', 'list', 'search', 'bulk', 'batch', 'share', 'shared',
  'public', 'admin', 'backup', 'dump', 'import', 'sync', 'raw', 'query', 'count', 'report',
  'stats', 'owner', 'owners', 'user', 'users', 'others', 'any', 'notices', 'notes',
]);

const ZONES = Object.freeze({
  'GET /my/notes': { path: /^\/my\/notes$/u, operation: 'read' },
  'POST /notes': { path: /^\/notes$/u, operation: 'post' },
  'GET /notes/:id': { path: NOTE_ITEM, operation: 'get' },
  'PUT /notes/:id': { path: NOTE_ITEM, operation: 'put' },
  'DELETE /notes/:id': { path: NOTE_ITEM, operation: 'delete' },
  'POST /notes/:id/restore': { path: NOTE_RESTORE, operation: 'restore' },
});

function stripApi(value) {
  return value.replace(/^\/api(?=\/)/u, '');
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

export function classifyResourceRequest(request) {
  if (!verifiedPathContext(request)) return null;
  const { service, method, path, route } = request;
  if (service !== 'notes') return null;

  const separator = route.indexOf(' ');
  if (separator < 0 || route.slice(0, separator) !== method) return null;

  const canonicalPath = stripApi(path);
  const canonicalRoute = stripApi(route.slice(separator + 1));
  const rule = ZONES[`${method} ${canonicalRoute}`];
  if (!rule || !rule.path.test(canonicalPath)) return null;

  const noteId = canonicalPath.startsWith('/notes/')
    ? canonicalPath.slice('/notes/'.length).split('/')[0]
    : null;
  if (noteId !== null && NOTE_FUNCTION_SEGMENTS.has(noteId.toLowerCase())) return null;

  return { resourceId: RESOURCE_IDS.personalNotes, operation: rule.operation };
}
