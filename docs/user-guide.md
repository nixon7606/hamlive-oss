# User Guide

The user guide is **part of the app**. The complete, canonical version is served in-app at
**`/views/guide`** — the **Guide** link in the top navigation — so it's what users actually see.

To keep a single source of truth, the guide content lives in one place:
[`server/dist/views/guide.ejs`](../server/dist/views/guide.ejs). Edit that file to change the guide;
this page is only an index so the guide is discoverable from the repo.

> Content adapted from the original Ham.Live community support knowledge base, generalized for
> self-hosted instances.

## What the guide covers

1. **Getting started** — signing in (magic-link email / optional Google) and setting up your account
2. **Finding & following nets** — the home page list and the follow star for email alerts
3. **Taking part in a net** — station list, raising your hand, signal reports, autoscroll, chat
4. **Running a net (Net Control)** — the control panel, quick mouse actions, Auto-Check-In & lurkers, closing & the report, co-owners
5. **Creating a net** — the net-submission form fields and going live
6. **Your account & privacy** — display name/callsign/location, email & chat toggles, profile picture, changing your email, deleting your account
7. **Reports & RepTool** — the per-net CSV report and merging reports with [RepTool](https://github.com/Constant-Digital-Holdings-LLC/reptool)
8. **Net-control commands** — links to the full reference

For the full net-control command list (typed commands + printable cheat sheet), see the
[Net Admin Commands Reference](net-admin-commands-reference.md).
