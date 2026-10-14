import { createAnnouncementHandler } from '../src/announcements-api.mjs';
import { createDeviceProtectedHandler } from '../src/device-approval.mjs';

export default createDeviceProtectedHandler(createAnnouncementHandler());
