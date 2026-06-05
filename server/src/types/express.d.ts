import type { UserProfile } from '#@server/models/userProfile.js';

declare module 'express-serve-static-core' {
    interface Request {
        user?: UserProfile;
    }
}
