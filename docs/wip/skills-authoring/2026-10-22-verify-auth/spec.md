# verify-auth project skill proposal

Run status: proposed. Revision: s1-local-v1. No skill file has been authored.

## Target and promise

Create one project-owned skill at `.agents/skills/verify-auth/SKILL.md`, with a relative Claude link and `references/agent-bootstrap.md`. There is no owning marketplace plugin and no existing auth verification recipe in the checkout's `.agents`, `.claude`, or `.cursor` homes. Scripts live in `scripts/verify-auth/`; their implementation and permanent host tests live with the auth package.

This reference/technique skill helps an agent verify the sign-in service's owner bootstrap and agent issuance through the actual Gateway, retaining direct storage and tool-effect evidence. Success means a cold reader selects the intended local T3 journey, runs its real target, reports selected pass/fail/unselected counts and limitations, and refuses to call missing prerequisites, zero observations, or a fixture identity an observed hosted login.

Authoring basis: the Lead's S1 driver ownership commission (Router push `01a1661a-d80f-7c42-858f-783e7459393a`), the canonical sign-in plan's C3/C4 and S1 boundary, the paired Verifier's prebuild challenge, and the current permanent scripts/tests. This is user-directed intent, not a reproduced skill defect. Current proof posture is proposed from approved intent; real-target execution and fresh-reader behavior are unobserved.

## Decisions

| ID | Default and reason |
| --- | --- |
| D1 | Local T3 agent and bootstrap only. S1 has no hosted deployment/account grant. Later journeys enter only with their own delivery and proof. |
| D2 | Both model- and user-invocable. Verification callers need a discoverable project capability; portable frontmatter is sufficient. |
| D3 | One authored home plus a relative Claude link. Competing recipes are a conflict and are not replaced implicitly. |
| D4 | Main body owns app identity, readiness, journey selection, proof limits, evidence and cleanup. One reference owns shared agent/bootstrap prerequisites and driving steps; executable mechanics remain in scripts and tests. |
| D5 | `--target-file` is an owned mode0600 file outside all Git checkouts. Its local target declaration binds source revision, execution host and maximum load. It contains no real deployment credentials. |
| D6 | The native owner CLI uses real code+S256 loopback and a short private token cache; every server command still checks live Person/session. Browser session or force-auth is never described as hardware presence or per-command human intent. |
| D7 | A driver report must contain positive selected observations. Missing prerequisites, wrong target and failed runtime setup fail the run. Unselected journeys are reported separately and do not count as observed. |

## Surfaces and main path

Trigger: `name: verify-auth`; description: “Use when verifying agent issuance, owner bootstrap, or live-person rejection in agent-vm's sign-in service. Not for standalone MCP bearer configuration or a hosted account rollout.”

Mental model: issuer state decides whether an agent gets a proof; organization admission decides whether its next call runs. Proof must observe both owners and the upstream effect.

The body first identifies the auth Worker, named management binding, Gateway and organization DO. It requires matching the declared source/host/toolchain/load before execution. Its readiness check is successful local harness startup and public JWKS availability, rather than a process existing or tests being discovered. It indexes `agent` and `bootstrap` and calls `MUST load references/agent-bootstrap.md and return the selected journey, declared target, required observations and remaining prerequisite gaps.`

The reference teaches the two executable C4 invocations, what each drives and reads, expected E9/client-resource/audit/admission/tool-effect results, failure and retry cases, and distinctions between a genuine Better Auth cookie and controlled external Google protocol. The body retains the completion rule: only the selected real journey is observed; hosted accounts/replication/CPU, real browser UI, and stronger human intent remain unverified.

The body requires private raw receipts, wrong-build patches, intended assertion failures, restored-green runs, target revision and count summary; it forbids publishing target values or credentials. It names owned harness shutdown and defers deletion of needed evidence until consumers finish.

## Security decision before skill authoring

Sensitive surfaces: executable commands, local network/process startup, private runtime files and credentials. Entry points are the project verification scripts and native owner CLI. Inputs are the declared target file and command arguments. Effects are an owned local workerd/D1/DO deployment and fixture tool calls; no remote account, production state, installed cache, home-level configuration, real secret or deployment mutation is authorized.

Third-party source is consumed through pinned installed packages; no source/assets are copied into the skill. Decision: allowed for documenting and driving the assigned local fixtures after the actual commands pass. Hosted account execution and stronger human-intent mechanics are deferred. Required proof is the real local journey, explicit negative controls, static link/frontmatter checks, and independent skill review. Public-safe constraints exclude resolved targets, raw tokens, cookies, signing keys and captured codes.

## Proof and review

Before skill authoring: independent spec review must accept this revision; current script help and missing-target failure are only interface checks. Before describing a command as operable: run it on the declared real target. Before handback: independently review implemented files and perform a fresh-reader retrieval/application check if available; otherwise retain that exact behavior-evaluation gap. No RED or improvement claim is invented for a new skill.

The S1 runtime proof still owes the paired prebuild deciders, including the three fixed mutants, exact D1 partial failures, held post-signing races, no-hook and request-isolation guards, and management rejection of E10 and management-audience no-sid tokens. Existing draft host tests cover only part of that inventory and are not passed evidence.

Coordination: branch `auth/s1-agent-issuer`, HEAD `1a8d0e8ab8bd086253ac0d3d013a61763134097a`, with uncommitted S1 code and drivers. No skill version/changelog release is involved; the target delivery is the scoped S1 draft PR. The auth Worker entry remains blocked on the Lead's pending root compiler exclusion grant; this proposal does not authorize that edit. Non-goals are S2+ account management, real deployments, actual credentials, generic security policy, and delivery acceptance.

Review record: not requested/completed yet. Implementation decision: pending independent review.
