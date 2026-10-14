import { createAnnouncementItemHandler } from '../../src/announcements-api.mjs';
import { createDeviceProtectedHandler } from '../../src/device-approval.mjs';

export default createDeviceProtectedHandler(createAnnouncementItemHandler());
