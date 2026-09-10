# Google-first invitation onboarding

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
