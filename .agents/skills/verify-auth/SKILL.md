---
name: verify-auth
description: "Use when verifying local T3 agent issuance, owner bootstrap, or live-person rejection in agent-vm's sign-in service. Not for standalone MCP bearer configuration or hosted sign-in verification."
---

# Verify auth

Issuer state decides whether an agent gets a proof. Organization admission decides whether its next call runs. Observe both storage owners and the tool effect before calling the journey successful.

This skill covers the local T3 sign-in Worker, its named `AgentClientManagement` binding, the production Gateway path and organization Durable Object. The harness uses actual workerd, D1, Better Auth and Gateway code. Only the external Google protocol and upstream tool are controlled fixtures. A fixture provider identity never establishes a real hosted login.

## Select and bind the target

Choose `bootstrap` for the fixed public native owner client, code+S256 loopback and owner cookie boundary. Choose `agent` for owner-authorized registration, issuance, organization admission, live-person rejection and removal. Both use `scripts/verify-auth/verify-auth.ts`; `scripts/verify-auth/owner-cli.ts` is the delivered native owner CLI.

MUST load `references/agent-bootstrap.md` and return the selected journey, complete compared target tuple, required observations and remaining prerequisite gaps.

Before counting any observation, compare the declared source revision, executed build/artifact, configuration, client, offered test inventory, host, toolchain and load with the actual execution. A fixed configuration/client/inventory must come from the frozen fixture source. Missing comparison evidence or a mismatch is a prerequisite failure, even if some tests pass. The reference owns how to obtain and compare those identities.

Start through the selected journey command after its target and execution slot are admitted. Readiness means the real harness has started, applied its migrations and answered public JWKS with a usable key during authorization. A process, discovered test list or an HTTP200 without the expected JWKS is insufficient. Retain readiness failure as a failed run; do not replace it with a synthetic issuer.

## Report observations

Keep the command, exit code, selected pass/fail counts, separately named unselected tests, complete compared target tuple, direct D1/DO readback and upstream effects. Zero passing selected observations, failed setup and skipped cases never count as observed behavior. A partial diagnostic does not complete a journey.

Store raw receipts and any credentials in owned private runtime/evidence files outside Git. Public reports contain redacted identities and results; never publish tokens, cookies, signing keys, captured codes or resolved private target values. Keep wrong-build patches with their intended assertion failure and restored-green run. Setup failures are not mutant reds.

Every management command must check the live Person/session again. A remembered browser session, CLI login or `--force-auth` does not prove physical presence or intent for the exact command. Stronger human-check modes must report not implemented and fail closed; never substitute remembered login.

## Finish and clean up

The selected journey is observed only when its required assertions pass on the compared real target and its evidence is retained. Report the accepted deciders or wrong-build checks still missing rather than broadening the passing claim. Hosted accounts, real provider/browser identity and UI, replication, CPU and stronger human intent remain unverified by these local journeys.

Let harness teardown stop its own workerd, HTTP listeners and CLI child. On failure, identify and stop only the processes owned by this run; preserve needed private evidence until its consumers finish. Remove only this run's disposable runtime residue under the repository's cleanup rules. Never stop another agent's processes or delete a shared cache to repair a run.
