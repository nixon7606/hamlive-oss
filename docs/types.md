# Types & typesupport — current layout and usage

This document describes where TypeScript interfaces and runtime "typesupport" code currently live in the repository and how they are used at runtime. It explains the type system architecture, shared types strategy, and runtime validation patterns.

Current locations (as of this repo state)

- **Server-side types/runtime validators**

    - source: `server/src/types/` (e.g. `server/src/types/commonTypesupport.ts`)
    - compiled output: `server/dist/types/` and `server/dist/lib/*support.js`
    - Files: `commonTypesupport.ts`, `serverTypesupport.ts`, `serverTypes.ts`, `express.d.ts`

- **Client-side types/runtime validators included in the public bundle**

    - source compiled into public JS: `client/src/public/js/types/`
    - built artifacts are served under `client/dist/public/js/types/` in production builds
    - Files: `commonTypes.ts`, `commonTypesupport.ts`, `clientTypes.ts`, `clientTypesupport.ts`

- **Root types directory**: `types/` (currently empty, reserved for future shared types)

- **Model type stubs**: `server/dist/models/*.d.ts` (e.g., `flexOptions.d.ts`, `userProfile.d.ts`) — hand-written TypeScript declaration files that provide types for the compiled Mongoose models. These are **not generated** from the `.js` schemas; they must be kept in sync with the runtime schema manually. See [Database Models](database-models.md) for the authoritative field definitions.

Type system architecture

**Shared Types Strategy**

The repository uses a sophisticated shared types system where common types are defined once and used on both client and server:

- `commonTypes.ts` — Core shared interfaces including `EndPointResponse`, `Station`, `NetInfo`, `Client`, etc.
- `commonTypesupport.ts` — Runtime type guards and validation functions for shared types
- Automatic synchronization via `watch:commonTypesupport` script keeps server and client versions identical

**Client-Specific Types**

- `clientTypes.ts` — Client-only types like `SimpleInteractionMethod` and UI interaction patterns
- `clientTypesupport.ts` — Client-side runtime validation and type guards

**Server-Specific Types**

- `serverTypes.ts` — Server-only types (currently minimal placeholder)
- `serverTypesupport.ts` — Server-side validation logic
- `express.d.ts` — Express.js type augmentations for custom middleware

**Runtime Validation (Typesupport)**

The "typesupport" files provide runtime type validation using TypeScript type guards:

```typescript
// Example from commonTypesupport.ts
export function isEndPointResponse(obj: any): obj is EndPointResponse {
    return (
        obj && typeof obj.endpointVersion === 'string' && typeof obj.now === 'number' && typeof obj.ttlMs === 'number'
    );
}
```

These validators ensure data integrity at runtime and provide safe type narrowing.

Runtime expectations

**Server-side validation**

- Server uses lightweight runtime validators (typesupport) to validate EndPointResponse envelopes and payloads before sending them to clients
- Ensures data integrity and API contract compliance
- Validates incoming request payloads and query parameters

**Client-side validation**

- Client-side code includes guard functions and parsers compiled into the public JS
- Used by tests, browser runtime, and reactive stores for type safety
- EndPointClient classes use typesupport functions to validate server responses

**Key Types Overview**

_Core API Types:_

- `EndPointResponse<T>` — Standard server response envelope with `endpointVersion`, `now`, `ttlMs`, `message`
- `LiveNetDetailsResponse` — Complete net state with stations, counts, and metadata
- `Station` — Individual station data with callsign, role, state, and user info

_Domain Types:_

- `NetInfo` / `NetProfile` — Net configuration and metadata
- `Client` — User session data with callsign, permissions, and preferences
- `InteractionPayload` — User interactions (hand, highlight, sig reports)

_Configuration Types:_

- `ServerInfo` — Runtime configuration injected into client pages
- `FlexOptions` — Runtime feature flags and settings

_Utility Types:_

- `NPID` — Net Profile ID (ObjectId)
- `StringAble` — Objects that can be converted to strings
- `NodeEnv` — Environment type ('development' | 'production' | null)

Tooling notes (observed)

**IMPORTANT: Always edit the client copy — never the server copy**

The `watch:commonTypesupport` npm script (running as part of `npm run dev`) uses `chokidar` to automatically copy `client/src/public/js/types/commonTypesupport.ts` into `server/src/types/commonTypesupport.ts`. **Edits made directly to the server copy will be silently overwritten.** Always make changes in the client source tree.

**Development Workflow**

- The repo contains a `watch:commonTypesupport` npm script which uses `chokidar` to copy `client/src/public/js/types/commonTypesupport.ts` into `server/src/types/commonTypesupport.ts` during development
- This script runs automatically during `npm run dev` to maintain synchronization
- **Always edit the client version** — the server copy is automatically generated

**Build Process**

- TypeScript builds and compilation targets are controlled by the various `tsconfig.json` files in the `client/` and `server/` subprojects
- Client types are compiled to ES modules for browser consumption
- Server types are compiled to CommonJS for Node.js runtime
- Generated `.d.ts` files provide type definitions for compiled JavaScript

**Import Strategy**

- Uses path mapping aliases (e.g., `#@client/types/commonTypes.js`) for clean imports
- Client-side imports use `.js` extensions for ES module compatibility
- Server-side imports use standard CommonJS patterns

**Testing Integration**

- Type guards from typesupport files are used extensively in MSW handlers
- Tests rely on these validators to ensure mock data matches runtime expectations
- Provides compile-time and runtime type safety for test fixtures

Best practices

**When adding new types:**

1. Add shared types to `client/src/public/js/types/commonTypes.ts`
2. Add runtime validators to `client/src/public/js/types/commonTypesupport.ts`
3. Let the watch script sync to server automatically
4. Add client-specific types to `clientTypes.ts` if needed
5. Update relevant typesupport files with validators

**Type guard patterns:**

```typescript
// Preferred pattern for type guards
export function isMyType(obj: any): obj is MyType {
    return (
        obj &&
        typeof obj.requiredField === 'string' &&
        (obj.optionalField === undefined || typeof obj.optionalField === 'number')
    );
}

// Usage in code
if (isMyType(data)) {
    // TypeScript now knows data is MyType
    console.log(data.requiredField); // Safe access
}
```

**Import conventions:**

- Use path aliases: `import { MyType } from '#@client/types/commonTypes.js'`
- Include `.js` extension for client-side ES module imports
- Import type guards from typesupport files for runtime validation

Architecture considerations

**Current approach benefits:**

- Single source of truth for shared types
- Runtime type safety through validators
- Clear separation of client/server/shared concerns
- Automatic synchronization prevents drift

**Trade-offs:**

- File copying adds complexity to build process
- Duplication in server source tree (though automated)
- Path alias configuration required for clean imports

**Future considerations:**

- The empty `types/` directory suggests possible future consolidation
- Could migrate to a monorepo shared package approach
- Current approach works well for the application's scale

## See also

- [Client Framework](client-framework.md) — how the client uses types at runtime
- [Developer Setup](developer-setup.md) — watch script that syncs common types
- [API Reference](api-reference.md) — EndPointResponse and payload type specifications
- [Database Schema](database-schema.md) — Mongoose schema field definitions
- [Database Models](database-models.md) — authoritative field-level model documentation
