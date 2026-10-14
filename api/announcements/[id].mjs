import { createAnnouncementItemHandler } from '../../src/announcements-api.mjs';
import { createSessionProtectedHandler } from '../../src/session-approval.mjs';

export default createSessionProtectedHandler(createAnnouncementItemHandler());
