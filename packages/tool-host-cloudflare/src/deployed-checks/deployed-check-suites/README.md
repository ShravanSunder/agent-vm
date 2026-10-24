# Deployed Worker checks

These suites exercise verification rows 13 to 16 against the private test
deployment. The Lead owns deployment, Access setup, redeployment and collection
of Cloudflare evidence. Set `TOOL_PORTAL_PRIVATE_DEPLOY_FILE` to the private
mode-0600 JSON file outside every repository. Missing configuration fails the
suite; it never skips.

## Starting or retrying a run

Every suite re-run needs a fresh random `runId` and a fresh `evidenceDirectory`
in the private deploy file. Keep each run's evidence together. Have the Lead
render and redeploy the portal configurations for the new run ID: the configured
workspace names carry that ID as `${runId}:${label}` for Analytics queries. Both copies use portal A’s configured logical origin; B’s transport host deliberately differs, and a Host header never selects the audience.

Helper counters and generated artifacts belong to one run. The row-15 held-call
barrier can fail when `row-15-limits` is repeated under the same run ID because
the previous run already released its calls. Generated artifacts also refuse
overwrite. Preserve that behavior and start a new run instead of resetting
counters or replacing evidence to retry a suite.

Within one run, keep the same run ID and evidence directory across the ordered
steps, including row 13's deliberate redeploy and its replay check. The evidence
steps read the artifacts generated earlier in that run.

## Running the steps

From the repository root, run each named file in the order of the Lead's deploy
handback. For example:

```sh
mise exec node@24.7.0 -- pnpm vitest run --project e2e-deployed \
  packages/tool-host-cloudflare/src/deployed-checks/deployed-check-suites/row-15-limits.deployed.e2e.test.ts
```

The live steps generate replay, overlap and canary artifacts. The later evidence
steps consume those artifacts, the Lead's raw tail logs and the Analytics SQL
result. Keep the files outside repositories with mode 0600. Missing data or data
from another run fails the evidence check. Same-isolate overlap remains
inconclusive unless the logs show it.

## Capturing logs

Start the tail before the live row-15 and row-16 steps. `DEPLOY_OUT` points to the
Lead's rendered configuration directory outside repositories. Omit the sampling
flag to capture all events by default:

```sh
umask 077
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-host-cloudflare exec \
  wrangler tail --config "$DEPLOY_OUT/portal-a.json" --format json \
  | jq --unbuffered -c '.' > "$(jq -er '.logFile' "$TOOL_PORTAL_PRIVATE_DEPLOY_FILE")"
```

Stop the tail after the live steps finish and their output has arrived, then run
the evidence steps. Analytics Engine points use the workspace UUID as index1 and
nine blobs, in order: organization UUID from the verified token, configured
workspace name, agent, mode, server, tool, outcome, failure kind, and `no` for
for-a-person. The three doubles remain duration, request bytes and response bytes.
Each text field is capped at 256 UTF-8 bytes on a character boundary.

Row 16 reads `expected-workspaces.json` beside the file named by `analyticsSqlFile`.
It must be mode 0600, outside repositories, and contain a nonempty JSON array of
closed records `{ organizationId, workspaceId, label }`, with UUIDs for
both IDs and no duplicate workspace IDs. The renderer writes this inventory and
`row-16-analytics-query.sql` beside `analyticsSqlFile`, even when that directory
differs from render output. `analyticsSqlFile` names the JSON response, not the
SQL query. The generated query selects index1, blob1 through blob9, double1
through double3 and sample interval, filtered by the current workspace IDs and
run-labelled names, with JSON output. Concrete SQL and deployment inputs stay
private, outside Git.
Missing or invalid workspace evidence fails; the reader never infers workspace
identity from an organization ID. The reader derives each expected workspace name as `${configuration.runId}:${label}`
from the current run configuration; a stale inventory plus stale SQL cannot supply
an old run name. The renderer uses that same convention for every configured workspace.
Run membership checks the expected workspace, organization, derived current-run
workspace name and test agent. A refused call can
legitimately record an `unknown` server; its shape and byte bounds still apply.
Sampling proves shape and arrival, while exact counts and privacy exclusion use
the local capturing binding and Worker logs.

## Workspace deployment boundary

The private model has three explicit workspaces: two in the first organization,
one in the second, each with its own workspace UUID, upstream credential and
approval key. Organization records contain only sign-in IDs and labels. Legacy
organization-as-workspace data is rejected. Portal A retains the v1 migration
plus v2 rename to WorkspaceAuthority; B and the helper bind A’s WORKSPACES
namespace. The templates never delete a class.

`row-14-workspaces.deployed.e2e.test.ts` is a precursor using a controlled issuer
and secret-gated helper admission as stand-ins for deployed sign-in and owner
management. The helper writes workspace membership with the requested persona.
It does not exercise the production management route. Real-issued deployed row14
remains a separate gate. Row13 records B’s transport origin with the same
A-origin workspace audience and tests the shared approval-use guard before and
after redeployment. Rendering/dry-run/local workerd proof does not show that a
migration ran on populated deployed objects; the Lead checks that at deployment.
