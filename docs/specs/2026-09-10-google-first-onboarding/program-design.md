# One Google-first entry, existing permission boundaries

This realizes [R1–R6](specification.md) without changing agent permissions or
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
  sign-in and external-account connection operations. It reads SDK state rather
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
  click -> user.createExternalAccount(oauth_google) -> Google           ADDED
  -> app callback -> server return and the same admission checks        ADDED

Invocation/Google-resource authorization paths are unchanged.
```

Every SDK interaction above is asynchronous. Provider errors return to the
onboarding state; only the controller creates admitted app navigation. The
callback cannot take an arbitrary return URL. Both SDK completion destinations
and callback fallback destinations are fixed app routes; the original agent or
account destination stays only in the server continuation.

An invitation uses an operator-configured redirect to `/oauth/auth/invite`.
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
  +-- complete with created session -> setActive -> createExternalAccount
  |
  +-- invalid/expired/used -> actionable invitation error; no app access
```

An already active browser session must not silently accept an invitation for a
different person. It receives an explicit switch/restart action before ticket
acceptance. Session switching uses Clerk sign-out and existing live session
fencing; it never changes the identity attached to an existing app ceremony.

## State, failure and recovery

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
R2 / U-ONB-02 -> setup-required renderer + direct external-account connection
  existing-email-user integration; visible immediate action and cancellation
R3 / U-ONB-03 -> Clerk restricted registration + server session/owner checks
  denied/expired/wrong-user/outage fixtures; hosted invitation restrictions
R4 / U-ONB-04 -> isolated browser identity adapter; untouched broker ownership
  identity-only requests; no resource grant or policy mutation
R5 / U-ONB-01,03 -> fixed routes + existing browser-bound continuation
  hostile destination/duplicate return tests; no token reflection or logging
R6 / U-ONB-05 -> renderer, pending state, semantic button/status, responsive CSS
  keyboard and phone/desktop browser screenshots; no-JS explanation
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
