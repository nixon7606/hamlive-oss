# Email Abuse Protection

This document describes the email rate-limiting and abuse-protection layers built into Ham.Live. All email paths (magic-link authentication, net announcements, net close reports) are guarded by a layered defense that prevents email-bombing a single recipient through any combination of features.

---

## Defense Layers

### Layer 1: HTTP Rate Limiter — Magic Link Endpoint

**File:** `server/dist/lib/magicLoginLimiter.js` (used by `server/dist/routes/authRoutes.js`)

The `POST /auth/magiclogin` endpoint is protected by `express-rate-limit`:

- **Window:** 15 minutes
- **Max requests:** 20 per IP per window
- **Response:** `429 Too Many Requests` with JSON body `{ "error": "Too many sign-in attempts. Please try again in a few minutes." }`
- **Headers:** Standard `RateLimit-*` headers are set on every response

The limit is deliberately generous: the per-recipient cooldown (Layer 2) is the real anti-abuse control, so this layer only has to stop one IP from hammering the endpoint — while staying loose enough that a club meeting or event on shared/NAT'd Wi-Fi (many operators signing in from one public IP at net start) is never blocked.

**Why per-IP?** The magic link form takes an email address to send to. A per-IP limit is the simplest defense that prevents one attacker from generating many requests while allowing legitimate users with different IPs to sign in. The deeper per-recipient cooldown (Layer 2) catches cases where an attacker cycles through IPs to target the same email.

**Real client IP:** behind the Cloudflare Tunnel every origin connection comes from the local `cloudflared` daemon, so `req.ip` is loopback for all visitors. The limiter keys on the `CF-Connecting-IP` header (normalized for IPv6) so each real visitor gets their own bucket instead of everyone sharing one.

```javascript
const magicLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => ipKeyGenerator(clientIp(req)), // CF-Connecting-IP
    message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' }
});

router.post('/magiclogin', magicLoginLimiter, (req, res, next) => { ... });
```

---

### Layer 2: Per-Recipient Cooldown — Central Email Chokepoint

**File:** `server/dist/lib/emailRateLimiter.js`

**Integrated into:** `server/dist/lib/userNotification.js` — method `EmailBase.sendMailToAddrs()`

This is the most important protection layer. Since **every** email path ultimately calls `EmailBase.sendMailToAddrs()`, the cooldown check is placed at this single chokepoint. No matter which feature triggers the email — magic link, net announcement, or net close report — the same per-recipient cooldown applies.

**How it works:**

1. Before sending, each recipient is checked against an in-memory send record
2. If the recipient has been emailed recently (within the cooldown window), the send is **skipped** with a warning log
3. Only recipients that pass the cooldown check receive the email
4. If **all** recipients are in cooldown, the entire send is silently dropped

**In-memory store:** The cooldown uses a `Map<email, timestamp[]>` in memory. This design is intentional:
- Zero database overhead — no MongoDB round-trips on every email send
- Resets on server restart — a restart naturally clears any stuck cooldowns
- Periodic cleanup evicts stale entries (every 5 minutes, entries older than 2× the cooldown window are pruned)

**Configuration via environment variables:**

| Variable | Default | Description |
|---|---|---|
| `EMAIL_COOLDOWN_MINUTES` | `5` | Minimum minutes between emails to the same recipient |
| `EMAIL_MAX_PER_WINDOW` | `2` | Maximum emails per recipient within the cooldown window (2 so a user who missed the first email can honestly retry once) |

**Example — extending the cooldown to 30 minutes:**

```bash
# In .env:
EMAIL_COOLDOWN_MINUTES=30
EMAIL_MAX_PER_WINDOW=2
```

**Example — allowing 2 emails per 10-minute window:**

```bash
# In .env:
EMAIL_COOLDOWN_MINUTES=10
EMAIL_MAX_PER_WINDOW=2
```

**Log output when cooldown is active:**
```
[emailRateLimiter] Cooldown active for user@example.com — 2/2 sends within the last 5min window. Retry in ~247s.
[emailRateLimiter] Skipping user@example.com — Cooldown active for ...
sendMailToAddrs() — all recipients are in cooldown, no email sent
```

---

## Email Flow Diagram

All email paths converge at the single chokepoint in `EmailBase.sendMailToAddrs()`:

```
POST /auth/magiclogin          Net goes live              Net closes
        │                            │                        │
  [express-rate-limit]         [liveNetController]     [sharedNetOps.js]
  5 req/5min per IP                 │                        │
        │                     NetAnnounceStart         NetCloseReport
        ▼                            │                        │
  sendMagicLink()               sendMailToUPIDs()      sendMailToUPIDs()
        │                            │                        │
        └────────────────────────────┼────────────────────────┘
                                     ▼
                        EmailBase.sendMailToAddrs()
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
               [Per-recipient cooldown]    [cooldown check]
               checkBulk(recipients)       skip blocked
                          │                     │
                          ▼                     ▼
                    Allowed only  →     SendGrid API
                                     (or console log
                                      if email disabled)
```

---

## EmailBase.sendMailToAddrs() — Full Flow

1. **Validate input** — ensures recipients is an array with at least one entry
2. **Deduplicate** — removes duplicate addresses from the list
3. **Validate emails** — uses `validator.isEmail()` to reject malformed addresses. If any are invalid, the entire send fails with an error
4. **Apply cooldown** — calls `emailRateLimiter.checkBulk()` to filter out recipients that were recently emailed. Blocked recipients are logged as warnings
5. **Check if any remain** — if all recipients are blocked, the send is aborted gracefully
6. **Build email data** — constructs the SendGrid payload from the class properties
7. **Send with retry** — attempts up to 3 deliveries via `sgMail.sendMultiple()`, logging success or final failure

---

## Exported API: `emailRateLimiter.js`

```javascript
const { checkAndRecordSend, checkBulk, getCooldownRemaining, clearCooldown } = require('./emailRateLimiter');
```

| Function | Signature | Description |
|---|---|---|
| `checkAndRecordSend` | `(recipient: string) => { allowed: boolean, reason?: string }` | Check and record a single recipient. If allowed, marks the send in the cooldown store. |
| `checkBulk` | `(recipients: string[]) => { allowed: string[], blocked: { recipient, reason }[] }` | Check multiple recipients at once. Records sends for allowed recipients automatically. |
| `getCooldownRemaining` | `(recipient: string) => number` | Returns seconds remaining in cooldown (0 = not in cooldown). |
| `clearCooldown` | `(recipient: string) => void` | Manually clear cooldown for a recipient (admin override). |
| `resetAll` | `() => void` | Clear all cooldown records (useful in tests). |
| `getWindowMs` | `() => number` | Returns the configured cooldown window in milliseconds. |
| `getMaxPerWindow` | `() => number` | Returns the configured max sends per window. |

---

## Testing the Rate Limiter

### Manual test — Magic link endpoint

```bash
# Send 6 rapid requests — the 6th should be blocked
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code} " \
    -X POST http://localhost:3000/auth/magiclogin \
    -H "Content-Type: application/json" \
    -d '{"destination":"test@example.com"}'
  echo ""
done
# Expected output: 200 200 200 200 200 429
```

### Manual test — Per-recipient cooldown

```bash
# Send a magic link — should succeed
curl -X POST http://localhost:3000/auth/magiclogin \
  -H "Content-Type: application/json" \
  -d '{"destination":"cooldown-test@example.com"}'

# Send another immediately — should succeed (HTTP 200) from express-rate-limit
# per-IP perspective, but the per-recipient cooldown will skip sending the
# second email. Check the server logs for:
#   [emailRateLimiter] Cooldown active for cooldown-test@example.com
#   [emailRateLimiter] Skipping cooldown-test@example.com
```

---

## Why Two Layers?

| Layer | What it prevents | Bypass risk |
|---|---|---|
| HTTP rate limiter (express-rate-limit) | Rapid-fire API calls from one IP | Attacker rotates IPs (botnet, VPN) |
| Per-recipient cooldown (emailRateLimiter) | Multiple emails to the same address from ANY path | Attacker waits for cooldown to expire |

The two layers are complementary. The HTTP limiter protects server resources; the per-recipient cooldown is the hard guarantee that no email address receives more than N messages per M minutes, regardless of how many features or IPs are involved.

The per-recipient cooldown also covers **all** email features — not just magic links. If a net admin starts and closes a net repeatedly, followers won't receive duplicate announcements from the cooldown window. Extend the window to 30+ minutes on busy instances.

---

## File Reference

| File | Role |
|---|---|
| `server/dist/lib/emailRateLimiter.js` | Per-recipient cooldown module — in-memory send tracker |
| `server/dist/lib/userNotification.js` | Email sending core — `EmailBase`, `NetAnnounceStart`, `NetCloseReport` |
| `server/dist/routes/authRoutes.js` | Auth routes — magic login with `express-rate-limit` |
| `docs/email-abuse-protection.md` | This document |
| `.env.example` | Reference for `EMAIL_COOLDOWN_MINUTES` and `EMAIL_MAX_PER_WINDOW` |