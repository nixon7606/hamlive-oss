# Email templates (reference)

Reference copies of the HTML email templates used by Ham.Live / netcontrol.live, kept in the
repo so they survive independently of any external mail provider.

## net-close-report.html

The **Net Close Report** sent to net owners + superusers when a net closes
(`server/dist/lib/userNotification.js` → `NetCloseReport`, triggered from
`server/dist/lib/sharedNetOps.js`).

> ⚠️ **Syntax is Handlebars**, not EJS — this is the original **SendGrid dynamic template**
> (currently template id `d-c2c75b3765954b5dbc043576c67493a7`). When bringing email in-house,
> convert `{{var}}` → `<%= var %>`, `{{#each xs}}…{{/each}}` → `<% xs.forEach(x => { %>…<% }) %>`,
> and `{{#if c}}…{{/if}}` → `<% if (c) { %>…<% } %>`, then render it server-side and hand the
> finished HTML to whichever transport (SendGrid / SMTP) is active.

### Template-data contract

The data object passed to the template (`dynamic_template_data`):

| Field | Type | Notes |
|-------|------|-------|
| `subject` | string | `"{title} - Net Close Report"` (email subject, not used in body) |
| `title` | string | Net name |
| `url` | string | Net profile URL (linked from title + "View this net" button) |
| `startedAtString` | string | Formatted start datetime in the net's timezone, e.g. `Sat, Jun 21, 2026, 7:30 AM MDT` |
| `timezoneAbbr` | string | Timezone abbreviation, e.g. `MDT` (column header) |
| `formattedAttendees` | array | One row per attendee (see below) |

Each `formattedAttendees[]` entry:

| Field | Type | Notes |
|-------|------|-------|
| `role` | string | NCS / Logger / Relay etc.; rendered as `[role]` when present |
| `callSign` | string | |
| `displayName` | string | |
| `checkInTime` | string | Formatted in the net's timezone |
| `highlight` | boolean | Row gets a highlighted background when true |

### Attachments

The email also carries two base64 attachments built in code (not part of this template):
a full attendee **CSV** and the **net chat log** (text).
