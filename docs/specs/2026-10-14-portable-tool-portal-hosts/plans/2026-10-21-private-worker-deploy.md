# Private test deploy of the Tool Portal Worker

> **Status (2026-10-28): superseded; record.** Private test deployments now happen in the [Switchboard remediation plan](../../2026-10-24-tool-portal-remediation/plans/2026-10-28-switchboard-remediation-delivery.html) (A7's and A8's deployed checks) and at the identity plan's joint cuts (JC1, JC2).

The owner approved deploying the Worker if it's private, and asked that no
deploy setting or personal detail reach the public repo (2026-10-21). This plan
covers the deployed half of verification rows 13–16.

> **Superseded in part by the workspace unit (2026-10-24).** The diagram and the
> "two portal copies", "admitting test agents" and "two test organizations"
> bullets below describe the pre-workspace model: shared organization objects,
> `OrganizationAuthorization` and `setAgentAdmission`, with no management route.
> Since the workspace cutover, each workspace has its own Durable Object
> (`WORKSPACES` / `WorkspaceAuthority`, with the v2 `renamed_classes` migration),
> the Worker serves `/workspaces/<uuid>/mcp` and owner management routes, and the
> deployed cycle uses three test workspaces (O1/W1, O1/W2, O2/W3), each with its
> own credential, and the helper's admission route writing membership with
> persona. The workspace-unit plan's slice W5 governs cycle 6 and later. The
> privacy rules, Access setup and steps in this plan still apply.

## What gets deployed

```text
   you (browser)  ──Access login──▶ ┌──────────────────────────────┐
   sunclaw checks ──service token──▶│ tool-portal-test-a  (Worker) │──┐
                                    └──────────────────────────────┘  │ shared organization
                                    ┌──────────────────────────────┐  │ Durable Objects
   sunclaw checks ──service token──▶│ tool-portal-test-b  (Worker) │──┘ (b binds a's class)
                                    └──────────────┬───────────────┘
                                                   │ MCP calls, JWKS fetch
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │ tool-portal-test-helpers     │  controlled MCP server,
                                    │ (Worker)                     │  test issuer public keys,
                                    └──────────────────────────────┘  effect and credential counts
```

- **Two portal copies** (`a` and `b`) run the same build. `b` binds `a`'s
  organization Durable Object class with `script_name`, so both share one
  object per organization. Row 13's one-use check sends the same token to both
  at once.
- **The test-helper Worker** is the existing controlled MCP server and test
  issuer (`test-fixtures/controlled-mcp-issuer.ts`) ported to Workers. It
  serves the issuer's public keys (`/jwks`), the controlled MCP server
  (`/mcp`, which needs a shared test secret) and its counters. It holds only
  test data. The private signing keys stay on sunclaw, where the checks mint
  tokens.
- **Admitting test agents.** The production Worker has no agent-management
  route. That route waits on owner question SD9 (who may add or remove
  agents). Its organization object only offers the narrow
  `setAgentAdmission` method. The test-helper Worker binds `a`'s
  `OrganizationAuthorization` class with `script_name` and calls that method
  through an `/admission` route that needs its own shared secret. Only the
  sunclaw checks use it, to list and remove test agents. No production code
  changes, and no management route reaches the portal.
- The portal copies set the `global_fetch_strictly_public` compatibility flag,
  so they can reach the helper's `workers.dev` address (otherwise error 1042).
- **Two test organizations** with test agents, test credentials and the test
  helper as their only tool server. No real tool credentials.

## Private

- **Cloudflare Access** in front of both portal copies, with a self-hosted
  application whose destination is the Worker. The policy allows the owner and
  one service token. The sunclaw checks send the service token's
  `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers alongside the agent's
  `Authorization: Bearer` token.
- `workers.dev` only, `preview_urls: false`, and no custom domain.
- Even without Access, every portal request needs an agent token signed by a
  key that exists only on sunclaw.

## What stays out of the repo

| Value | Where |
| --- | --- |
| account, `workers.dev` addresses, Worker IDs | private deploy file |
| Access application, policy email, service token ID and secret | private deploy file |
| organization configurations, test secrets, signing keys | private deploy file and Worker secrets |

The private deploy file lives on the owner's machines only, outside every
repository, with mode `0600`. The repo holds only code and placeholder
templates that read that file's path from an environment variable. Before each
commit, a scan for account IDs, emails, `workers.dev` hosts and 32-hex IDs
must come back empty.

## Steps

1. After #246's structure pass is accepted: port the controlled MCP server and
   issuer to a Worker (`tool-host-cloudflare/deployed-checks/`), and add the
   deployed-check runner and the placeholder templates (Sol Implementer).
2. Write the private deploy file, then deploy the helper, then `a` and `b`
   with `workers_dev` on. Step 3 follows straight away, before anyone is told
   the addresses, and nothing runs against `a` or `b` until Access is in front.
3. Put Access in front of `a` and `b` through the `cf` CLI, whose login has
   `access:write`. The Wrangler login has no Access scope, so `cf` does this
   step:
   - `cf zero-trust access service-tokens create` for the checks' token;
   - `cf zero-trust access applications create`, one self-hosted application
     per copy, with a `worker` destination;
   - a policy allowing the owner and that service token.

   The service token's secret goes straight into the private deploy file.
4. Run rows 13–16's deployed cases from sunclaw.
5. Remove everything with `wrangler delete` for all three Workers and delete
   the Access application and service token.

## What this can't prove

Real sign-in (the sign-in service isn't built; the test issuer stands in), and
real outside clients.
