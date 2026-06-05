# Plugin Architecture

This page documents the two primary plugin families in the server runtime and how contributors should add, test, and configure them.

## Summary

- **Plugin base:** `server/dist/lib/pluginBase.js`
    - Provides common construction and access to `options`, `label`, `db`, and a `data.model` map of commonly used Mongoose models (`LiveNet`, `StationInteraction`, `NetProfile`, `UserProfile`, task queues, `QrzCache`).
    - Contract: implement `async run()` and optionally `async cleanUp()`.
    - Constructor signature: `PluginBase({ options, label, db })`.

- **Plugin families:**
    1. Background tasks (scheduled maintenance jobs)
    2. Net admin commands (interactive command plugins)

---

## 1. Background Tasks

**Location (compiled):** `server/dist/lib/backgroundTasks/`

Each task extends `PluginBase` and implements `run()` to perform a unit of work, typically reading task queues or scanning DB state.

**Task classes are exported as `module.exports = ClassName`** so that `tasksLoader` can instantiate them with `new (require('./backgroundTasks/<label>'))({ label, options, db })`.

The `label` passed to the constructor matches the key used in `conf.background_tasks` (YAML) and is used by `tasksLoader` to `require()` the correct file — so the filename, the class name, and the YAML key must all be consistent.

**Existing tasks:**

| File | Class | Purpose |
|---|---|---|
| `closeIdleNets.js` | `CloseIdleNetsTask` | Closes abandoned nets with no active NCS; `options.abandoned_after_hours` |
| `flagAccounts.js` | `FlagAccountsTask` | Flags stale or non-consenting accounts; `options.ttl_days`, `options.account_create_min` |
| `deleteFlaggedAccounts.js` | `DeleteFlaggedAccountsTask` | Hard-deletes accounts previously flagged; reads `PendingAccountDelete` queue |
| `processUnfollowJobs.js` | `ProcessUnfollowJobsTask` | Drains the `PendingUnfollow` queue via `sharedNetOps.unFollow()` |

**Lifecycle:**

1. `dailyProcessingDispatch` middleware detects a new calendar day and `fork()`s `tasksLoader`
2. `tasksLoader` opens a dedicated Mongoose connection (`batch_mongoose_poolsize`)
3. For each enabled task: `new TaskClass({ label, options, db })` → `await t.run()` → `await t.cleanUp()` (in `finally`)
4. `tasksLoader` closes the connection and exits

See [Background Jobs](background-jobs.md) for the full dispatch and loader details.

**Testing:** Unit tests typically mock `data.model.*` methods or use an in-memory MongoDB fixture and call `task.run()` directly.

---

## 2. Net Admin Commands

**Location (compiled):** `server/dist/lib/netAdminCommands/`

Each command extends `NetAdminCmd` (which itself extends `PluginBase`) and overrides `run({ req, res, cmdLine })` to implement command semantics.

### `NetAdminCmd` Base Class

**Constructor:** `NetAdminCmd({ label, commandProperties, db, cs })`

- `label` — plugin label (inherited by `PluginBase`)
- `commandProperties` — **required** object containing all command metadata properties (see below)
- `db` — database connection (default: `mongoose.connection`)
- `cs` — reference to the `CommandSet` command service; used by `shell()` to proxy sub-commands

**Required `commandProperties` keys:**

| Property | Type | Purpose |
|---|---|---|
| `cmd` | string | Primary command name |
| `alias` | string[] | Alternate names for the command |
| `verboseUsage` | string | Long-form usage string shown in help |
| `compactUsage` | string | Short usage string |
| `advanced` | boolean | Whether to show in advanced help listings |
| `mustBeCheckedIn` | boolean | Whether the invoking station must be checked in |
| `level` | number | Minimum role level required (0 = NCS only, 3 = any) |
| `hidden` | boolean | Whether to hide from command listings |
| `minArgs` | number | Minimum number of arguments |
| `maxArgs` | number | Maximum number of arguments |
| `deps` | string[] | Other commands this command depends on |

**`NetAdminCmd.run({ req, res, cmdLine })`**

The base `run()` method (called via `super.run(...)` in subclasses):

1. Attaches `req`, `res`, `npid`, and `parsedArgs` as getters on `this`
2. Validates arg count against `minArgs` / `maxArgs`
3. Looks up the `NetProfile` and `LiveNet` from `req.params.id`; throws `NetNotFoundError` if not found
4. Calls `getStationDetail` to determine the requesting user's role and level
5. Attaches `myLevel` and `myRole` as getters on `this`
6. Enforces `level` and `mustBeCheckedIn` checks before proceeding

**`NetAdminCmd.shell(input)`**

Proxies a command string to the command service:

```javascript
shell(input) {
    return this.cs.run(this.req, this.res, input);
}
```

This allows one command to invoke another (e.g., `handoff` calling `hand` or `checkIn` internally).

**Example commands (compiled):** `hand`, `checkIn`, `checkInH`, `checkInL`, `checkOut`, `checkInOut`, `unCheckIn`, `handoff`, `relay`, `logger`, `nickname`, `owner`, `frequency`, `count`, `close`, `ban`, `unban`, `sys`, `whoAmI`, `help`, and `checkStateApplicator` helpers.

**Command invocation:**

Commands are registered with the `CommandSet` singleton in `interactionController.js` at module load time, using entries from `conf.netadmin_commands` (YAML). Admins invoke commands via the `POST /api/admin/interactions/:id` endpoint.

---

## sharedNetOps

`server/dist/lib/sharedNetOps.js` is the shared domain library used by both plugin families. See [Shared Net Operations](shared-net-ops.md) for full documentation.

## See also

- [Shared Net Operations](shared-net-ops.md) — domain utility used by both plugin families
- [Background Jobs](background-jobs.md) — task dispatch and scheduling details
- [Controllers](controllers.md) — which controllers invoke admin commands and sharedNetOps
