# Admit someone to the permissions website

1. Configure the zone's schema-version-3 `oauth.config.jsonc` with its canonical
   public HTTPS origin, loopback HTTP listener port, Cloudflare Access team issuer,
   application audience, owner/editor subjects, Google Web clients, and KEK.
2. Configure a Cloudflare Access self-hosted application for that public origin.
   Use Google as the identity provider with Instant Authentication and restrict the
   Access policy to the intended people. Login identity scopes do not grant Google
   resource access.
3. Configure Cloudflare Tunnel to protect the route with Access and forward only to
   the configured loopback HTTP listener. Do not route the controller administration
   listener. The Tunnel owns public HTTPS; Agent VM does not require a public-host
   certificate or expose the internal listener port.
4. Open `<website-origin>/oauth/auth/start`. Access authenticates at the edge and
   Agent VM cryptographically verifies `Cf-Access-Jwt-Assertion` for the configured
   issuer and audience. A valid but unconfigured subject sees **Waiting for access**.
5. Add that verified Access subject to the appropriate owner/editor configuration
   through the normal deployment workflow, then ask the person to check access
   again. Access admission never auto-promotes a person or grants an agent access to
   a Google account.

Signing in is not Google resource consent. After admission, the person separately
chooses the agent, Google resource account, application, and permissions. The
resource account may differ from the Google account used for Access login.

## Verify the deployment

Use an authorized isolated deployment to verify an admitted person and a denied
person through the real Access Google flow. Exercise same-person Access token
renewal, different-person return, application/global expiry, native POST recovery,
logout, callback query preservation, and sanitized Access/Tunnel logs. Confirm that
only the permissions website is reachable and that controller administration is
not routed through the Tunnel.

Then complete a real Google resource-consent journey and separately verify cancel,
wrong account, expired local ceremony, callback replay, confirmation replay, and
account/agent isolation. Local signed-JWT and HTTP integration tests prove Agent VM's
decisions but do not establish Cloudflare redirect, renewal, revocation, or logging
behavior.
