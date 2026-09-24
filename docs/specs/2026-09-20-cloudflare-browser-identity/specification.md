# Cloudflare-authenticated permissions website

This specification derives observable obligations from the distinct
[Requirements](requirements.md). Consent is bound to the verified Access issuer
and subject, its initiating browser context and owner.

## Domain entities

| Identity | Entity and same-instance rule | Relationships, invariants and states |
| --- | --- | --- |
| E1 | Human principal: one subject within the configured Access issuer. Email is an attribute, not an ownership key. | One principal may be admitted as one configured owner and/or editor. Authenticated, unadmitted or denied for the requested operation. Removing/recreating a provider user does not inherit ownership by matching email. |
| E2 | Owner/editor admission: one operator-authored membership and its allowed or editable agents. | Refers to E1; grants no resource consent itself. An editor must also own the selected account. Configured or absent. |
| E3 | Browser ceremony: one short-lived authorization attempt and opaque browser binding. | Binds exactly one E1 after admission, one target agent and the relevant application/account. Pending, consuming, completed, cancelled or expired; controller restart, identity change or context expiry requires a fresh ceremony. |
| E4 | Resource authorization: the existing agent/account/application grant with its exact Google subject, scopes and generation. | Created or changed only through the existing broker's owner-confirmed ceremony and containment rules; login cannot create it. Existing active/degraded/reauthorization-required and containment states remain unchanged. |
| E5 | Website origin: the one configured HTTPS origin used for browser links, form Origin checks and Google resource callback registration. | Public standard HTTPS; distinct from the local origin listener and private controller API. A forwarded Host cannot select it. |

## Context and outcomes

```text
Household browser -- Google-authenticated Access request --> Agent VM website
Operator --------- owner/editor configuration ------------> Agent VM website
Agent ------------ existing machine operations -----------> Agent VM broker
Agent VM website -- explicit resource consent ------------> Google

Outside this browser surface: controller administration, Gateway control,
Tool VM execution and raw credential material.
```

P1: outside-tailnet users cannot use the current private browser entry. O1: admitted
users reach the website through Google login without requiring Tailnet membership.
P2: replacing identity could accidentally change resource authority. O2: ownership,
consent and per-call approval remain independent. P3: a proxy introduces another
request boundary. O3: denied, stale or forged browser traffic has no credential or
policy effect, and administration remains private.

## Entry and admission

**R1 / U-ACCESS-01,02 / E1,E5 / V1:** Opening the public website while signed out
uses Cloudflare Access's Google identity provider with Instant Authentication.
No Clerk, email-code, Cloudflare-account or application-password login is part of
this selected flow. Access admission is an explicit operator allowlist, not
unrestricted Google signup. Provider login requests identity scopes only.

**R2 / U-ACCESS-02,03 / E1,E2 / V2:** The website accepts only a cryptographically
valid human Access application assertion for the configured issuer and audience,
with valid time bounds and a nonempty subject. Missing, malformed, forged,
expired, wrong-issuer, wrong-audience, machine/service or unsupported token
evidence fails closed. Display/forwarded identity headers do not establish a
principal. Signing-key unavailability is not a fallback to unverified claims.

**R3 / U-ACCESS-03 / E1,E2,E4 / V2,V3:** Authentication and Access allowlisting do
not create owner/editor membership. An authenticated principal without owner
admission sees Waiting for access and no agent/account information. Configured
owners see only admitted agents and their own accounts. Policy edits additionally
require editor admission for that agent. Submitted identity fields and matching
email addresses cannot transfer ownership.

**R4 / U-ACCESS-04 / E1,E4 / V3,V4:** Login never creates a Google resource grant,
uses login-provider credentials for Gog, or alters tool policy. Resource consent
retains the existing exact scopes, selected agent/account/application, human
confirmation and runtime-containment rules. Existing machine calls and refresh
do not require a human Access login.

## Browser ceremony and failure

**R5 / U-ACCESS-05 / E1,E3,E4 / V3,V4:** Every sensitive browser operation verifies
current Access identity and its match to the bound ceremony, opaque browser
secret, expiry, configuration revision and the existing operation-specific
CSRF/Origin/state/PKCE checks. A different subject or issuer is rejected. Callback
consumption and final confirmation remain single-use; concurrent or replayed
requests cannot commit twice. Cancelled/expired/restarted ceremonies cannot be
revived by successful Access login.

A renewed Access token for the same verified issuer and subject may continue the
open ceremony. A different issuer or subject, failed verification, or expired
local context produces denial or restart. Contexts retain only their existing
ten-minute and five-minute bounds, and expiry is checked again at the serialized
authority commit after any asynchronous wait. A late callback or commit produces
no new authority. Identity mismatch denies the affected browser request with a
sign-in-changed/start-again outcome, without cancelling other pending flows of
the bound principal. Explicit sign-out remains governed by R6.

**R6 / U-ACCESS-05 / E1,E3 / V4:** Sign-out through the website cancels its bounded
local authorization/policy contexts before handing the browser to Access logout.
It does not disconnect resource accounts. The website must not promise immediate
global revocation: Cloudflare documents a propagation delay and cross-application
logout. A request admitted before revocation is not claimed atomically revoked
while an external operation is already in flight.

**R7 / U-ACCESS-05 / E3,E5 / V4:** The Google callback remains protected; a public
callback bypass is not an implementation fallback. Missing/expired browser state
produces an explicit restart outcome without committing a grant. Sensitive POSTs
must not depend on transparent replay after an Access login redirect. Application
code does not forward callback parameters or form bodies into login URLs. Exact
edge behavior under expiry must be qualified before live use; a longer token
lifetime is not proof. Provider tokens, OAuth codes, state and browser secrets
must not be included in application diagnostics or captured proof artifacts.

## Origin, cutover and operation

**R9 / U-ACCESS-02,06,07 / E1,E2,E5 / V2,V5:** The authored OAuth configuration
advances to `schemaVersion: 3`. Browser identity
is `{ kind: "cloudflare-access", issuer, audience }`: a fixed HTTPS Access team
origin and one nonempty application audience. Owners and policy editors use
`subject` instead of `clerkUserId`; their existing agent allowlists retain their
meaning. `browser.network` and Clerk keys/login URLs are removed. The listener
is host-local loopback HTTP on an operator-configured internal port. The public base URL is a canonical HTTPS origin without
credentials, path, query, fragment or a nondefault port; it need not equal the
internal socket address. Unknown/legacy keys fail strict validation.

**R10 / U-ACCESS-08 / E5 / V2,V5:** `browser.publicBaseUrl` is authored by the
operator and is the sole authority for the external website origin. Validation
must not contain a production/beta hostname list or a deployment-specific domain
literal. Any hostname meeting the HTTPS-origin contract is configurable; examples
do not become an allowlist. Validate and normalize once at the configuration
boundary, then pass that same canonical value to browser link creation,
same-origin form checks, Google callback construction/client-registration
validation, and host configuration consumers. No environment-specific source
branch, inferred origin from the bind address, or request `Host`/`Forwarded` header
may override it.

For this Access deployment, the public URL uses standard HTTPS while the local
listener port is configured separately. A path, credentials, query or fragment
is rejected rather than silently discarded. Normalize an optional root trailing
slash and equivalent default-443 spelling to one origin before comparisons.
Production and beta configurations must be independently usable in the same
binary. A form sent with the other deployment's Origin must fail even though that
other hostname would be valid in its own authored configuration.

Canonical docs and generated deployment manuals describe this configuration
contract, with hostnames only as examples. Tests must distinguish malformed
origins from well-formed but differently configured origins; adding another
hardcoded domain to a test fixture is not proof of configurability.

**R11 / U-ACCESS-09 / E5 / V5:** The private Tunnel origin uses loopback HTTP.
The public browser path remains HTTPS through Cloudflare Access and the encrypted
Tunnel. The local hop requires no public-host certificate, SNI/origin-name
matching or host certificate renewal. A remote request cannot reach the loopback
listener, and the Tunnel does not route the controller administration listener.
This choice trusts the host boundary and does not replace Access or origin
isolation.

An invalid/missing authentication assertion yields denial before target disclosure
or provider work (403 for missing or invalid proof); a signing-key
service failure yields 503. A valid but unconfigured human receives the existing
403 Waiting for access page. Restart-required browser contexts provide a safe
local GET entry, never an automatic retry of a previously submitted POST. The
application does not redirect a missing assertion to an arbitrary login URL;
normal human authentication is performed at Access before the origin.

R9 recommends the Access application session duration be at least the longest
ten-minute ceremony bound; Cloudflare's 24-hour default is suitable. Local
ceremony TTLs remain the bound; every request re-verifies the current assertion.

The application must return 403 for missing or invalid Access proof and 503 when
verification is unavailable. The Access application session duration must be at
least the longest ten-minute ceremony bound; 24 hours is the recommended setting.
Runtime does not provision
Cloudflare, change DNS, delete credentials or migrate ownership.

**R8 / U-ACCESS-01,06 / E5 / V5:** Public links and registered Google resource
callbacks use the configured standard HTTPS origin without exposing the internal
listener port as part of the public contract. Only the permissions website
is routed through Access/Tunnel; controller/admin/control-session surfaces are
unreachable through it. Direct remote connections cannot bypass Access to reach
the origin listener.

Configuration has one selected Access identity boundary and explicit owner/editor
subjects. Clerk-specific input and the former direct-Tailnet login mode are
rejected at this cutover; there is no silent dual-path fallback. Operators receive
concise deployment and qualification instructions. Existing incompatible stored
owner identities never gain authority from a new subject or matching email.

## Proof and coverage

| Proof | Observable evidence and limits | Coverage |
| --- | --- | --- |
| V1 | Real browser entry through Access to Google and back; intended users admitted, another user denied; desktop/phone readability. Synthetic redirects do not prove this. | U-ACCESS-01,02; E1,E5; P1/O1; R1 |
| V2 | Actual config parsers and signed-assertion verification with valid/invalid signatures, keys, audience, issuer, temporal/human claims; owner/editor admission and zero data disclosure on denial. An unrelated valid deployment hostname is accepted; malformed origins and unexpected keys are rejected. | U-ACCESS-02,03,07,08; E1,E2,E5; P2/O2,P3/O3; R2,R3,R9,R10 |
| V3 | Real broker/catalog/policy interactions prove unchanged scopes, account/agent isolation, single consumption, containment and machine operation independence. | U-ACCESS-03,04,05; E1–E4; P2/O2; R3,R4,R5 |
| V4 | Browser/provider protocol evidence covers token renewal, global expiry, logout, person switch, native POST, callback query integrity, no replay and sanitized logs, plus same-principal renewal, identity-switch rejection and local context expiry. Local deterministic failures separately prove application denial behavior. | U-ACCESS-04,05,07; E1,E3,E4,E5; P2/O2,P3/O3; R4–R7 |
| V5 | Real listener/routing evidence proves configured origin propagation to links, callbacks, client matching and Origin checks, with separate production/beta configurations, loopback HTTP origin isolation and denied administration reachability. Generated manuals preserve the same contract. Live Access/Tunnel topology is separate from local HTTP proof. | U-ACCESS-01,02,06,07,08,09; E1,E2,E5; P1/O1,P3/O3; R8,R9,R10,R11 |

V1 and the true external portions of V4/V5 require an authorized test deployment.
No current source test or research receipt establishes those observations.
