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
organization names also carry that ID for Analytics queries.

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
the evidence steps. Analytics run membership uses the organization ID, the
run-labelled organization name and the test agent. A refused call can legitimately
record an `unknown` server; that field still has its shape and byte bounds.
