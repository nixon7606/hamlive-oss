# System Notifications

> **Audience:** Developers and administrators. The Operational Procedures section is directed at operators/admins.

This document describes Ham.Live's system notification framework for delivering important announcements and service updates to users.

## Overview

The system notification feature provides a general-purpose framework for displaying important messages to users. Each notification is shown once per user and tracked server-side to ensure consistent behavior across devices and sessions.

### Use Cases

- **Service announcements** — Inform users of service changes or deprecations
- **Feature releases** — Highlight new features or capabilities
- **Incident notifications** — Communicate outages or degraded service
- **Policy updates** — Notify users of terms or privacy policy changes
- **Maintenance windows** — Alert users to scheduled maintenance

### Design Principles

- **Show-once guarantee** — Each notification displayed exactly once per user
- **Server-controlled** — All notifications managed via database for consistency
- **Non-intrusive** — Users can dismiss and continue normal operations
- **Type-safe** — Full TypeScript support with runtime validation
- **Bootstrap native** — Uses existing UI framework and design patterns

## Architecture

### Data Model

The notification system consists of two data components:

1. **SystemNotification collection** — Defines available notifications
2. **UserProfile.dismissedNotifications** — Tracks which users have seen which notifications

### System Flow

```
Page Load
    ↓
SystemNotificationManager.checkAndDisplayNotifications()
    ↓
GET /api/util/notifications/pending
    ↓
Controller → Helpers → Query active notifications NOT in user's dismissed list
    ↓
Return notifications[] to client
    ↓
Display first notification in modal
    ↓
User clicks "Got it" or close button
    ↓
POST /api/util/notifications/:id/dismiss
    ↓
Update UserProfile.dismissedNotifications[]
    ↓
Save to localStorage as backup
    ↓
Modal dismissed, never shown again to this user
```

---

## Database Schema

### SystemNotification Collection

Stores all system notifications available for display.

**Schema Structure:**

```javascript
{
    _id: ObjectId,
    notificationId: String,        // Unique identifier (e.g., "feature-x-launch-2026-01")
    title: String,                 // Modal title (max 100 chars)
    message: String,               // HTML content for modal body (max 5000 chars)
    severity: String,              // "info" | "warning" | "critical"
    active: Boolean,               // Whether to show this notification
    expiresAt: Date,               // Optional expiration date
    createdAt: Date,               // Auto-generated
    updatedAt: Date                // Auto-generated
}
```

**Validation Rules:**

- `notificationId`: Required, unique, max 100 characters
- `title`: Required, max 100 characters
- `message`: Required, max 5000 characters (supports HTML — admin responsibility to review)
- `severity`: Must be one of: 'info', 'warning', 'critical'; schema default is `'info'`
- `active`: Defaults to `true`
- `expiresAt`: Optional, `null` means never expires

**Indexes:**

- `notificationId` (unique)
- `active` (for fast filtering of active notifications)

**Location:** `server/dist/models/systemNotification.js`

---

### UserProfile.dismissedNotifications

Tracks which notifications each user has dismissed.

**Schema Addition:**

```javascript
{
    // ... existing UserProfile fields ...
    dismissedNotifications: [
        {
            notificationId: String, // Reference to SystemNotification.notificationId
            dismissedAt: Date // When user dismissed it (default: now)
        }
    ];
}
```

**Query Pattern:**

```javascript
// Get notifications user hasn't seen
const dismissedIds = user.dismissedNotifications.map(d => d.notificationId);
const pending = await SystemNotification.find({
    active: true,
    notificationId: { $nin: dismissedIds }
});
```

**Location:** `server/dist/models/userProfile.js`

---

## Server-Side Implementation

### Controller Layer

**File:** `server/dist/controllers/notificationController.js`

**Methods:**

- `getPendingNotifications(req, res)` — Fetches active notifications user hasn't dismissed
- `dismissNotification(req, res)` — Marks notification as dismissed for user

**Pattern:**

```javascript
const getPendingNotifications = (req, res) => {
    handleRequest(res, async () => {
        const notifications = await helpers.fetchPendingNotifications(req.user);
        const transformed = helpers.transformNotifications(notifications);

        const response = prepareEndPointResponse(
            {
                message: {
                    notifications: transformed,
                    count: transformed.length
                }
            },
            undefined,
            undefined,
            res.locals.flexOpts.baseTtlMs
        );

        if (!isSystemNotificationResponse(response)) {
            throw new Error('Invalid notification response format');
        }

        return response;
    });
};
```

**Follows:** Same pattern as `followController`, `netProfileController`

---

### Helper Layer

**File:** `server/dist/lib/controllers/notificationHelpers.js`

**Functions:**

- `fetchPendingNotifications(user)` — Query logic for pending notifications
- `dismissNotificationForUser(user, notificationId)` — Update user's dismissed list
- `isValidNotificationId(id)` — Validation helper
- `transformNotifications(notifications)` — Convert Mongoose docs to client format

**Transform Pattern:**

```javascript
const transformNotifications = notifications => {
    return notifications.map(n => {
        const { id, notificationId, title, message, severity, active, expiresAt, createdAt, updatedAt } = n;
        return { id, notificationId, title, message, severity, active, expiresAt, createdAt, updatedAt };
    });
};
```

Uses Mongoose `id` virtual property (auto-converts ObjectId to string).

**Follows:** Same pattern as `followHelpers`, `liveNetHelpers`

---

### API Endpoints

**Route File:** `server/dist/routes/utilRoutes.js`

#### GET /api/util/notifications/pending

**Purpose:** Fetch active notifications user hasn't dismissed

**Authentication:** Required (`REQ_LOGIN`)

**Response:**

```json
{
    "endpointVersion": "1.0",
    "now": "2026-01-01T16:00:00.000Z",
    "ttlMs": 15000,
    "hash": "...",
    "message": {
        "notifications": [
            {
                "id": "6956956d3561d389de477bcf",
                "notificationId": "feature-x-2026-01",
                "title": "New Feature Available",
                "message": "<p>Check out our new feature...</p>",
                "severity": "info",
                "active": true,
                "expiresAt": null,
                "createdAt": "2026-01-01T15:00:00.000Z",
                "updatedAt": "2026-01-01T15:00:00.000Z"
            }
        ],
        "count": 1
    }
}
```

**Query Logic:**

1. Get user's dismissed notification IDs
2. Query SystemNotification collection for:
    - `active: true`
    - `notificationId` NOT in user's dismissed list
    - Not expired (expiresAt is null or in future)
3. Sort by createdAt descending (newest first)
4. Transform Mongoose documents to client format
5. Validate response with type guard

#### POST /api/util/notifications/:notificationId/dismiss

**Purpose:** Mark notification as dismissed for current user

**Authentication:** Required (`REQ_LOGIN`)

**URL Parameters:**

- `notificationId` — The notification identifier to dismiss

**Response:**

```json
{
    "endpointVersion": "1.0",
    "now": "2026-01-01T16:00:00.000Z",
    "ttlMs": 1,
    "hash": "...",
    "message": {
        "success": true,
        "notificationId": "feature-x-2026-01"
    }
}
```

**Update Logic:**

```javascript
UserProfile.findByIdAndUpdate(userId, {
    $addToSet: {
        dismissedNotifications: {
            notificationId,
            dismissedAt: new Date()
        }
    }
});
```

Uses `$addToSet` to prevent duplicate dismissals.

---

## Client-Side Implementation

### SystemNotificationManager

**File:** `client/src/public/js/lib/systemNotifications.ts`

**Purpose:** Manages notification display and dismissal lifecycle

**Key Methods:**

- `checkAndDisplayNotifications()` — Fetch and display pending notification
- `displayNotification(notification)` — Show Bootstrap modal
- `dismissNotification(notificationId)` — Record dismissal server + localStorage

**Integration Pattern:**

```typescript
// In view main.ts files (liveNet, favorites, etc.)
import { SystemNotificationManager } from '#@client/lib/systemNotifications.js';

void initAndLogError(async () => {
    const notificationManager = new SystemNotificationManager();
    await notificationManager.checkAndDisplayNotifications();
});
```

**Current Integration:**

- `client/src/public/js/byView/liveNet/main.ts`
- `client/src/public/js/byView/favorites/main.ts`

**Future Integration:**

- Dashboard, myNets, myAccount views (as needed)

---

### Modal UI

**Structure:**

```html
<div class="modal fade" data-bs-backdrop="static" data-bs-keyboard="false">
    <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">
                    <i class="bi bi-exclamation-circle-fill"></i>
                    Title Here
                    <span class="badge bg-primary">WARNING</span>
                </h5>
                <button class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <!-- HTML message content -->
            </div>
            <div class="modal-footer">
                <button class="btn btn-primary">Got it</button>
            </div>
        </div>
    </div>
</div>
```

**Severity Styling:**

| Severity   | Icon                    | Badge Color      | Use Case                        |
| ---------- | ----------------------- | ---------------- | ------------------------------- |
| `info`     | ℹ️ info-circle          | Teal (secondary) | General announcements, features |
| `warning`  | ⚠️ exclamation-circle   | Orange (primary) | Service changes, deprecations   |
| `critical` | ⚠️ exclamation-triangle | Red (danger)     | Outages, urgent actions         |

**Matches:** Existing modal patterns in `myAccount.ejs`, `dataPrivacy.ejs`, `myNets.ejs`

---

### Dual-Layer Tracking

The client implements redundant dismissal tracking:

**Primary:** Database (server-side)

- Authoritative source of truth
- Persists across devices/browsers
- Query: Check `UserProfile.dismissedNotifications`

**Backup:** localStorage (client-side)

- Fast local check before API call
- Prevents re-showing if server fails
- Storage: `localStorage.dismissedNotifications` (JSON array)

**Flow:**

1. Check localStorage first (fast)
2. If not dismissed locally, call API
3. API checks database
4. On dismiss: update both database AND localStorage

---

## TypeScript Types and Validation

### Type Definitions

**File:** `client/src/public/js/types/commonTypes.ts`

```typescript
export interface SystemNotification {
    id: string;
    notificationId: string;
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    active: boolean;
    expiresAt?: Date | string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
}

export interface SystemNotificationResponse extends EndPointResponse {
    message: {
        notifications: SystemNotification[];
        count: number;
    };
}
```

### Type Guards

**File:** `client/src/public/js/types/commonTypesupport.ts`

```typescript
// Validates individual notification object
export const isSystemNotification = createTypeGuard<SystemNotification>({
    id: value => typeof value === 'string',
    notificationId: value => typeof value === 'string',
    title: value => typeof value === 'string',
    message: value => typeof value === 'string',
    severity: value => value === 'info' || value === 'warning' || value === 'critical',
    active: value => typeof value === 'boolean',
    expiresAt: value => value === undefined || value === null || value instanceof Date || typeof value === 'string',
    createdAt: value => value instanceof Date || typeof value === 'string',
    updatedAt: value => value instanceof Date || typeof value === 'string'
});

// Validates API response
export const isSystemNotificationResponse = createTypeGuard<SystemNotificationResponse>({
    ...endPointResponseFields,
    message: value => isSystemNotificationMessage(value)
});
```

**Usage in Controller:**

```javascript
if (!isSystemNotificationResponse(response)) {
    throw new Error('Invalid notification response format');
}
```

**Follows:** Same pattern as `isFollowListResponse`, `isLiveNetDetailsResponse`

---

## Operational Procedures

> **Admin/Operator:** The procedures in this section require direct database access or use of the management CLI. They are not available through the web UI.

### manageNotifications.js — interactive CLI

The canonical tool for managing system notifications is `server/dist/bin/manageNotifications.js`. It provides a full-screen interactive terminal interface with a single-letter menu.

**Usage:**

```bash
# Development database (default)
cd server/dist
node bin/manageNotifications.js

# Production database
node bin/manageNotifications.js --production
# or: node bin/manageNotifications.js -p

# Non-interactive: load from JSON file
node bin/manageNotifications.js --file notifications/my-announcement.json

# Non-interactive with auto-confirm (no prompts)
node bin/manageNotifications.js --file notifications/my-announcement.json --yes
# or: node bin/manageNotifications.js -f notifications/my-announcement.json -y
```

**Command-line flags:**

| Flag | Alias | Description |
|---|---|---|
| `--production` | `-p` | Connect to production database |
| `--file <path>` | `-f` | Load notification from JSON file (non-interactive) |
| `--yes` | `-y` | Skip confirmation prompts (use with `--file`) |
| `--help` | | Show help |

**Interactive menu (single-letter keys):**

| Key | Action |
|---|---|
| `n` | New notification (interactive prompts) |
| `t` | Toggle active state on/off |
| `d` | Delete a notification |
| `s` | Stats & reporting (dismissal counts, engagement) |
| `r` | Reset dismissals (for testing) |
| `f` | Load notification from JSON file |
| `q` | Quit |

The menu displays current notifications with active status, severity, and "% seen" before each action.

### Interactive quick-create prompts

When pressing `n`, the tool prompts for:

- **ID** — defaults to `announcement-YYYY-MM`; can overwrite an existing notification
- **Title** — required
- **Message** — HTML accepted; enter a blank line to finish
- **Severity** — single key: `i` info, `w` warning, `c` critical; **default is `w` (warning)**

Note: the interactive default for severity is `'warning'`, while the Mongoose schema default for severity is `'info'`. When loading from a JSON file, omitting `severity` produces `'warning'` (the `loadFromFileCore` code default).

### JSON file format

Use `--file` to load a notification non-interactively. The JSON file supports:

```json
{
    "notificationId": "my-announcement-2026-06",
    "title": "Announcement Title",
    "message": "<p>HTML message content.</p>",
    "severity": "warning",
    "active": true,
    "expiresAt": null,
    "supersedes": ["old-announcement-2026-01", "older-announcement-2025-12"]
}
```

**`supersedes` array:** When provided, the tool atomically deletes all listed notification IDs before inserting the new one. Use this to replace an old notification with a revised version without leaving orphaned records. The delete and insert happen in the same run but are not a single MongoDB transaction; the operation is effectively atomic for small sets.

**`expiresAt`:** Optional ISO date string (e.g., `"2026-12-31T00:00:00Z"`). Null means never expires.

`severity`, `active`, and `supersedes` are optional and default to `'warning'`, `true`, and `[]` respectively when omitted from the file.

### Resetting dismissals (testing)

The `r` menu option lets you:

- Reset dismissals for a specific notification (pulls records from `UserProfile.dismissedNotifications`)
- Reset ALL dismissals across all notifications and users

It shows the affected user count and requires confirmation before proceeding.

**Manual reset in mongosh:**

```javascript
// Reset for a single user
db.userprofiles.updateOne(
  { email: 'user@example.com' },
  { $set: { dismissedNotifications: [] } }
);
```

**Reset browser localStorage (browser console):**

```javascript
localStorage.removeItem('dismissedNotifications');
location.reload();
```

### Direct mongosh operations

For situations where the CLI is not available:

```javascript
// Connect
mongosh mongodb://localhost:27017/hamlive-dev

// Deactivate (stop showing to new users)
db.systemnotifications.updateOne(
  { notificationId: 'feature-x-2026-01' },
  { $set: { active: false } }
);

// Reactivate
db.systemnotifications.updateOne(
  { notificationId: 'feature-x-2026-01' },
  { $set: { active: true } }
);

// Delete permanently
db.systemnotifications.deleteOne({ notificationId: 'feature-x-2026-01' });
```

---

## Request/Response Patterns

### Fetch Pending Notifications

**Request:**

```http
GET /api/util/notifications/pending HTTP/1.1
Cookie: connect.sid=...
```

**Response (Standard EndPointResponse envelope):**

```json
{
    "endpointVersion": "1.0",
    "now": "2026-01-01T16:00:00.000Z",
    "ssePath": null,
    "ttlMs": 15000,
    "hash": "sha256-hash",
    "message": {
        "notifications": [
            {
                "id": "6956956d3561d389de477bcf",
                "notificationId": "feature-x-2026-01",
                "title": "New Feature",
                "message": "<p>HTML content</p>",
                "severity": "info",
                "active": true,
                "expiresAt": null,
                "createdAt": "2026-01-01T15:00:00.000Z",
                "updatedAt": "2026-01-01T15:00:00.000Z"
            }
        ],
        "count": 1
    }
}
```

**Cache TTL:** Based on `flexOpts.baseTtlMs` (typically 15 seconds)

### Dismiss Notification

**Request:**

```http
POST /api/util/notifications/feature-x-2026-01/dismiss HTTP/1.1
Cookie: connect.sid=...
```

**Response:**

```json
{
    "endpointVersion": "1.0",
    "now": "2026-01-01T16:00:05.000Z",
    "ssePath": null,
    "ttlMs": 1,
    "hash": "sha256-hash",
    "message": {
        "success": true,
        "notificationId": "feature-x-2026-01"
    }
}
```

**Cache TTL:** 1ms (effectively no cache)

---

## Error Handling

### Common Error Scenarios

**User not authenticated:**

- Status: 401 Unauthorized
- Middleware: `authCheck(REQ_LOGIN)` handles this

**Invalid notificationId:**

- Status: 500 Internal Server Error
- Message: "Invalid notificationId format"
- Validation: Length check (1-100 chars)

**Database errors:**

- Status: 500 Internal Server Error
- Logged server-side
- Generic error message returned to client

**Network failures:**

- Client catches and logs errors
- Notification still marked dismissed in localStorage
- Prevents re-showing during same session

---

## Integration Points

### Middleware

Notification endpoints use standard Ham.Live middleware:

- `authCheck(REQ_LOGIN)` — Verify user authentication
- FlexOpts injection via `res.locals` — Provides `baseTtlMs`
- Standard error handling via `handleRequest()` wrapper

### Response Utilities

Uses `ResponseHandler` and `prepareEndPointResponse`:

```javascript
const response = prepareEndPointResponse({ message: { notifications, count } }, undefined, undefined, ttlMs);
```

**Standard envelope includes:**

- `endpointVersion`, `now`, `ttlMs`, `hash`
- Error handling with `errorMessage`, `errorHash`

### Client Framework

Uses `EndPointClient` for API calls:

```typescript
const apiClient = new EndPointClient('/api/util/notifications');
const response = await apiClient.id('pending').show();
```

**Follows:** Same pattern as all other client-server communication

---

## Security Considerations

### Authentication

- All notification endpoints require authentication
- Only logged-in users can fetch or dismiss notifications
- User can only dismiss notifications for themselves

### Content Sanitization

**HTML in notification messages:**

- Message content supports HTML for formatting
- **Admin responsibility:** Validate and sanitize content before insertion
- No client-side sanitization (trusted server content)
- XSS prevention relies on careful content review

**Recommendation:** Only allow trusted administrators to create notifications

### Input Validation

**notificationId validation:**

- Type check: must be string
- Length check: 1-100 characters
- Prevents injection attacks via URL parameters

---

## Performance Characteristics

### Caching Strategy

**Pending notifications endpoint:**

- TTL: `flexOpts.baseTtlMs` (typically 15 seconds)
- Client caches response per TTL
- Server includes hash for cache validation

**Dismiss endpoint:**

- TTL: 1ms (effectively no cache)
- Immediate database update
- No caching of dismissal state

### Database Queries

**Fetch pending (per request):**

```javascript
// 1. UserProfile lookup (by _id, indexed)
// 2. SystemNotification query with $nin filter
// 3. Sort by createdAt descending
```

**Expected load:** Low frequency (once per page load per user)

**Optimization opportunity:** Could add notification count to serverInfo middleware to avoid unnecessary API calls when count is 0.

### Client Performance

**localStorage usage:**

- Fast local check before API call
- Prevents unnecessary network requests
- Small footprint (array of strings)

---

## Testing

### Unit Testing

**Controller tests:**

```javascript
describe('notificationController', () => {
    it('should return pending notifications', async () => {
        // Mock helpers
        helpers.fetchPendingNotifications.mockResolvedValue([mockNotification]);

        await notificationController.getPendingNotifications(mockReq, mockRes);

        expect(response.message.notifications).toHaveLength(1);
    });
});
```

**Helper tests:**

```javascript
describe('notificationHelpers', () => {
    it('should fetch only active unexpired notifications', async () => {
        const notifications = await helpers.fetchPendingNotifications(mockUser);
        expect(notifications.every(n => n.active)).toBe(true);
    });
});
```

### Integration Testing

**End-to-end flow:**

1. Insert test notification using `node bin/manageNotifications.js` (menu option `n`)
2. User logs in
3. Navigate to net page
4. Verify modal appears
5. Click dismiss
6. Verify database updated (`db.userprofiles.findOne({...}, {dismissedNotifications:1})`)
7. Use menu option `r` to reset dismissals and verify modal reappears

---

## Future Enhancements

### Potential Features

- **Admin UI** — Web interface for creating/managing notifications
- **Notification templates** — Pre-defined templates for common scenarios
- **User segmentation** — Target notifications to specific user groups
- **Scheduling** — Show notification starting on specific date/time
- **Multiple display modes** — Banner, toast, modal options
- **Email integration** — Send critical notifications via email
- **Notification history** — Allow users to review past notifications
- **A/B testing** — Test different notification messages
- **Analytics** — Track view/dismissal rates

### Database Optimizations

- **Compound index** on `(active, expiresAt)` for faster queries
- **Archival strategy** for old dismissed records
- **Notification analytics collection** for tracking engagement

---

## Troubleshooting

### Notification Doesn't Appear

**Check 1: Is notification active?**

```javascript
db.systemnotifications.findOne({ notificationId: 'your-id' });
// Verify: active: true, expiresAt is null or future
```

**Check 2: Has user already dismissed it?**

```javascript
// In mongosh
db.userprofiles.findOne({ email: 'user@example.com' }, { dismissedNotifications: 1 });
```

Or use menu option `s` (Stats) in `node bin/manageNotifications.js` to see dismissal counts per notification.

**Check 3: Browser console errors**

- Open DevTools (F12) → Console
- Look for errors from `systemNotifications.ts`
- Check Network tab for API response

### Dismissal Not Saving

**Check server logs:**

Look for: `User X dismissed notification: ...`

**Check database:**

```javascript
db.userprofiles.findOne({ email: 'user@example.com' }, { dismissedNotifications: 1 });
```

**Check API response:**

Network tab → POST request should return 200 OK

### Type Validation Failures

**Enable debug logging:**

Set `logErrors: true` in createTypeGuard to see which field fails

**Common issues:**

- ObjectId not converted to string (use `id` virtual property)
- Dates not converted (should be ISO strings in response)
- Missing required fields

---

## File Organization

### Server Files

```
server/dist/
├── models/
│   └── systemNotification.js          # MongoDB schema
├── controllers/
│   └── notificationController.js      # HTTP request handlers
├── lib/
│   └── controllers/
│       └── notificationHelpers.js     # Business logic
├── routes/
│   └── utilRoutes.js                  # Route definitions
└── types/
    └── commonTypesupport.js           # Type guards (compiled from client)
```

### Client Files

```
client/src/public/js/
├── lib/
│   └── systemNotifications.ts         # Notification manager
├── types/
│   ├── commonTypes.ts                 # Type definitions
│   └── commonTypesupport.ts           # Type guards
└── byView/
    ├── liveNet/main.ts                # Integration
    └── favorites/main.ts              # Integration
```

### Management CLI

```
server/dist/
└── bin/
    └── manageNotifications.js         # Interactive TUI for all notification operations
```

---

## Best Practices

### Creating Notifications

1. **Use unique notificationId** — Include date/version (e.g., "feature-x-2026-01")
2. **Keep messages concise** — Users want quick info, not essays
3. **Use appropriate severity** — Reserve 'critical' for urgent issues
4. **Test first** — Insert in dev database before production
5. **Set expiration** — Use `expiresAt` for time-sensitive notifications
6. **Review HTML** — Validate message rendering in modal

### Notification Content

**Good:**

```html
<p>Chat services are temporarily unavailable due to provider issues.</p>
<p>
    <strong>Impact:</strong>
    Net chat is disabled. Other features work normally.
</p>
```

**Avoid:**

```html
<p>
    Hey there! We wanted to reach out and let you know that we've been experiencing some challenges with our third-party
    chat integration partner...
</p>
<!-- Too verbose, buried the key information -->
```

### Severity Guidelines

- **Info** — New features, general announcements, FYI updates
- **Warning** — Service changes, deprecations, non-critical issues
- **Critical** — Outages, security issues, required actions

---

## See Also

- [Controllers](controllers.md) — Controller architecture and patterns
- [Routing and API](routing-api.md) — API organization and patterns
- [Database Models](database-models.md) — Complete schema documentation
- [Client Framework](client-framework.md) — Client-side architecture
- [API Reference](api-reference.md) — Complete endpoint listing

---

(End of system notifications documentation.)
