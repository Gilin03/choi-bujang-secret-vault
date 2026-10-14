import { createNoteItemHandler } from '../../src/notes-api.mjs';
import { createDeviceProtectedHandler } from '../../src/device-approval.mjs';

export default createDeviceProtectedHandler(createNoteItemHandler());
