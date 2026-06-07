# Changelog

All notable changes to this fork are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This fork tracks
divergence from the unmaintained upstream
(`Constant-Digital-Holdings-LLC/hamlive-oss`); for the rationale behind each
change see `PATCHES.md`.

## [Unreleased]

### Changed
- Callsign validation now accepts portable and DX forms (`N0AD/M`, `W1AW/4`,
  `DL/N0AD`); max length raised from 7 to 14. Applied to both `userProfile` and
  `initialRegTracker` models.
- Location on a user profile is now optional; a blank value saves, and the 5 to
  24 character rule applies only when a value is present.
- `displayName` validation widened to allow digits, parentheses, and a broader
  set of names; max length raised from 20 to 40.
- Frequency and net-title validation now return messages that state the
  expected format instead of a generic "did not pass validation".
- Duplicate-callsign error reworded to plainer guidance.
- Net close report, going-live announcement, and magic-link login emails
  rebranded; login subject set to "Sign in to netcontrol.live".
- Stream chat SDK connect timeout raised to 10s.
- Chat-token issuance made non-blocking (background user upsert) while keeping
  channel membership synchronous, removing roughly 10 seconds of login latency.

### Added
- Branding: replaced logo, wordmark, favicon, and icon assets with the
  netcontrol.live set.
- Legal pages (privacy, cookie, terms) populated with operator, jurisdiction,
  contact, and effective date.

### Fixed
- Google sign-in could hang and surface as a Cloudflare 524 when a profile save
  failed; the auth verify callback now resolves instead of waiting forever.
- Net close report email failed silently because it referenced an upstream-owned
  SendGrid template; now points at this account's template.

### Security
- Bumped `fast-xml-parser` to a patched version to clear a transitive
  vulnerability.

### Not done
- Geocoding remains on Azure Maps (inactive without `GEO_KEY`). A swap to
  keyless Nominatim is drafted but not applied.

---

_This fork is operated as a single deployment and is not formally versioned.
Entries are grouped under Unreleased; cut a dated version heading here if you
ever tag a release._
