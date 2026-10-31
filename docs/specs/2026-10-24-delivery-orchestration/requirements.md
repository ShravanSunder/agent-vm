# Delivery orchestration: Requirements

The order in which the Switchboard fixes, the sign-in work and the agent identity work are built across two repositories, agent-vm and codex-router: what each side builds, where one waits for the other, which proofs must pass across both, and who owns each gate.

This design set has four documents:

- **Requirements:** this file.
- **[Specification](specification.md)**
- **[Program Design](program-design.html)**
- **[Verification Design](verification-design.md)**

[index.md](index.md) leads agents through them; [index.html](index.html) is the page for people.

It orders work that three other designs define. It adds no identity, permission or storage meaning of its own:

- [Switchboard remediation](../2026-10-24-tool-portal-remediation/requirements.md): the Switchboard fixes;
- [agent identity](../2026-10-24-agent-identity/requirements.md): who acts, their tokens and removal;
- [people sign-in](../2026-10-20-people-sign-in/requirements.md): people's sign-in and the sign-in service.

## What went wrong without one

On 2026-10-24 the identity build started from four design documents and a single-repository plan, with no orchestration design. Its evidence, recorded in the handoff (`docs/wip/2026-10-24-identity-followups/handoff.md`), shows what that cost:

- **A token contract change broke live calls.** It broke issuer-to-Switchboard calls until the issuer caught up.
- **A slice needed two later slices.** That forced a batch rewrite of the plan.
- **Deleting a Switchboard route broke sign-in fixtures** that used it.
- **The plan grew eight amendments.**
- **A cross-repository fixture exchange was agreed between agents,** not with the owner.

The owner stopped all work.

## Who is affected

| Class | Why this matters to them |
|---|---|
| **Owner** | Approves the order, each cross-repository contract, and every gate. Wants problems brought fast. |
| **Switchboard Lead** (agent-vm) | Builds the Switchboard fixes and the sign-in work; owns agent-vm's proofs. |
| **Fleet Lead** (codex-router) | Ships the Fleet release, then builds Fleet central's identity work; owns codex-router's proofs. |
| **Agents and people using the fleet** | A step that ships half a contract breaks their calls. |

## Needs

| ID | Need | Why it matters | Evidence | Authority |
|---|---|---|---|---|
| U1 | All coding, the fixes included, follows a complete orchestration design that the owner approves before any build starts. | Building before the design was complete is what went wrong. | "all codign msut be done with full orchestraiotn dsign inclduign the fixes"; owner rule 7 in the handoff, "An orchestration design comes before any build that spans repos". | authorized, 2026-10-24 |
| U2 | The design covers both repositories: the order of work, where each repository waits on the other, the end-to-end proofs, and who owns each gate. It is readable by a person as a page. | The owner asked for exactly these parts. | The owner's ask at the start of the identity work for "a full orchestrator design" with the Fleet side; handoff next step 2: "the orchestration design (both repos, order, dependency points, end-to-end proofs, gate owners) as a human-readable HTML page"; "for all orchestraiton design docs" (presentation-html). | authorized, 2026-10-24 |
| U3 | The Fleet release ships before any codex-router identity work. | The owner set that order. | "i didnt … you need to release first"; "yo trhe oteh ragkent gonan release fleet first" (relayed by the Fleet Lead, 2026-10-24). | authorized (relayed) |
| U4 | No step ships one side of a cross-repository contract without the other side it needs. A consumer never runs against a producer that doesn't yet speak its contract. | A half-shipped token contract broke real calls. | Handoff "What the build learned": "Changing the token contract (A1) breaks real issuer-to-Portal calls until the issuer stamps the new claims". | authorized: the owner's direction to fold every learned issue into the design ("dotn forget all the issues") |
| U5 | Each shape that crosses the repositories has one home, one direction of generation, and a test of the real producer's output against the real consumer's parser. Agents do not invent a fixture-exchange scheme. | The previous scheme was agreed between agents, not with the owner. | Handoff failure 11: "A cross-repo fixture-exchange scheme agreed with the Fleet Lead, not the owner". | authorized: same direction |
| U6 | The joint proof is the real path: a real session or bot gets a real token from the real issuer and makes one real effect through the Switchboard, and a real removal stops it. Two separate fixture suites are not that proof. | Only the real path shows the parts work together. | Handoff "What the build learned": "The real issuer → Portal → single-effect test is the joint gate". | authorized: same direction |
| U7 | Problems that need the owner reach them fast, as an HTML question page and/or through Sun. | The owner wants to unblock quickly. | Owner rule 6 in the handoff; owner, 2026-10-24: "if rpbolesm ask qeutsion and make html for em asap or tell sun so he notficies me asap". | authorized, 2026-10-24 |
| U8 | Heavy test runs use sunclaw, never the owner's Mac. Agent VM boots run in CI only. | The owner's machine stays free; VMs are qualified in CI. | Owner rules recorded in memory: "heavy tests run on sunclaw"; "VM runs in CI only". | authorized |
| U9 | Each repository's existing gates stay as their owners approved them; this work adds no gate except the owner-approved type-check guard. | The gates are the owners' proof contract. | "who teh fuck tkold you to chagne pnpm check"; the guard approval "yes tykpe check ype safety is paramount". | authorized, 2026-10-24 |

## Goal boundary

**Goal:** an approved order of work across agent-vm and codex-router that delivers the Switchboard remediation, the sign-in revision and agent identity, with every cross-repository contract shipped whole, the real joint path proven, and every gate owned.

**Existing foundation:**

- The three governing designs listed above.
- The identity design's component split between the two repositories.
- PR #262 (Switchboard stack, head `2dfea38e`) and #263 (sign-in issuer, head `0ff6a6af`), both open.
- The Fleet Lead's release work in codex-router.

**What is missing:** the order, the dependency points, the contract homes and their generation direction, the joint proofs and their targets, the gate owners, and the disposition of #262 and #263.

**May change:** the plans that follow from this design; nothing in product code is changed by this set itself.

**Protected:** the Fleet release (codex-router), which ships first and is not changed by this set; each repository's gates.

**Non-goals:**

- No new identity, permission, storage or protocol meaning (the three governing designs own those).
- No cross-repository build tooling or fixture registry.
- No change to how the Fleet release is built.

**Acceptable evidence:**

- The plans for each repository follow this order.
- Every cross-repository contract has a home, a generation direction and a producer-against-consumer test.
- The joint proofs pass on their named targets before the joint cut is called done.

## Open owner decisions

| ID | Decision | Recommendation (not decided) |
|---|---|---|
| OD-R1 | What happens to #262 (the Switchboard stack) and #263 (the sign-in issuer). | Drawn in the [Program Design](program-design.html#program-design--what-happens-to-262-and-263). |
| OD-R2 | Whether the codex-router identity slices handed to the Fleet Lead before today's redesign still stand. | They wait for this design's approval and are re-cut from it; the Fleet release is untouched. |
