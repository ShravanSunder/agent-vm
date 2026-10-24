---
name: verify-auth
description: "Use when verifying local T3 agent issuance, owner bootstrap, or live-person rejection in agent-vm's sign-in service. Not for standalone MCP bearer configuration or hosted sign-in verification."
---

# Verify auth

Issuer state decides whether an agent gets a proof. Organization admission decides whether its next call runs. For bootstrap, observe issuer, owner, fixed client and Person/session state. For agent, observe both storage owners (issuer and admission) and the real tool effect before calling that journey successful.

This skill covers the local T3 sign-in Worker, its named `AgentClientManagement` binding, the production Gateway path and organization Durable Object. The harness uses actual workerd, D1, Better Auth and Gateway code. Only the external Google protocol and upstream tool are controlled fixtures. A fixture provider identity never establishes a real hosted login.

Local status on 2026-10-24: the documented commands ran on sunclaw against `cf607bf7`; bootstrap was observed and the agent permanent assertions passed 23/23 on the compared target. Raw intermediate D1/DO snapshots and upstream-ledger export remain unretained. The complete forbidden-request body/state/effect oracle remains a named coverage gap under independent review. Hosted observations remain unverified.

## Select and bind the target

Choose `bootstrap` for the fixed public native owner client, code+S256 loopback and owner cookie boundary. Choose `agent` for owner-authorized registration, issuance, organization admission, live-person rejection and removal. Both use `scripts/verify-auth/verify-auth.ts`; `scripts/verify-auth/owner-cli.ts` is the delivered native owner CLI.

MUST load `references/agent-bootstrap.md` and return the selected journey, complete compared target tuple, required observations and remaining prerequisite gaps.

Before counting any observation, compare the declared source revision, executed build/artifact, configuration, client, offered test inventory, host and toolchain with the actual execution. A fixed configuration/client/inventory must come from the frozen fixture source. Missing comparison evidence or a mismatch is a prerequisite failure, even if some tests pass. The reference owns how to obtain and compare those identities.

Start through the selected journey command after its target and execution slot are admitted. Readiness means the real harness has started, applied its migrations and answered public JWKS with a usable key during authorization. A process, discovered test list or an HTTP200 without the expected JWKS is insufficient. Retain readiness failure as a failed run; do not replace it with a synthetic issuer.

## Report observations

Keep the command, exit code, selected pass/fail counts, separately named unselected tests and complete compared target tuple. Bootstrap requires direct issuer/owner/client/session assertions. The agent journey is observed when its permanent assertions pass on the compared target: those assertions read D1/DO and the controlled upstream ledger directly. Report their coverage and the named assertion gaps separately; zero passing selected observations, failed setup and skipped cases never count as observed behavior.

Retain the runner's harness identity/readiness receipts, Vitest JSON, case/phase/runtime logs, install/build logs and runtime SQLite files in owned private storage outside Git. The driver does not export raw intermediate D1/DO row snapshots or the in-memory upstream ledger; record that deferred retention gap. Public reports contain redacted identities and results; never publish tokens, cookies, signing keys, captured codes or resolved private target values. Keep wrong-build patches with their intended assertion failure and restored-green run. Setup failures are not mutant reds.

Every management command must check the live Person/session again. A remembered browser session, CLI login or `--force-auth` does not prove physical presence or intent for the exact command. Stronger human-check modes must report not implemented and fail closed; never substitute remembered login.

## Finish and clean up

The selected journey is observed only when its permanent assertions pass on the compared real target and the evidence the runner actually retains is preserved. Use the reference's authoritative S1 decider map to report missing assertions or wrong-build receipts, including the forbidden-request coverage gap, rather than broadening the passing claim. Hosted accounts, real provider/browser identity and UI, replication, CPU and stronger human intent remain unverified by these local journeys.

Let harness teardown stop its own workerd, HTTP listeners and CLI child. On failure, identify and stop only the processes owned by this run; preserve needed private evidence until its consumers finish. Remove only this run's disposable runtime residue under the repository's cleanup rules. Never stop another agent's processes or delete a shared cache to repair a run.
