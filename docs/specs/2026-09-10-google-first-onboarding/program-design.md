# One Google-first entry, existing permission boundaries

This realizes [R1–R7](specification.md) without changing agent permissions or
Google resource-token custody. The website owns the short onboarding journey;
Clerk still owns invitations, Google identity connections and login sessions.
The existing controller verifier remains the admission boundary.

## What changes

```text
Browser over existing restricted Tailscale connection
  |
  +-- Our onboarding page                         ADDED
  |     Continue with Google / Connect Google
  |     Owns presentation and one pending browser action
  |     Uses Clerk JS; no resource-token API
  |
  +-- Clerk FAPI <-> Google identity              EXISTING PROVIDERS
  |     Owns invitation acceptance, account linking, session activation
  |
  +-- Existing controller login return            CHANGED ADMISSION
        Verified cookie -> active Clerk session -> verified Google connection
        -> configured owner -> consume bounded continuation -> permission page
              |
              +-- failure: no app navigation; retry/setup message

Separate and unchanged:
  permission page -> explicit agent/account Google consent -> broker credentials
```

The generic hosted sign-in redirect is replaced with an app-owned page. This
costs a small browser SDK adapter and a separate login asset in the existing
`oauth-approval-ui` package. It does not add a frontend framework, persistent
login store, invitation database, provider proxy, or account-management portal.
The controller remains responsible for deciding whether a person may enter.

Hosted Account Portal remains a configured Clerk origin for SDK handshakes, not
the normal family onboarding UI. Merely changing its return URL would remove the
welcome page but would not repair an invitation-created email-only account.
There is no verified supported provider-selector query parameter to rely on.

## Components and their contracts

- **Existing Hono login routes** own fixed entry/callback destinations and the
  existing ten-minute cookie-bound continuation. They serve onboarding from the
  website, never from the controller admin API. They change when the login
  journey changes; they do not interpret provider access tokens.
- **Onboarding renderer in `oauth-approval-ui`** owns the heading, Google action,
  status, retry and no-JavaScript explanation. It consumes only a page state,
  configured publishable key and fingerprinted local asset names. No ticket,
  secret key, account policy or resource credential is embedded in the model.
- **Browser Clerk adapter in the same package** owns user-triggered invitation,
  sign-in operations. It reads SDK state rather
  than maintaining a second user/session record. Its local pending/error state
  has page lifetime. The renderer never treats its success as server admission.
- **Existing `ClerkBrowserIdentityVerifier`** owns trusted issuer/user/session
  validation and the authenticated Backend API lookup of a Google connection.
  Its new connection result distinguishes verified, setup-required, mismatched
  identity and unavailable. Remote response fields are validated at runtime.
- **Existing continuation/navigation stores and owner configuration** retain
  their authority and expiry/consumption rules. Invitations never create owner
  or editor configuration, and browser-provided user IDs never select ownership.

The browser imports the pinned public `@clerk/clerk-js` API. Server SDK types stay
inside the controller identity adapter; broker, machine and permission-policy
contracts do not acquire Clerk types. The separate login bundle avoids loading
Clerk on resource-consent forms or broadening those forms' CSP.

## Entry and return paths

Current source anchors are
`controller/oauth/clerk-login-routes.ts:createClerkLoginRoutes`,
`clerk-browser-identity-verifier.ts:verifyBootstrap`, and
`oauth-browser-session-routes.ts:bindVerifiedContinuation` in `agent-vm`.

```text
Current signed-out path:
  /oauth/auth/start -> verifyBootstrap -> hosted signInUrl redirect     REMOVED
  Clerk return -> verifyBootstrap -> verifySession -> bind -> local page

Proposed signed-out path:
  /oauth/auth/start -> verifyBootstrap -> app-owned Google action       CHANGED
  click -> Clerk signIn.authenticateWithRedirect(oauth_google)          ADDED
  Google -> Clerk -> /oauth/auth/callback -> handleRedirectCallback     ADDED
  -> /oauth/auth/return -> verifyBootstrap -> verifySession             PRESERVED
  -> backend verified Google connection -> configured owner check       ADDED/PRESERVED
  -> existing one-use continuation/navigation -> original local page    PRESERVED

Existing signed-in email-only person:
  start/return -> backend setup-required -> immediate Connect Google    ADDED
  click -> bind expected person -> signOut -> Google sign-in           ADDED
  -> app callback -> server return and the same admission checks        ADDED

Invocation/Google-resource authorization paths are unchanged.
```

Every SDK interaction above is asynchronous. Provider errors return to the
onboarding state; only the controller creates admitted app navigation. The
callback cannot take an arbitrary return URL. Both SDK completion destinations
and callback fallback destinations are fixed app routes; the original agent or
account destination stays only in the server continuation.

An invitation uses an operator-configured redirect to `/oauth/auth/invite`.
That GET establishes the same bounded default `agents` continuation and Secure
HttpOnly binding cookies before rendering, just as the existing start GET does.
An existing valid continuation is reused; capacity exhaustion returns unavailable
and an expired/stale cookie returns restart-required rather than provider work.
Clerk's `__clerk_ticket` is read once and removed from the address bar before
starting SDK work. It stays only in page memory until accepted; refresh before
acceptance requires reopening the invitation. Clicking Continue with Google
accepts the ticket through Clerk, then immediately starts Google authentication:

```text
Invitation action -> signUp.create(strategy=ticket)
  |
  +-- incomplete -> signUp.authenticateWithRedirect(
  |                   strategy=oauth_google, continueSignUp=true)
  |
  +-- complete -> setActive -> bind expected person -> signOut -> Google sign-in
  |
  +-- invalid/expired/used -> actionable invitation error; no app access
```

An already active browser session must not silently accept an invitation for a
different person. It receives an explicit switch/restart action before ticket
acceptance. Session switching uses Clerk sign-out and existing live session
fencing; it never changes the identity attached to an existing app ceremony.

The invitation must use the person's Google login email. Clerk's verified-email
automatic linking associates ordinary Google sign-in with the invitation-created
user. The browser signs out an email-only session before initiating that sign-in;
it never calls `createExternalAccount` or implements Clerk reverification UI.
Ticket-completed sessions are activated only to end them through the public SDK
before Google sign-in; this transient session never binds app navigation.
An explicit invitation opened while already signed in shows a switch action,
which signs out before consuming the ticket. Before either email-only or
completed-ticket sign-out, the browser POSTs `/oauth/auth/prepare-google` with no
identity payload. The controller requires the exact Origin, existing login-binding
cookies, a currently verified Clerk cookie and live session, then binds its
issuer/user ID to that same bounded continuation. Binding is idempotent only for
the same person and never overwrites another one; expired, missing or mismatched
contexts fail before browser sign-out. `consume` rejects a different returned
issuer/user ID, even if it is another configured owner. Session ID is deliberately
not pinned because Google sign-in replaces the session. No new store or
request-body identity authority is introduced. The server requires a verified Google
external account matching the user's verified primary email before completion.
This is an onboarding eligibility check, not an email-based owner lookup.

## State, failure and recovery

For R7, `oauth-browser-session-routes.ts:bindVerifiedContinuation` returns an
explicit result: `bound` with navigation cookies, `waiting-for-access` for a
verified same-issuer person absent from owner configuration, or `denied` for
other failures. This replaces an ambiguous absent-cookie result; it does not
change the admission policy or add storage.

```text
Login return -> live session and Google identity checks       UNCHANGED, async
             -> consume one-use continuation                 UNCHANGED
             -> bindVerifiedContinuation                    CHANGED result
                |-- configured/valid -> navigation cookies   UNCHANGED
                |-- absent owner -> waiting renderer        ADDED, no navigation
                `-- wrong issuer/invalid target -> denial    UNCHANGED

Check access again -> existing /oauth/auth/start -> fresh checks and continuation
```

The pure `waiting-for-access-renderer` receives only the backend-verified email
and local stylesheet name. It emits no script or resource form. Login routes
retain no-store/no-referrer and a self-only stylesheet CSP. Waiting is derived
from owner configuration, not a persistent enrollment state. The operator still
updates configuration through the existing deployment workflow; a retry checks
the configuration loaded by the controller. Expired/replayed continuations and
provider failures retain their existing outcomes.

Real Hono/broker integration proves waiting creates no navigation or resource
authorization, distinguishes other denials, and admits a fresh retry after owner
configuration changes. Renderer/browser preview proves presentation with a
synthetic identity, not actual hosted invitation completion.

```text
page loading -> ready -> pending -> provider redirect -> callback -> server check
                  ^        |                            |             |
                  |        +-- error -------------------+             |
                  +--------------- retry/setup-required ---------------+
                                                                  |
                                                      verified -> app
```

- Duplicate clicks are disabled while an action is pending. Provider state,
  not a browser boolean, decides whether signup is incomplete or complete.
- Cancelled Google connection leaves the person in setup-required state with
  the Google action available. A partially created Clerk user is retained by
  Clerk, not deleted as compensation; the next visit resumes connection.
- Unsupported extra signup/factor requirements produce an explicit setup
  error rather than inventing an email-code screen, suppressing a security
  check, looping callbacks or silently widening enabled authentication methods.
- Invalid/uninvited/wrong Clerk identities cannot bind navigation. A connected
  Google account is not owner identity: issuer plus Clerk user ID still selects
  the configured owner. Email is not promoted into an authorization key.
- A revoked or switched session fails existing live-session checks. Missing or
  malformed provider verification never counts as a verified Google connection.
  Provider lookup timeout returns unavailable, not setup-complete.
- Login continuation expiry, process restart or reuse retains the existing
  restart-required outcome. No database migration or persistent resume token is
  introduced. Concurrent tabs still compete for the same bounded cookie context;
  stale returns fail rather than rebinding another pending destination.

## Privacy and deployment boundary

Only login pages permit the configured Clerk frontend origin required by its
SDK. CSP retains `frame-ancestors 'none'`, fixed asset sources and no blanket
external script allowance. Login/callback responses are `no-store` and
`no-referrer`; invitation/callback URLs and raw provider errors are not logged.
The publishable key is public; the backend key stays resolved by 1Password on
the controller. No localStorage token handling is introduced by our code.

Google is the only enabled sign-in provider; email addresses and invitation
delivery remain enabled. Clerk registration remains restricted. Dashboard
identity-only scope configuration is a deployment prerequisite, not a claim
proved by omitting additional scopes in our browser calls. The browser never
requests Gmail/Drive scopes or calls a social-token retrieval API.

This changes only human entry. Existing invitation links that target Account
Portal need replacement or the operator's new custom redirect; local code
cannot rewrite an email already delivered. Cutover replaces the hosted entry
path, not the underlying Clerk instance/users or existing broker data. Rolling
back code would restore the old entry experience, not undo Clerk enrollment.

## How each obligation is proved

```text
R1 / U-ONB-01 -> invitation browser adapter + fixed callback
  real SDK contract checks; hosted invitation -> Google -> our website
R2 / U-ONB-02 -> setup-required renderer + same-email Google sign-in
  existing-email-user integration; visible immediate action and cancellation
R3 / U-ONB-03 -> Clerk restricted registration + server session/owner checks
  denied/expired/wrong-user/outage fixtures; hosted invitation restrictions
R4 / U-ONB-04 -> isolated browser identity adapter; untouched broker ownership
  identity-only requests; no resource grant or policy mutation
R5 / U-ONB-01,03 -> fixed routes + existing browser-bound continuation
  hostile destination/duplicate return tests; no token reflection or logging
R6 / U-ONB-05 -> renderer, pending state, semantic button/status, responsive CSS
  keyboard and phone/desktop browser screenshots; no-JS explanation
R7 / U-ONB-06 -> explicit admission result + pure waiting renderer
  denied-state and retry integration; desktop/phone waiting-page evidence
```

Controller integration tests use real Hono, SDK verification and continuation
stores with only the remote Clerk boundary substituted. Browser adapter tests
exercise state transitions with explicit remote SDK fixtures. Neither proves
hosted Google completion: that requires the actual configured website, Clerk
instance, invitation and user-controlled Google authentication. No VM image or
Gondolin changes are needed for any onboarding behavior.

Public API references: pinned
[`SignUp` 6.31.1](https://unpkg.com/@clerk/clerk-js@6.31.1/dist/types/core/resources/SignUp.d.ts),
[`User` 6.31.1](https://unpkg.com/@clerk/clerk-js@6.31.1/dist/types/core/resources/User.d.ts),
[`Clerk` callbacks 6.31.1](https://unpkg.com/@clerk/clerk-js@6.31.1/dist/types/core/clerk.d.ts),
[`redirect parameters` 4.31.1](https://unpkg.com/@clerk/shared@4.31.1/dist/types/redirects.d.ts),
and [Clerk application invitations](https://clerk.com/docs/guides/development/custom-flows/authentication/application-invitations).
