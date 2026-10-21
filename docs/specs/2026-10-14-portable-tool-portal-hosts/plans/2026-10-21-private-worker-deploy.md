# Private test deploy of the Tool Portal Worker

The owner approved deploying the Worker if it's private, and asked that no
deploy setting or personal detail reach the public repo (2026-10-21). This plan
covers the deployed half of verification rows 13–16.

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
2. Write the private deploy file, deploy the helper, then `a` and `b`.
3. Put Access in front of `a` and `b`. **Needs the owner:** the Wrangler login
   has no Access permission. Either the owner turns on "Protect this Worker
   behind Access" (All traffic) for both Workers in the dashboard and creates
   one service token, or the owner gives a token scoped to Access apps and
   policies for this account. Until then, nothing is deployed.
4. Run rows 13–16's deployed cases from sunclaw.
5. Remove everything with `wrangler delete` for all three Workers and delete
   the Access application and service token.

## What this can't prove

Real sign-in (the sign-in service isn't built; the test issuer stands in), and
real outside clients.
