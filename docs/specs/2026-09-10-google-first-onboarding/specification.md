# Google-first entry contract

Basis: [Requirements](requirements.md), U-ONB-01–06. Existing resource permission
contracts remain in [agent/account specification](../2026-09-04-agent-account-and-tool-permissions/specification.md).

## Visible behavior

**R1 / U-ONB-01:** A valid invitation opens our onboarding surface with a primary
Continue with Google action. The flow must not require an email code/password,
Clerk dashboard, generic welcome page, or account-menu navigation. Successful
Google authentication returns to the original authorized app destination.

**R2 / U-ONB-02:** A signed-in invitation-created user lacking a verified Google
connection sees Connect Google to finish setup immediately. The app completes
linking through Google's normal account/consent flow, not by synthesizing a
connection or accepting a browser-supplied verified flag. Canceling leaves setup
incomplete with a retry action on the same app-owned surface.

R1–R3 require the invitation email to match the verified Google login email.
The page explains that choice. Existing email-only users complete Google sign-in
for that same email through Clerk's automatic linking; no different-email
account-management flow is provided. This restriction does not apply to Google
resource accounts later connected for an agent.

**R3 / U-ONB-03:** Invalid, expired, already-consumed or wrong-user invitation
attempts must not create app access. Google sign-in does not override invite-only
admission or the configured owner/editor rules. Partial ticket enrollment is not
a completed Google onboarding result. A returning eligible Google-connected user
does not need to relink. Changed/revoked sessions are revalidated under existing
rules; an outage does not produce access or a redirect loop.

**R4 / U-ONB-04:** Onboarding requests only Google identity scopes. It does not
create a broker resource grant, obtain Gmail/Drive tokens, or change any agent's
policy. Subsequent resource consent is visibly described as a separate action for
the selected agent/account.

**R5 / U-ONB-01,03:** Completion destinations must be app-owned and bounded to the
original continuation. User-supplied return URLs cannot redirect elsewhere.
Invitation and OAuth tokens must not appear in application logs, screenshots,
analytics, public diagnostics or referrers. SDK callback handling and application
resource callbacks remain distinguishable.

**R6 / U-ONB-05:** The primary action, pending state, cancellation and actionable
failure text must be readable on phone and desktop and reachable by keyboard.
Repeated clicks while a provider transition is pending do not start duplicate
flows. If JavaScript is unavailable, explain that login needs it; do not present
a broken button or claim authentication completed. Existing no-JavaScript resource
consent forms remain supported after login.

## Context

**R7 / U-ONB-06:** A person with verified Google sign-in but no configured owner
entry sees “Waiting for access”, their verified sign-in email, and an explanation
that their household administrator must configure access. The page exposes no
agents, accounts, permission forms, or resource grants. A Check access again
action rechecks current authentication and configuration; it does not enroll the
person. Access remains denied (HTTP 403). Invalid sessions and issuer mismatches
do not receive the waiting page. For configured owners, inaccessible transactions
retain the existing rejection. The waiting page reveals no target information.

New member: Google sign-in -> waiting for access -> operator configures access
-> Check access again -> authorized destination. This does not automate the
operator's configuration step.

```text
Operator -- invitation/configuration --> Permissions website <-- entry -- Member
                                             |
                                      login and return
                                             |
                                         Clerk/Google

Separate: Member -- explicit agent resource consent --> Google API authorization
Excluded: machine identities do not sign into Clerk or inherit browser sessions.
```

## Evidence required

V1 (R1,R2,R6): visible new-invitation, returning-user and existing-email-user
journeys with desktop/phone screenshots and keyboard checks. Actual hosted
invitation/Google completion must be observed before calling live onboarding done.

V2 (R3,R5): automated allowed/denied callback and server-admission cases, including
wrong user, uninvited user, expired/used ticket, cancellation, double activation,
outage, stale session and hostile destinations. State inspection proves no app
navigation or resource authorization was created on denied/partial completion.

V3 (R4): request/state observations establish identity-only Google authentication
and unchanged resource grants/policies. Synthetic SDK responses must be labelled;
they do not establish hosted provider behavior.

V4 (R7): automated admission, denial, and retry cases prove no navigation or
resource authorization is created while waiting. Browser evidence proves the
waiting page is readable on desktop and phone; fixture proof is not hosted
invitation proof.

An existing configured owner is still required for access to agent policy pages.
This correction does not auto-promote an invited identity to owner or policy editor.
