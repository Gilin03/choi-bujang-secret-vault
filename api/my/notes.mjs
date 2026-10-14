import { createMyNotesHandler } from '../../src/notes-api.mjs';
import { createSessionProtectedHandler } from '../../src/session-approval.mjs';

export default createSessionProtectedHandler(createMyNotesHandler());
