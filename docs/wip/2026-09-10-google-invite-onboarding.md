# Google-first invitation onboarding

## Current delivery checkpoint

The owner confirmed same invitation/Google verified email. Implementation is on
`fix/google-invite-onboarding`, based on `origin/master` at `21765292`; initial
implementation checkpoint is `2be21e88`. Earlier research notes below are history,
not unresolved product decisions. Canonical implementation plan:
`tmp/plan-workflows/2026-09-10-google-first-onboarding.md`.

- Three-artifact review completed and parent-verified: direct invite continuation
  creation and expected-person binding in the existing store are included.
- Initial full proof: 16/16 quality gates, 4,609 unit tests, 916 integration tests.
- Independent implementation review found one real provider-representation defect:
  Clerk backend preserves `oauth_google`; ClerkJS normalizes it to `google`.
  Live metadata from the sole approved test account confirmed that distinction.
  Corrected fixtures first reproduced failure; corrected eligibility then passed.
- Actual browser proof: built desktop and 390px setup screens loaded the real
  Clerk SDK and showed the immediate Google action. Google sign-in used only the
  approved account and identity scopes; backend metadata confirms its verified
  Google connection and matching verified primary email.
- The localhost callback was blocked by browser protections. This is not proof
  of the private HTTPS return. No browser protections were disabled.
- The first private HTTPS listener attempt was rejected; no workaround was used.
  After the owner explicitly approved that listener, the existing production
  login/session handlers ran behind real TLS and socket-peer Tailscale WhoIs.
  The sole permitted account completed Google identity sign-in, the return route
  returned 303, and the browser reached the actual owner-index renderer using a
  verified bounded navigation context. Screenshots capture entry and landing.
  This was an isolated login proof with no resource broker or agent tools, not
  a complete beta deployment or a fresh invitation test.
- Cancelling Google sign-in returned the app-owned Google entry without access.
  Native change-person revoked the session, but initially returned an error
  before a reload. Redacted live diagnostics proved that the old cookie JWT
  still verified while the live session correctly reported signed-out. The safe
  start route now renders public sign-in in that case; callback/consent denial
  remains unchanged. The new regression test failed 403 versus 200 before the
  correction, then all 17 login integration tests passed.
- Final live sign-out retest could not start: 1Password authorization timed out.
  No listener remains running; the permitted test session was revoked.
- CI run 34473785732 at 67d39f8f completed with the Hermes lane failing:
  8 failed / 6 passed (Gateway boot/health timeouts and a virtio queue-full error).
  Validation and all other E2E lanes passed. No failing Hermes files or VM
  implementation were changed in this branch; their root cause is not claimed.
  No CI retry, timeout change, image change or Gondolin patch was performed.
- Built CLI `manual update` generated 15 manuals in an owned OS-temp directory;
  the output contains the invitation URL and same-email rule.

Still required: final sign-out correction checks/review, fresh-invitation proof,
keyboard proof and passing exact-head CI. The private returning-user callback is
now observed, but the final sign-out correction needs a live retest. The approved account
is already enrolled, so do not delete/recreate it to manufacture a fresh-invite
test. No other live account is authorized. No beta config migration, VM image,
Gondolin change, or resource grant was performed. Screenshots are in the session;
the loopback preview is explicitly not an authenticated application deployment.

## Requested outcome

Invitation → Continue with Google → our app. No email-code detour, generic Clerk
welcome page, or account-menu connection hunt. An existing email-invited user
needs a direct Google connection prompt. Google resource consent for an agent
remains separate from website login. Preserve invite-only admission, fixed return
destinations, verified identity, owner/editor checks and session fencing.

Deliver as a separate PR, unmerged, from freshly fetched origin/master. New branch
`fix/google-invite-onboarding` starts at `217652928c57a51e97dfd45d6dfe306cf9b6cf71`.
The main checkout and previous OAuth worktree have unrelated dirty work and were
not changed. New worktree: agent-vm.fix-google-invite-onboarding.

## Current evidence

- controller/oauth/clerk-login-routes.ts redirects a signed-out bootstrap to
  verifier.signInUrl(); it preserves a bounded cookie-bound continuation.
- clerk-browser-identity-verifier.ts builds a generic hosted sign-in URL with
  redirect_url targeting /oauth/auth/return. No Google-first browser entry exists.
- oauth-approval-ui browser entry currently enhances permission selection only;
  it does not initialize a Clerk frontend sign-in flow.
- The live generic Clerk account portal showed default-redirect after invitation
  enrollment; this was not our application's permissions UI.
- Beta currently lacks active OAuth v2 configuration. This deployment prerequisite
  is separate from the repository UX fix and must not be hidden by a mock.

## First-party API references to inspect before implementation

- https://clerk.com/docs/guides/development/custom-flows/authentication/application-invitations
  Custom invitation redirect receives __clerk_ticket and requires explicit
  invitation handling. Do not assume an invitation is interchangeable with Google
  authentication or log/store its token in public artifacts.
- https://clerk.com/docs/guides/development/custom-flows/authentication/oauth-connections
  Custom OAuth sign-in supports a selected provider and explicit completion and
  callback destinations. Match APIs to the installed/selected SDK version.

## Required proof

New invitation, returning Google user, existing email-only user, cancellation,
expired/used invitation, wrong Google identity, uninvited user, stale session and
hostile redirect. Show desktop/phone screenshots of the real app-owned entry and
continuation; label synthetic provider tests separately from actual hosted login.
No automatic Gmail/Drive permission grants, broad registration, or auth bypass.

Implementation mechanism is not yet selected. Validate SDK support and write the
smallest source-grounded design/plan before adding browser auth code.

## Source check: invitation and Google are separate SDK transitions

Clerk JavaScript upstream `packages/clerk-js/src/core/resources/SignUp.ts`
implements ticket acceptance as create(strategy=ticket); the response can carry
a created session. The research summary's blanket claim that a ticket cannot
create a session is not reliable. Do not use it as an implementation assumption.
Its OAuth redirect method supports continuing an existing incomplete signup;
that is different from an already-created invitation user.

`packages/clerk-js/src/core/resources/User.ts:createExternalAccount` supports
the existing-user Google connection directly and returns the external-account
resource. That avoids requiring the user to navigate Account Portal settings.
Only basic identity scopes belong in this flow; no additional resource scopes.

The application must retain server-side admission checks while a ticket-created
user completes Google linking. A frontend success flag is not an identity proof.
Current `verifySession` checks active session identity but does not inspect linked
provider verification; that boundary needs an explicit test in this correction.

These are upstream main source pointers, not a chosen pinned frontend SDK API.
Select and inspect an exact SDK version before implementation; do not mix legacy
authenticateWithRedirect and newer sso/ticket APIs by guesswork.

## Pinned API findings and simplification question

Clerk JS 6.31.1 tag resolves to `bb049dd8f8e4dc9f2425a09bca12a54ad8421155`.
Its own SignUpStart accepts the ticket first, then supplies
`continueSignUp: true` to Google authentication when signup remains incomplete.
The high-level redirect API PATCHes that signup; it does not read a ticket from
the URL. A combined ticket plus OAuth request is not a documented contract.

Signed-in `User.createExternalAccount` returns the provider redirect URL but does
not navigate. The browser follows it and reloads user state on return. Clerk's
own ConnectedAccountsMenu wraps this action in reverification, which can add
another step for an older session. Copying private reverification UI is not an
acceptable shortcut.

Clerk's official account-linking guide provides a simpler alternative: Google
sign-in automatically links an existing Clerk account when both have the same
verified email. This could remove custom external-account connection handling.
Whether invitation email must equal the Google login email is an owner-controlled
onboarding constraint not established by the existing issuer/user-ID ownership
model. Do not silently select that restriction, or add different-email account
management, before resolving it. Website ownership remains issuer plus user ID.

Source: https://clerk.com/docs/guides/configure/auth-strategies/social-connections/account-linking
and pinned `packages/ui/src/components/UserProfile/ConnectedAccountsMenu.tsx`,
`packages/shared/src/react/hooks/useReverification.ts`, and
`packages/clerk-js/src/core/resources/User.ts`.
