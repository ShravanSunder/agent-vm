# Google login through Cloudflare Access

Household members need to use the Agent VM permissions website without joining
the operator's Tailnet or managing another application login. The operator wants
Clerk removed and Google sign-in provided by Cloudflare Access. Agent VM must
continue to control which owner may authorize which agent and resource account.

## Authorized needs

Shravan is the decision owner. The following needs are required, with no ranking
between them. Authority is the September 20 instruction to implement this
replacement strategy, together with the September 19 separation of login,
resource consent, owner/editor policy and private administration.

| Identity | Need and reason | Authority |
| --- | --- | --- |
| U-ACCESS-01 | An admitted household member can open the website outside the Tailnet and sign in directly with Google, avoiding an extra provider chooser or Clerk onboarding. | Authorized |
| U-ACCESS-02 | Cloudflare Access replaces Clerk for website identity and admission. Agent VM must not retain two competing login systems. | Authorized |
| U-ACCESS-03 | Website admission does not confer ownership of another person's Google accounts or authority over unassigned agents. | Authorized; retained account/agent isolation |
| U-ACCESS-04 | Google website login remains separate from explicit Google resource consent and the existing per-call tool approval model. | Authorized; retained consent boundary |
| U-ACCESS-05 | Consent remains bound to its initiating browser, owner, agent and transaction, including CSRF, state, PKCE, bounded lifetime and atomic callback consumption. | Authorized; retained ceremony boundary |
| U-ACCESS-06 | Public browser access must not expose the controller administration API or broaden VM/agent privileges. | Authorized; retained administration boundary |
| U-ACCESS-07 | The replacement needs current implementation, independent review and proof through the relevant real interfaces. Provider behavior that was not observed must remain explicitly unverified. | Authorized implementation and repository proof rules |
| U-ACCESS-08 | Each deployment supplies its own public website origin through configuration; adding a production, beta or other deployment hostname must not require a source change. Public browser addressing is separate from the controller's internal listener. | Authorized September 20 correction: "shouldn't the url be configured and passed in?" and request to address `f2fd0a3`/master flaws in this design |
| U-ACCESS-09 | The private cloudflared-to-controller hop uses loopback HTTP; public HTTPS and Tunnel encryption remain the external boundary, avoiding host certificate renewal and SNI/trust coupling. | Authorized September 20 decision after tradeoff review |

## People and journeys

```text
Household member (U-ACCESS-01,03,04,05)
  open operator-provided website link
    -> Google sign-in through Access
    -> own admitted agent/account page
    -> separately choose Google resource access
    -> confirm the exact account and permissions

Operator (U-ACCESS-02,03,06,07)
  configure Access admission and Agent VM owner/editor authority separately
    -> verify authorized website access and denied administration access
    -> admit household use only after real provider qualification

Agent (U-ACCESS-03,04,06)
  existing machine identity and Tool Portal policy
    -> existing account authorization and per-call approval
    -> no browser token or new infrastructure authority
```

The Google login account and the Google resource account can differ. Access's
Google identity provider with Instant Authentication is the selected login
experience: it skips the Access chooser, not Access enforcement. It does not
require a Cloudflare account for each household member.

## Scope and exclusions

The change may update Agent VM's browser identity, OAuth configuration, Hono
website entry, related contracts, tests and operating documentation. It preserves
the resource broker, encrypted credential custody, per-agent account isolation,
policy evaluation, runtime containment and Google refresh responsibilities.

The selected replacement has a Cloudflare Access/Tunnel browser boundary and a
standard HTTPS public origin. Tailscale remains available for administration.
A direct personal Tailnet identity shortcut is acceptable to the owner as a
separate trust policy, but is not required for this replacement's first delivery.

There is no production grant/identity migration requirement by explicit owner
direction. That does not authorize deleting a catalog or deployment state.
Existing incompatible configuration must be rejected rather than interpreted as
new ownership. No Clerk compatibility login, account-merging feature, new
authentication platform, Worker, Funnel, Gondolin patch or general account
signup system is included.

Repository implementation is authorized. Production deployment, DNS cutover,
Cloudflare/Google account mutations, credential changes, publication and merge
remain separately controlled operations. An isolated provider qualification
environment has not yet been selected or authorized.

## Authentication continuity

U-ACCESS-05 replaces Clerk session binding with the verified Cloudflare Access
issuer and subject plus the existing opaque local browser context. A renewed token
for the same issuer and subject may continue an open ceremony. A different
identity, failed verification, or expired local context requires denial or restart.
Refresh is not treated as a new human identity. An identity change rejects only
the affected browser flow; it must not cancel that person's pending flows on
other devices. Explicit sign-out retains its existing cancellation behavior.

## Source boundaries

The September 20 origin correction covers two inspected sources:
`master` at `f1f51c4bf22c9bc8815dcb112dfc4ca5cfb0b7fa` admits only one named
deployment host, while `f2fd0a3b26d196f0378ec035bdde1331652c5360` on
`fix/oauth-beta-hostname` adds a second host. Both still couple the public URL to
port 18900. The latter also encodes that hostname list and port in tests and
generated manuals. Its useful intent—separate beta and production origins—is
retained; its hardcoded allowlist is not the new configuration model.

Runtime already passes `browser.publicBaseUrl` into callback construction and
Origin validation. Preserve and verify that ownership instead of introducing a
second URL setting or reading the origin from an incoming request.

- Existing [account and permission requirements](../2026-09-04-agent-account-and-tool-permissions/requirements.md)
  retain resource-account, policy and machine-authority meaning. Their Clerk and
  Tailnet-only browser choices are superseded within this feature's scope.
- Existing [Google onboarding requirements](../2026-09-10-google-first-onboarding/requirements.md)
  retain direct Google entry, waiting-for-access, separate resource consent and
  real browser proof. Clerk invitation/linking mechanics are replaced by Access
  admission; no invitation service is reimplemented in Agent VM.
- Research evidence is in Sunclaw work thread
  `01a0bc05-edb7-7f43-9494-0f064748f1d7`, not a source of additional authorization.

See [Specification](specification.md) for observable obligations and
[Program Design](program-design.md) for structural realization.
