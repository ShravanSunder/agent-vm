# People sign-in: Program Design

[Requirements](requirements.md) · [Specification](2026-10-20-people-sign-in.md) · [Tool Portal Program Design](../2026-10-14-portable-tool-portal-hosts/program-design.md)

**One small sign-in Worker per deployment runs Better Auth with D1, and issues each relying service its own short-lived, audience-bound token.** Tool Portal verifies those tokens itself: locally for ordinary calls, and with a live check against the sign-in Worker for an Accept or Deny. The owner manages a private deployment's allowlist through a protected admin surface on the same Worker. Every change is written to an audit table in the same database write.

## What exists today

People are identified only by Cloudflare Access, in front of the agent-vm controller's browser pages. One middleware gates every request: admission must be open, then the Access assertion must verify, or the request ends with 503 or 403 ([oauth-https-server.ts](../../../packages/agent-vm/src/controller/oauth/oauth-https-server.ts#L167)). The verifier is built once with one audience and issuer from controller configuration ([controller-oauth-runtime.ts](../../../packages/agent-vm/src/controller/oauth/controller-oauth-runtime.ts#L243)). The account-policy routes verify again before acting ([oauth-account-policy-routes.ts](../../../packages/agent-vm/src/controller/oauth/oauth-account-policy-routes.ts#L175)). An owner is admitted when the token's issuer equals the configured issuer and its subject is listed in the configured owners for that agent ([google-permission-policy-service.ts](../../../packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts#L145)). Stored account grants carry that owner's issuer and user id.

No sign-in service of our own exists, so the service below has no predecessor. **The controller path stays unchanged** until the owner decides how existing grants move (`SD5`). Nothing here rewrites stored owner bindings.

## The choice

The crux is how a relying service learns, per call, that a person is signed in and still allowed.

| Option | How a service learns who the person is | Fits | Fails |
| --- | --- | --- | --- |
| **A. Resource-bound tokens from Better Auth's OAuth provider, with a live check for privileged decisions (selected)** | each service gets a token whose audience is itself; ordinary calls verify it with published keys, and Accept/Deny also asks the sign-in Worker whether it is still active | `R6`, `R7`, `R9`, `R13` | costs a network call per Accept, and a dependency on the sign-in Worker being up for decisions |
| B. Better Auth's plain JWT plugin only | one global audience for every service | cheaper | `R6`: a token for the console would also open Tool Portal |
| C. A shared session cookie across our services | services read the same cookie on a shared parent domain | no tokens at all | `R6` and cross-origin use: no per-service limit; every service must reach the session store |
| D. Keep Cloudflare Access for people | as today | no new service | the owner reserved Cloudflare for machines (F-65); no passkeys |

Option A costs one extra call to the sign-in Worker for each Accept or Deny, and makes decisions fail closed when that Worker is down. Each relying service pays a little verifier code. What would reopen the choice: if live checks prove too slow or unreliable, cache the live answer per session for seconds, never per token lifetime. That is a change to the `SD3` bound and needs the owner.

## Components

```mermaid
flowchart TB
  CON["Console"]
  TPV["Tool Portal verifier"]
  subgraph W["Sign-in Worker (new)"]
    AL["Allowlist gate"]
    BA["Better Auth core"]
    OP["OAuth provider"]
    AD["Admin surface"]
    AU["Audit writer"]
  end
  DB["D1 database"]
  CON -->|code + PKCE| OP
  CON -->|Bearer token| TPV
  TPV -->|keys, live check| OP
  AL -->|before any session| BA
  BA --> DB
  OP --> DB
  AD -->|change + audit, one batch| DB
  AU --> DB
```

| Component | Owns | Home | Consumers | Changes when |
| --- | --- | --- | --- | --- |
| Better Auth core | Persons, linked logins, passkeys, sessions (E2–E5) | `@agent-collaboration/auth`, a Worker app (new) | people's browsers | a sign-in method or session rule changes |
| OAuth provider | relying services, clients, issued proofs, introspection (E6, E7) | same Worker (Better Auth `oauthProvider` plugin, existing library) | the console; Tool Portal's verifier | the token or audience contract changes |
| Allowlist gate | the private-mode admission decision (E8) | same Worker (new) | Better Auth's identity and session creation | private admission rules change |
| Admin surface | allowlist and relying-service changes, owner-only | same Worker (new) | the owner | who may administer changes (`SD1`) |
| Audit writer | the audit record of every change and sign-in outcome | same Worker (new) | the owner | the record contents change |
| Person-proof verifier | the decision "this proof is a current Person for this service" | `tool-host-node` and `tool-host-cloudflare`, implementing Tool Portal's identity-verifier port (new adapter) | Tool Portal `explain`, `propose`, `decide`, `read` | the proof format or freshness rule changes |

The sign-in Worker is built in agent-vm's workspace under the same rules as the Tool Portal packages. It moves to `agent-fleet-tools` with them (F-58, `SD4`). Each deployment is its own Worker with its own D1: one private, later one public. They share code and nothing else.

## Where each entity lives

| E | Semantic owner | Home | Schema/type home | Shape at each boundary | Disposition | Convention |
| --- | --- | --- | --- | --- | --- | --- |
| `E1` Deployment | sign-in Worker configuration | `@agent-collaboration/auth` (new) | `deploymentConfigSchema` in the Worker's config module (new) | the `iss` claim in every E7; `mode: "private" \| "public"` in configuration only | persisted (Worker configuration) | Zod schema, `z.infer` type (repo convention) |
| `E2` Person | Better Auth core | D1 `user` table (existing library schema) | Better Auth's user model (existing) | `sub` in every E7: the Better Auth user id, with subject type `public` (never pairwise) | persisted | library schema |
| `E3` Linked login | Better Auth core | D1 `account` table (existing library schema) | Better Auth's account model (existing) | not exposed to relying services | persisted | library schema |
| `E4` Passkey | Better Auth passkey plugin | D1 `passkey` table (existing library schema) | the plugin's model (existing) | not exposed; WebAuthn messages between the browser and the Worker only | persisted | library schema |
| `E5` Session | Better Auth core | D1 `session` table (existing library schema) | Better Auth's session model (existing) | the browser session cookie on the sign-in origin only; a session reference inside introspection results | persisted | library schema |
| `E6` Relying service | OAuth provider | D1 OAuth resource and client rows (existing plugin schema) | the plugin's resource and client models (existing) | the `aud` claim; the resource identifier at authorization | persisted | library schema |
| `E7` Person proof | OAuth provider | issued JWT access token, not stored (existing plugin issuance) | `personProofClaimsSchema` in `tool-access/contracts` (new) | `{ iss, sub, aud, exp, iat, scope }`, EdDSA-signed, verifiable through the Worker's JWKS | derived | Zod schema, `z.infer` type |
| `E8` Allowlist entry | Allowlist gate | D1 `allowed_email` table (new) | `allowlistEntrySchema` in the Worker (new) | the admin surface's add, remove and list operations | persisted | Zod schema, `z.infer` type |
| audit record (serves `R12`) | Audit writer | D1 `sign_in_audit` table (new) | `signInAuditRecordSchema` in the Worker (new) | the owner's audit list | persisted, append-only | Zod discriminated union |

```ts
export const personProofClaimsSchema = z.strictObject({
  iss: z.url(),                  // E1: the deployment's issuer
  sub: z.string().min(1),        // E2: the Better Auth user id, never pairwise
  aud: z.string().min(1),        // E6: exactly one relying service's resource identifier
  exp: z.number().int(),
  iat: z.number().int(),
  scope: z.string(),
});
export type PersonProofClaims = z.infer<typeof personProofClaimsSchema>;

export type PersonProofVerification =
  | { kind: "verified"; issuer: string; subject: string; audience: string; expiresAt: number; freshness: "signature" | "live" }
  | { kind: "refused"; reason: "malformed" | "bad-signature" | "wrong-issuer" | "wrong-audience" | "expired" | "inactive" }
  | { kind: "unavailable"; reason: "keys-unreachable" | "introspection-unreachable" };

export const deploymentConfigSchema = z.strictObject({
  issuer: z.url(),                              // E1 identity
  mode: z.enum(["private", "public"]),
  ownerUserId: z.string().min(1).nullable(),    // SD1 default: the only administrator; null until the owner first signs in
});

export const allowlistEntrySchema = z.strictObject({
  email: z.email(),                             // stored lower-cased; compared only with provider-verified emails
  addedBy: z.string().min(1),                   // E2 id of the administrator
  addedAt: z.number().int(),
  removedAt: z.number().int().nullable(),       // null while allowed (E8 state)
});

export const signInAuditRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("allowlist-added"), actorUserId: z.string(), email: z.string(), at: z.number().int() }),
  z.strictObject({ kind: z.literal("allowlist-removed"), actorUserId: z.string(), email: z.string(), revokedSessions: z.number().int(), at: z.number().int() }),
  z.strictObject({ kind: z.literal("relying-service-changed"), actorUserId: z.string(), resource: z.string(), change: z.enum(["registered", "retired"]), at: z.number().int() }),
  z.strictObject({ kind: z.literal("sign-in"), outcome: z.enum(["succeeded", "not-allowed", "failed"]), method: z.enum(["google", "github", "passkey"]), userId: z.string().nullable(), at: z.number().int() }),
]);
```

`personProofClaimsSchema` lives in `tool-access/contracts`, so every relying service verifies one shape. `freshness: "live"` appears only after a live check; Tool Portal's `decide` refuses a `signature`-only result (`R9`).

## How a person signs in and a decision is checked

There is no current path to compare: the sign-in Worker is new.

```mermaid
sequenceDiagram
  participant B as Browser
  participant W as Sign-in Worker
  participant G as Google
  participant C as Console
  participant T as Tool Portal
  B->>W: sign in with Google
  W->>G: OAuth with Google
  G-->>W: verified email, account id
  W->>W: allowlist gate (private), session created
  C->>W: authorize, code and PKCE, resource = Tool Portal
  W-->>C: token, aud = Tool Portal
  C->>T: decide, Bearer token
  T->>W: live check (introspection)
  W-->>T: active, sub
  T->>T: manager check, apply
```

The edges that cross a boundary carry:
- Browser and Worker: the sign-in session cookie on the Worker's origin.
- Console and Worker: an authorization request with S256 PKCE and `resource` set to one relying service.
- Worker to console: an E7 (`personProofClaimsSchema`).
- Console to Tool Portal: `Authorization: Bearer <E7>`.
- Tool Portal and Worker: an introspection request authenticated as Tool Portal's own confidential client, returning `active`, `sub`, `aud`, `exp` and the session reference.

The **intentionally unchanged edge** is the controller's Access-gated browser path ([oauth-https-server.ts](../../../packages/agent-vm/src/controller/oauth/oauth-https-server.ts#L167)). It stays until `SD5`.

## Lifecycles

| Entity | States | Transition and guard | Illegal and how it is handled |
| --- | --- | --- | --- |
| E8 Allowlist entry | allowed → removed | owner adds or removes through the admin surface; the change and its audit record are one D1 batch | a re-add after removal creates a new entry; removal of a missing entry returns `not-found` and writes nothing |
| E2 Person (private) | active → removed | removal of its matching E8 marks it removed and revokes every session in the same batch | a removed Person can't create a session by any method. The allowlist gate runs in Better Auth's `databaseHooks.session.create.before` (v1.7.11, `packages/core/src/types/init-options.ts:1510`), which every stock session creation passes through, including passkey sign-in. It throws a policy error that ends as "not allowed". A passkey attempt still records its challenge and counter before the hook runs. The read is not atomic with a concurrent removal, and the removal's session revocation closes that window. |
| E5 Session | active → signed out \| expired \| revoked | sign-out, expiry, or revocation by removal | a revoked session can't mint new E7s; there is no offline grant to outlive it, since the `offline_access` scope is never granted (`R13`) |
| E7 Person proof | valid → expired | time; it cannot be individually revoked | its signature check still passes until expiry, so `decide` always performs the live check |

## Failure, partial success and races

| Situation | Detected by | What happens | Recovery owner |
| --- | --- | --- | --- |
| Google or GitHub unreachable | Better Auth callback error | sign-in fails with a reason; nothing written | the person retries |
| D1 unavailable | Worker database error | no sessions, proofs or admin changes; admin changes return `unavailable` | the Worker recovers when D1 does |
| Introspection unreachable during `decide` | the verifier's call fails or times out | `unavailable`, and `decide` is refused, never accepted | the console retries; nothing applied |
| Signing key rotated | the key id is unknown to the verifier | the verifier refetches the key set once, then refuses | the Worker's key set |
| Removal races an in-flight Accept | the live check before commit | the Accept is refused if the live check sees the revoked session. A removal landing between the live check and Tool Portal's commit is accepted debt: a window of milliseconds, with Tool Portal's audit naming the decider | owner; revisit if the window matters |
| Admin batch partly fails | a D1 batch error | the whole batch rolls back: no change without its audit record | the owner retries |

## Security and other qualities

```mermaid
flowchart LR
  subgraph untrusted["Untrusted"]
    br["Browser"]
    con["Console (relays tokens)"]
  end
  subgraph signin["Sign-in Worker: issues identity"]
    gate["Allowlist gate"]
    issue["Token issuance (audience-bound)"]
    adm["Admin surface (owner only)"]
  end
  subgraph tp["Tool Portal: decides authority"]
    ver["Person-proof verifier"]
    mgr["Manager check (configuration, F-53)"]
  end
  br --> gate
  con --> issue
  con --> ver
  ver --> mgr
```

- **Only three methods (`R1`):** Better Auth is configured with the Google and GitHub social providers and the passkey plugin. No email-and-password, magic-link or OAuth-proxy plugin is installed. The package is pinned at 1.7.11 or later.
- **Explicit linking (`R8`):** implicit account linking is disabled. A login whose verified email belongs to an existing Person is refused with a "link it from your account" result.
- **Admin protection:** Better Auth's resource and client administration APIs let any signed-in session act when no privilege callbacks are set. So the admin surface sets explicit `resourcePrivileges` and `clientPrivileges` callbacks that allow only the deployment owner's user id (`SD1` default), and exposes only its own owner-checked routes.
- **Privacy:** the Worker stores provider account ids, verified email, display name and passkey public keys. Audit records never contain tokens, cookies, codes or passkey material.
- **Reliability:** relying services fail closed when they can't verify.
- **Cost:** Workers Free remains the target only after measured CPU fits (`SD6`).
- **Accessibility:** the sign-in screens wait for the UI design (F-56).

## How each requirement works and where it is proven

| U | R | E | Owner | Interface | Shape and home | State | Failure | Proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | R1: only Google, GitHub, passkey · C1 | E1–E4 | Better Auth core | Worker sign-in routes | library models; Worker configuration | none: configuration | other paths absent, so they 404 | deployed private Worker: enumerate the sign-in routes |
| U1 | R2: provider first, passkeys after (`SD7`) · C1 | E2–E5 | Better Auth core and passkey plugin | sign-in and passkey registration routes | library models | Person and Session created | a failed passkey assertion creates no session | deployed Worker: sign in with Google, register a passkey, sign back in with it |
| U2 | R3: allowlist gate · C1 | E1–E3, E8 | Allowlist gate | identity validation at create, link and sign-in | `allowlistEntrySchema` (Worker) | none on refusal | "not allowed", nothing written | deployed Worker with test accounts |
| U2 | R4: removal stops sign-in and decisions · C1 | E2, E5, E7, E8 | Allowlist gate and admin surface | admin remove, plus the gate at session creation | `allowlistEntrySchema`, audit record | E8 removed, Person removed, sessions revoked | batch failure rolls back | remove, then attempt passkey sign-in and a Tool Portal Accept |
| U3 | R5: public deployments separate · C2 | E1, E2, E7 | sign-in Worker configuration | separate Worker and D1 | `deploymentConfigSchema` | none | a cross-deployment token is refused | two deployments; cross-present proofs |
| U4 | R6: proof valid for one service · C1 | E1, E2, E6, E7 | OAuth provider; person-proof verifier | authorize with resource; verify `aud` and `iss` | `personProofClaimsSchema` (`tool-access/contracts`) | none: derived | `refused` with wrong-audience or wrong-issuer | console and Tool Portal exchange each other's tokens |
| U4, U6 | R7: proofs stand for people only · C1, C3 | E6, E7 | OAuth provider | client grant types: authorization code only for people | Worker client registration | none | a `client_credentials` token is refused by the verifier | attempt a service-credential token at Tool Portal |
| U1, U4 | R8: explicit linking only · C1 | E2, E3 | Better Auth core | account-linking settings | library models | link created only by explicit action | refusal says how to link | second provider with the same email |
| U2, U4 | R9: live check for privileged decisions · C1 | E2, E5, E7 | person-proof verifier | introspection call in `decide` | `PersonProofVerification` with `freshness: "live"` | none | `unavailable` means refused | revoke a session, then Accept |
| U6 | R10: machines never use sign-in · C3 | E1, E7 | sign-in Worker configuration | no machine clients registered | none: absence | none | none: not applicable | machine and VM access with the Worker offline |
| U5 | R11: owner's Workers and D1, no vendor · the deployment configuration contract | E1 | sign-in Worker configuration | deployment configuration | `deploymentConfigSchema` | none | none: not applicable | inspect the deployment configuration |
| U7 | R12: every change recorded, no secrets · C1 | E6, E8 | Audit writer | admin batches and sign-in hooks | `signInAuditRecordSchema` (Worker) | append-only | no change without its record (one batch) | read the audit table after changes, with planted test secrets |
| U2, U4 | R13: sign-out ends new proofs · C1 | E5, E7 | OAuth provider | no `offline_access` scope; session revocation | library models | Session signed out | none: not applicable | sign out, then request a token |

Coverage: R1–R13 are covered by the rows above. E1–E8 are bound in the entity table. C1–C3 are cited in the rows. V1–V9 go to the Verification Design.

## Open items that change this design

- **`SD1`:** who administers the allowlist. The default is the deployment owner only, through the privilege callbacks.
- **`SD3`:** the token lifetime bound, which sets how long ordinary use survives a removal. The resource's access-token TTL is set from it.
- **`SD5`:** moving existing controller grants to new identities. Until decided, the controller keeps Cloudflare Access.
- **`SD6`:** measured CPU on Workers Free.
- **`SD7`:** passkey-first registration.
