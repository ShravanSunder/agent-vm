# Invite someone to the permissions website

1. Configure the zone's current `oauth.config.jsonc`, Clerk instance, fixed HTTPS
   website origin, TLS and restricted Tailscale website access. Website login does
   not grant infrastructure administration or any agent's Google API access.
2. In Clerk, keep registration restricted/invite-only and Google enabled with
   identity-only scopes. Keep email addresses and email invitations enabled;
   disable email-code/password/other-provider sign-in. Do not require unrelated
   signup fields or organization tasks for this household flow. Do not disable
   Google's security checks to make a test pass.
3. Invite the person's Google login email. Set the invitation redirect URL to
   `<website-origin>/oauth/auth/invite`. Configure the application's sign-in URL
   as `<website-origin>/oauth/auth/start` and successful return as
   `<website-origin>/oauth/auth/return`. Admit the website origin and callback
   `<website-origin>/oauth/auth/callback` in the instance's redirect configuration.
4. The person opens the invitation, chooses **Continue with Google**, and uses
   that same Google email. An existing email-only account shows **Connect Google
   to finish setup** immediately. Clerk automatically links the verified email;
   there is no account-menu setup step or different-email linking flow.
5. Configure the enrolled Clerk user ID as the appropriate owner/editor under the
   existing OAuth policy. An invitation never auto-promotes a person. A person
   without configured ownership sees **Waiting for access**, not permission
   pages. After applying the configuration through the normal deployment
   workflow, ask them to choose **Check access again**. This does not require
   another invitation and does not grant Google API permissions.

Already-delivered invitations pointing at Clerk Account Portal cannot be changed
by updating application code. Send replacement invitations with the custom URL,
or direct an already-enrolled person to the website's sign-in URL.

Signing in is not Google resource consent. After login, the person separately
chooses the agent, Google account and permitted access. That resource account may
be different from their website login account.

## Verify the deployment

Test a fresh invitation and an existing email-only account on the actual website,
then cancellation, wrong Google account, expired invitation and session switching.
Confirm the final destination is our site, not Clerk's default welcome page.
Inspect that website login requests identity scopes only and creates no broker
resource grant. Verify allowed website access and denied infrastructure access.
Local mocked API tests do not establish these hosted-provider outcomes.

If Google sign-in does not complete, use the same invited email and retry from
the website. Reopen a valid invitation or request a replacement if it expired.
Additional-factor/setup errors require checking Clerk settings, not broadening
owner membership or bypassing the controller's identity checks.
