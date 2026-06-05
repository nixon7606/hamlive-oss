# Notification Management Utility

## Overview

The `manageNotifications.js` utility provides an interactive text-based interface (TUI) for managing system notifications shown to users in the Ham.Live app.

**Location:** `server/dist/bin/manageNotifications.js`

---

## Usage

### Basic Usage

```bash
# Manage dev database
node server/dist/bin/manageNotifications.js

# Manage production database
node server/dist/bin/manageNotifications.js --production
```

### Command-line Flags

```
  -p, --production        Connect to production database (default: development)
  -f, --file <path>       Load notification from a JSON file (non-interactive)
  -y, --yes               Skip confirmation prompts (use with --file for automation)
  --help                  Show help
```

---

## The Main Menu

The TUI clears the screen on each loop and shows the header, followed by the current notification list, and the action menu. Actions are invoked by typing a **single letter** and pressing Enter.

```
Notifications (hamlive-dev) [development]

Chat Service Update [ON] [warning] 45% seen
   announcement-2026-01

Actions
  n New notification    t Toggle on/off    d Delete
  s Stats & reporting   r Reset dismissals  f Load from file
  q Quit

>
```

**Header format:** `Notifications (<dbName>) [dev/PRODUCTION]`

Production databases display `PRODUCTION` in red; development databases display `development` in green.

### Menu Actions

| Key | Action                                      |
| --- | ------------------------------------------- |
| `n` | Create a new notification interactively     |
| `t` | Toggle a notification active/inactive       |
| `d` | Delete a notification permanently           |
| `s` | View per-notification statistics            |
| `r` | Reset (clear) dismissals for testing        |
| `f` | Load a notification from a JSON file        |
| `q` | Quit                                        |

---

## Creating a Notification (`n`)

Prompts in order:

1. **ID** — unique identifier; defaults to `announcement-YYYY-MM`. If the ID already exists you are asked whether to overwrite.
2. **Title** — display title (required).
3. **Message** — multi-line HTML content; enter a **blank line** to finish.
4. **Severity** — single character: `i` (info), `w` (warning, default), `c` (critical). Press Enter to accept the default `w`.
5. **Preview** is shown before final confirmation. Enter `n` to cancel, anything else confirms.

---

## Toggling (`t`) and Deleting (`d`)

Both actions display a numbered list and prompt for a number (or Enter to cancel).

- **Toggle:** immediately activates or deactivates the selected notification. No separate confirmation step.
- **Delete:** asks `Delete "<title>"? (y/N)`. Enter `y` to confirm. Anything else (including Enter) cancels. The document is permanently removed from the database.

---

## Statistics (`s`)

Displays per-notification engagement:

- Active / inactive status
- Number of users who have dismissed (seen) it
- Percentage of total users who have seen it (progress bar)
- Creation date

---

## Resetting Dismissals (`r`)

Removes dismissal records so users will see the notification again. Useful for testing. You may select a specific notification by number, or enter `A` to clear all dismissals across all notifications. Shows affected user count before confirming with `(y/N)`.

---

## Loading from a JSON File (`f` / `--file`)

### Interactive (`f` in the TUI)

Prompts for a file path, parses the JSON, shows a preview, and asks `Proceed? (Y/n)`.

### Non-interactive (`--file` flag)

```bash
# Preview and confirm
node server/dist/bin/manageNotifications.js --production --file ./notifications/my-note.json

# Skip confirmation (CI/CD / deployment scripts)
node server/dist/bin/manageNotifications.js --production --file ./notifications/my-note.json --yes
```

When `--file` is used, the TUI loop is skipped entirely. The script loads the file, optionally prompts for confirmation (unless `--yes`), and exits.

### JSON File Format

```json
{
    "notificationId": "feature-x-2026-02",
    "title": "New feature X is live",
    "message": "<p>Feature X is now available. <strong>Learn more</strong> in settings.</p>",
    "severity": "info",
    "active": true,
    "supersedes": ["feature-x-beta-2026-01"],
    "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

**Required fields:** `notificationId`, `title`, `message`

**Optional fields:**

| Field        | Type             | Default     | Description                                                              |
| ------------ | ---------------- | ----------- | ------------------------------------------------------------------------ |
| `severity`   | `info\|warning\|critical` | `"warning"` | Controls badge color shown to users                        |
| `active`     | boolean          | `true`      | Whether the notification is immediately visible                          |
| `supersedes` | string[]         | `[]`        | List of `notificationId` values to delete when this one is created       |
| `expiresAt`  | ISO 8601 string  | `null`      | If set, notification stops displaying after this date                   |

If a notification with the same `notificationId` already exists it is replaced. Any IDs listed in `supersedes` are deleted before the new document is inserted.

---

## Example Session

```
Notifications (hamlive-dev) [development]

No notifications found.

Actions
  n New notification    t Toggle on/off    d Delete
  s Stats & reporting   r Reset dismissals  f Load from file
  q Quit

> n
Quick Create Notification

ID [announcement-2026-06]:
Title: Chat upgrade complete
Message (HTML ok. Enter a blank line when done):
<p>The chat system has been upgraded. Please refresh your browser.</p>

Severity (i)nfo (w)arning (c)ritical [w]: i

Preview
  ID: announcement-2026-06
  Title: Chat upgrade complete
  Severity: info
  Message: The chat system has been upgraded. Please refresh your brows...

Create? (Y/n):
Created! announcement-2026-06

Press Enter...
```

---

## Common Workflows

### Deploy a notification during a release

```bash
# Prepare the notification JSON
cat > /tmp/new-feature.json <<'EOF'
{
    "notificationId": "new-feature-2026-06",
    "title": "New feature available",
    "message": "<p>Check out the new <strong>X feature</strong> in settings.</p>",
    "severity": "info",
    "active": true
}
EOF

# Deploy to production without interaction
node server/dist/bin/manageNotifications.js --production --file /tmp/new-feature.json --yes
```

### Deactivate a notification without deleting it

1. Run: `node server/dist/bin/manageNotifications.js --production`
2. Press `t` (Toggle)
3. Enter the notification number
4. The notification is deactivated immediately (users stop seeing it)

### Test that a notification displays correctly

1. Press `r` (Reset dismissals) and select the notification
2. Confirm the reset
3. Refresh your browser — the notification appears again

---

## Safety Features

- **Production guard:** `--production` must be passed explicitly to connect to the production database. Running without the flag always targets the development database.
- **Confirmation prompts:** create, delete, and reset operations show a preview and require confirmation.
- **`--yes` scope:** the `--yes` flag only skips the confirmation in `--file` mode. It has no effect on the interactive TUI.

---

## Notification ID Naming

**Recommended format:** `topic-description-YYYY-MM`

**Examples:**

- `chat-upgrade-2026-06`
- `new-feature-x-2026-02`
- `maintenance-window-2026-03`

---

## Severity Guide

**Info** — new features, general announcements, optional reading

**Warning** — service changes, deprecations, non-critical issues

**Critical** — outages, security issues, required actions, data loss risks

---

## Troubleshooting

### "readline was closed"

Occurs in non-interactive environments (piped input). Run directly in a terminal, not via shell pipes.

### "No notifications found"

Database is empty or the wrong database is selected. Verify whether `--production` matches your intent.

### "Invalid JSON"

Check the file encoding (UTF-8, no BOM) and ensure all required fields are present.

---

## See Also

- [System Notifications](system-notifications.md) — Complete architecture documentation
- [Database Models](database-models.md) — SystemNotification schema
- [Runbook](runbook.md) — Operational procedures, including all bin tool invocations

---

(End of notification management utility documentation.)
