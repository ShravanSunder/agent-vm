# Cloudflare identity at the existing OAuth boundary

This structural design consumes the separate [Requirements](requirements.md) and
[Specification](specification.md). R5 binds the verified issuer and subject to the
local browser context; same-principal token renewal may continue a ceremony.

## Structure

```text
Browser
  -> Cloudflare Access [Google login, allowlist, edge session enforcement]
  -> Cloudflare Tunnel [outbound connector, intended application validation]
  -> loopback OAuth listener [existing controller process; website only]
      -> Access assertion verifier [cryptographic human identity]
      -> existing owner/editor admission [local authority]
      -> existing browser navigation/consent/policy contexts
      -> existing Google broker and encrypted catalog

Controller admin listener [separate loopback listener] <- private administration
Agent machine path -> existing Tool Portal/broker/runtime policy [unchanged]
```

Cloudflare and the local controller host are trusted at this ingress boundary.
The browser's headers, cookies, query and form fields remain untrusted until
their relevant verifier accepts them. The Tunnel must not route to the controller
admin listener. Loopback origin reachability is load-bearing: JWT signature checks
alone do not enforce a revocation that is currently known only at the edge.

The public origin is standard HTTPS. The private origin is loopback HTTP on an
operator-configured internal port. This removes local certificate issuance,
renewal and SNI/origin-name coupling. Loopback binding and Tunnel routing are the
enforcement boundary; Tunnel deployment remains an operator responsibility, not a
controller startup side effect.

## Existing owners and changed calls

Current source baseline is `f1f51c4bf22c9bc8815dcb112dfc4ca5cfb0b7fa`.

### Public-origin ownership

The URL schema validates a configured origin's shape; it does not select the
deployment. Remove both the single-domain pin on `master` and the two-domain
approach in `f2fd0a3b26d196f0378ec035bdde1331652c5360`. The config loader validates
the complete input before normalizing the allowed origin spellings to
`URL.origin`; it must not use normalization to hide a supplied path/query/fragment.

```text
Authored browser.publicBaseUrl
  -> strict HTTPS-origin validation and canonicalization [config contracts]
  -> resolved OAuth configuration [runtime composition]
     -> browser links and exact form-Origin check [website routes]
     -> /oauth/google/callback and matching Web-client redirect [broker setup]
     -> public hostname where needed by origin transport [listener setup]

Internal bind address/port -> local listener only
Incoming Host/Forwarded    -> never public-origin authority
```

The existing propagation through `controller-oauth-runtime.ts` and
`oauth-https-server.ts` is retained, not replaced by another URL registry. Update
the config tests, canonical configuration reference, manual template and built-CLI
manual proof together. Their assertions must prove configuration-derived behavior
using unrelated deployment hostnames and wrong-Origin negative cases. Tests from
`f2fd0a3` that reject the standard public HTTPS URL because it lacks `:18900` must
be replaced with the Access contract, not carried forward unchanged.

Existing `oauth-approval-ui` Clerk browser assets and its
`@clerk/clerk-js` dependency are removed with the Clerk onboarding runtime. The
provider-neutral login-continuation store remains only where it owns bounded
navigation/ceremony state after the Access cutover; its identity type and
identity binding is updated rather than deleted as an unexamined side effect.

| Owner and entry | Current path | Proposed change | Preserved outcome |
| --- | --- | --- | --- |
| Config contracts | `oauth-config.ts` fixes Tailnet HTTPS, :18900 public origin and Clerk owner IDs. | Change to one Access identity configuration, configurable standard HTTPS public origin, loopback HTTP listener and explicit Access subjects. | Strict input validation and owner/editor agent scope. |
| Runtime composition | `controller-oauth-runtime.ts` resolves LocalAPI address, Clerk key and verifier. | Remove browser LocalAPI/Clerk dependencies; construct bounded Access verifier and local listener. | One controller-owned OAuth service, catalog, admission lifecycle and cleanup. |
| HTTP entry | `oauth-https-server.ts` runs socket WhoIs before routes. | Replace network identity middleware with signed Access human request verification on the dedicated local origin. | Security headers, body limits, route isolation and admission closure. |
| Login/navigation | Clerk routes/SDK, safe continuations and live session checks. | Remove Clerk onboarding, invitation/return/callback/prepare-google/signed-out routes and Google-connection repair. Retain `/oauth/agents`, safe GET `/oauth/auth/start`, account/transaction routes and POST `/oauth/auth/change-person`; verified Access entry creates the bounded navigation context or Waiting for access. | No automatic owner enrollment, controlled local destinations and no target disclosure. |
| Browser operation | `oauth-browser-session-routes.ts` obtains bound identity, checks current Clerk cookie and live session. | Match the freshly verified Access principal against the bound browser context; allow same-principal token renewal and restart on identity replacement. | Browser secret, owner, CSRF, expiry and cancellation checks. The provider-neutral login-continuation store remains bounded local ceremony state. |
| Policy mutation | `google-account-policy-editor.ts` rechecks session before effects and uses revision/fence guards. | Replace provider session recheck with request-derived Access evidence revalidation; no hidden identity-only success stub. | Revision conflict, owner/editor constraints, authority commit and runtime containment. |
| Google callback | `oauth-https-server.ts:577` verifies browser identity/cookies then invokes broker. | Current Access identity must pass before exchange; preserve server-owned redirect and transaction state. | State/PKCE, atomic consumption, exact resource account and final confirmation. |
| Machine/runtime | Broker policy checks configured issuer/owner and separately handles refresh/execution. | Rename/provider-neutralize owner admission without adding Access network calls to machine paths. | Existing grants, scope policy, agent isolation and credential custody. |

The generic human principal is deliberately small: issuer plus provider subject,
with verified email as display/admission metadata. It is not an extensible auth
plugin registry. The host adapter owns Cloudflare details; broker and permission
logic own human/account/agent authorization. Persistent grants retain the existing
issuer/user identity shape where its meaning is sufficient; no database migration
or email-based reassignment is needed for this feature.

## Assertion verification

The host verifies `Cf-Access-Jwt-Assertion` against the configured team issuer's
JWKS and one intended application audience. Claims do not select the key URL.
Verification checks RS256, signature, issuer, audience, temporal
validity, application-token type and human subject; service credentials are not
consent authority. Reject malformed/ambiguous input and bound input sizes.

The verifier is the sole owner of network key retrieval, bounded caching and
rotation handling. Use a maintained JWT/JWKS implementation rather than manual
signature parsing. Retrieve only the configured issuer's fixed
`/cdn-cgi/access/certs` endpoint; no token-supplied key URLs or redirects to other
origins. Key retrieval has a five-second timeout, a bounded response, one in-flight
refresh, a thirty-second refresh cooldown and a ten-minute cache lifetime. An
unknown key triggers only the bounded refresh path; a known cached key is usable
only within that lifetime. No unbounded stale-key fallback. The concrete five-second
timeout, thirty-second successful-fetch cooldown, ten-minute cache age and
single-flight refresh are the selected library defaults; failed fetches are not
artificially cooled down. The application-owned 64 KiB response bound prevents
unbounded allocation, while zero clock skew preserves strict time checks. These
are bounded implementation tolerances, not new policy or a custom cache
subsystem. Key/verification failure produces typed denial/unavailability;
it never trusts decoded payloads or falls back to email, forwarded identity,
Tailnet membership or the old Clerk path. Request headers do not choose origin,
callback, owner or target agent. No Cloudflare API credential is needed for public
signing-key verification.

Accept at most 16 KiB of compact assertion and 64 KiB of JWKS response. Require
finite integer `iat`, `nbf` and `exp`, with `nbf <= now < exp`, `iat <= now`, and
consistent claim ordering. No authentication-lifetime extension is granted for
clock skew. Require `type: "app"` and a nonempty bounded subject for the human
flow; email is optional bounded display metadata, not authority; reject service-token shapes. Test clocks and transport
are injectable, but production always uses the configured HTTPS key endpoint.

Tunnel `Protect with Access` adds an application-token check before Node. Agent VM
still verifies the identity it uses, so it does not accidentally treat a tunnel
configuration mistake as an authenticated owner. The origin must remain private
even when an old assertion would still verify cryptographically.

## Ceremony state and exact authentication binding

Existing process-local navigation, transaction, completion and policy contexts
remain the owners of short-lived browser state. The broker retains atomic callback
consumption and exact account/application commit. No new persistent login database,
token refresh service or replicated session store is proposed.

```text
Verified Access request -> owner admission -> bounded browser context
  -> form/callback with current evidence + matching opaque secret
     -> same owner + current context + operation guards -> existing transition
     -> changed owner / bad secret / expired / cancelled -> denial or restart

Local sign-out -> cancel local contexts -> clear cookies -> Access logout
Controller restart -> discard all pending browser contexts
```

Current `OAuthBrowserSessionIdentity` and `sameOAuthBrowserSession` include a Clerk
session ID. Cloudflare's documented `identity_nonce` is an identity lookup cache
key, not an equivalent session ID. It must not be relabeled to satisfy that type.

R5 selects the first realization below. The rejected alternative is retained here
because it explains the intentional restart behavior:

| Choice | Mechanism class | Gain | Cost |
| --- | --- | --- | --- |
| Same principal plus browser context (selected) | Bind to issuer/subject and the existing opaque context; verify current assertion at each request. | Same-person renewal continues without artificial restarts; identity changes still fail closed. | Local context expiry remains the ceremony bound. |

The host verifier returns a provider-neutral authenticated-human value containing
the owner principal from the verified assertion. The verified expiry is checked on
each request, but does not become a second local ceremony deadline. Raw bearer tokens
are not retained in any browser store, catalog, log or URL. The former `sessionId`
field is replaced throughout the ephemeral contracts; it is not relabeled as a
Cloudflare session. Durable owner issuer/user IDs remain unchanged in shape.

Every browser request is verified anew. Routes pass that verified value to broker
or policy calls, whose context match includes issuer and subject.
Their post-await checks compare retained trusted evidence and expiry; they do not
claim to perform a remote session lookup. Remove the identity-only Clerk
`verifySession` callback from the policy editor rather than replace it with a
success stub or introduce a digest-to-token cache.

Context creation and transitions use the existing local deadline and TTL. This applies to navigation, enrollment binding,
sequential application transitions, callback completion, disconnect and policy
contexts; no successor context extends its authentication deadline. An unbound
agent-created transaction retains its existing TTL until the browser binds it,
then tightens its deadline. Already-expired evidence creates no context.

Grant, disconnect and policy mutation closures recheck admission and the captured
browser/context deadline inside `runAuthorityCommit`, immediately before the
synchronous catalog mutation. This closes the observed wait-for-lock gap in
`google-authorization-commit.ts`, `google-authorization-disconnect.ts` and
`google-account-policy-editor.ts`. Existing CAS/revision checks remain in force.
Containment settlement after a committed fence retains its lifecycle authority;
it is not a new browser permission decision. No provider revocation introspection
API or distributed atomic revocation guarantee is assumed.

## Failure and concurrency

| Condition | Detection/owner | Containment and return |
| --- | --- | --- |
| Invalid/missing assertion or unknown signing key | Access verifier | No app navigation, provider exchange or policy effect; bounded error without raw token. |
| Key endpoint unavailable | Verifier | Use only still-valid cached key evidence under its defined cache bound; otherwise fail unavailable. No identity fallback. |
| Access blocks before origin | Cloudflare | Agent VM receives no request; does not report a local commit. Browser recovery is qualified externally. |
| Different current human | Browser context admission | Deny the affected request and ask the browser to start again; never reassign the ceremony or cancel other flows of the bound principal. |
| Expired local context | Existing stores | Restart outcome, no credential/policy effect and no replay. |
| Duplicate callback/confirmation | Existing transaction state | First consumer owns the transition; later consumers fail without duplicate exchange/commit. |
| Sign-out overlaps mutation | Existing cancellation plus publication guards | Cancel pending local contexts; retain current irreversible-effect/containment reporting. Do not claim already-dispatched effects were undone. |
| Config revision changes | Existing config/authority checks | Old contexts fail; no silent ownership transfer. |
| Bad listener/origin configuration | Runtime preparation | Fail OAuth readiness and preserve startup cleanup/port ownership. |

Identity mismatch returns denial from the existing browser identity check. It
does not call principal-wide cancellation or introduce device/session tracking;
existing local contexts retain their original bindings and TTLs.

Sign-out cancels contexts for the bound principal and clears their
cookies before redirecting to the fixed application-origin Access logout path.
No Access API token or local revocation registry is introduced. The edge owns
revocation and its propagation window. Preserve the existing point of no return:
`cancelBrowserCeremonies` cancels pre-commit contexts but deliberately excludes
`committing` and `committing-disconnect`. A claimed final mutation is already in
flight and may finish after logout if its captured deadline and authority still
pass at the CAS. It cannot obtain a fresh deadline by waiting for the lock.
Callback exchange remains cancellable: the existing post-exchange store lookup
prevents a cancelled transaction from creating a completion. No new cancellation
registry or cross-service transaction is needed.

## Callback and proof boundary

Cloudflare already sees the resource callback as TLS ingress. If its global login
expires, it can reauthenticate before the request reaches Agent VM. Published docs
do not establish exact callback-query preservation or native form-body replay.
The design keeps the callback protected and preserves the existing broker checks;
it does not introduce a public bypass or rely on silent POST replay.

Real provider qualification must force application-token-only expiry and global
expiry, different-person return, native POST, logout and revocation. Observe query
integrity, single consumption, user-visible recovery and log surfaces. Cloudflare
`ClientRequestURI` includes query strings; evidence/logging configuration must not
export OAuth codes, state or tokens. Do not claim upstream Google receives these
parameters without evidence.

Local proof uses real signed assertions/JWKS HTTP boundaries, the actual Hono
listener/routes and broker/catalog/policy state. Cloudflare and Google are true
external dependencies: fixtures establish local decisions, not their redirect,
session or revocation behavior. Listener proof separately establishes loopback
binding and the absence of controller routes on the OAuth app.

| Specification | Owning realization | Observation |
| --- | --- | --- |
| R1 | Access Google IdP and Instant Authentication; local safe entry | V1 real browser/provider flow |
| R2 | Strict Access config and bounded signed-assertion verifier | V2 signature/claim/key-rotation and denial behavior |
| R3 | Existing owner/editor/agent guards with Access subjects | V2/V3 cross-owner and cross-agent negative cases |
| R4 | Existing broker and machine authority | V3 resource state unchanged by login |
| R5 | Existing browser stores plus selected assertion continuity | V3/V4 binding, expiry, duplicate and person-switch cases |
| R6 | Existing cancellation before Access logout | V4 local cancellation and edge logout observed separately |
| R7 | Protected callback plus existing state/PKCE/Origin guards | V4 real expiry/redirect/form/log evidence |
| R8 | Loopback website listener and narrow Tunnel route | V5 listener/loopback and external administration denial |
| R9 | Hard config/identity cutover and operator-authored infrastructure | V2/V5 invalid legacy config and deployment instructions |
| R10 | Config-owned canonical public origin passed through existing composition | V2 arbitrary configured host and malformed URL cases; V5 callback/link/Origin/manual propagation and beta/production separation |
| R11 | Loopback HTTP listener and narrow Tunnel route | V5 loopback binding, external denial and no controller route exposure |

See the [research receipt in the shared thread](requirements.md#source-boundaries)
for the evidence location. No live Access/Tunnel qualification is claimed here.
