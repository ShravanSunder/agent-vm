# Delivery orchestration: Verification Design

How each need in the [Requirements](requirements.md) will be shown to hold, at the seams the [Program Design](program-design.html) exposes. This is a plan; nothing in it has been observed. Most of these needs are about the order of work rather than product behaviour, so most of the evidence is the plans and records the order produces. Only R6 runs software, and it runs the real joint path.

## What the owner will see proven

| Need | Proven by | Still unverified |
|---|---|---|
| **U1** Design before build | Each repository's plan lists its slices with the design rows each realizes, and the first slice's first commit comes after your recorded approval. | — |
| **U2** Both repositories, order, waits, proofs, gate owners, readable | The order is walked from its picture and table: every slice of the three designs appears once, every wait points backward, and every gate has an owner; the page opens for a person. | — |
| **U3** Fleet release first | codex-router's release record shows 0.1.102 shipped before F1's first commit. | — |
| **U4** No half-shipped contract | At the joint cut, the deployed issuer, Switchboard and Fleet central builds are read back and must all be the joint-cut builds. Before it, the previous builds are still deployed. | Customer deployments, which don't exist yet |
| **U5** One home per shape, a real test | For each contract, the consumer's test is seen parsing the home's generated artifact, and a deliberately changed producer field fails it. | — |
| **U6** The real joint path | At the first cut, JP4 runs on the private stack with the real sign-in Worker and Fleet central: an admin command needs a live session; SO8 and SO11 run there too. At the second cut, JP1–JP3 run with real sessions, a real bot, the real issuer, Fleet central and both Switchboard hosts: one effect each, removal stops the next call, refusals run nothing. | Hardware-attested isolation; VM sessions (not in the first round) |
| **U7** Questions go out fast | The trace shows each blocking question sent as an HTML page or Sun message at the time the block was found. | — |
| **U8** Heavy runs on sunclaw, VMs in CI | Run records name sunclaw or CI for every heavy or VM run. | — |
| **U9** Gates unchanged except the guard | The gate files in each repository are compared with their approved state. | — |

## Rows

### U1 — Design before build

| | |
|---|---|
| **Requirement** | U1 → R1 |
| **Proven by** | Each plan's slices name their design rows, and nothing starts before the recorded approval. |
| **Reference** | The owner's recorded approval of the three designs (the trace entry and decision record); the slices table in the Program Design |
| **Target and journey** | Each repository's plan and Git history at delivery; journey: none (records) |
| **Passes when** | Every planned slice names at least one R or U row from a governing design, and the first commit of every slice is later than the approval entry. **Wrong build that fails:** a slice whose first commit predates approval, or a slice naming no design row. |
| **Reuses** | none |
| **Unverified** | — |

### U2 — One complete order, readable

| | |
|---|---|
| **Requirement** | U2 → R2 |
| **Proven by** | The order is walked: every slice appears once, every wait points backward, every gate has an owner, and the page opens. |
| **Reference** | The three governing designs' slices; the Program Design's slices, contracts and gate tables |
| **Target and journey** | This design set and its page; journey: none (structural) |
| **Passes when** | Every slice the governing designs need is in the slices table exactly once. Every "waits on" entry names an earlier slice or a contract version, and the dependency graph has no cycle. Every gate in the gate table has one owner. Every slice reaches the terminal DONE barrier through its waits: removing any one slice from the graph leaves DONE unreachable. The page renders its picture and tables at desktop and phone width. **Wrong designs that fail:** P1a listed before A8; a gate with two owners; A4, B2, F7, F8b or F9 able to stay unmerged while the terminal predicate passes (the d032c7fd graph, where JC1 was the last node). |
| **Reuses** | none |
| **Unverified** | — |

### U3 — Fleet release first

| | |
|---|---|
| **Requirement** | U3 → R3 |
| **Proven by** | The Fleet release is seen shipped before the first identity commit in codex-router. |
| **Reference** | codex-router's release tag for 0.1.102 |
| **Target and journey** | codex-router's tags and F1's first commit; journey: none |
| **Passes when** | The release tag's date precedes F1's first commit. **Wrong order that fails:** an identity commit on a branch started before the tag. |
| **Reuses** | none |
| **Unverified** | — |

### U4 — No half-shipped contract

| | |
|---|---|
| **Requirement** | U4 → R4 |
| **Proven by** | At the joint cut, the deployed builds are read back and must be the cut's builds together; before it, the previous builds keep serving. |
| **Reference** | The joint cut's build list (issuer, Switchboard Worker, Fleet central, Router) |
| **Target and journey** | The private test stack. Part of the JP journey below (`needed:` `verify-tool-portal` › `joint-cut`, which reads each deployed component's version endpoint or deployment record). |
| **Lifetime** | temporary (it runs at the cut) |
| **Passes when** | Before the cut, every component reports its previous build, and a call through the stack succeeds. Every caller cohort in the cut inventory is then stopped: each test Router reports no active session, the bot process has exited, and any production cohort calling a shared instance is held as the inventory records. Before the first deploy, `wrangler tail` (running from before the stop) shows a recorded outcome for every invocation that began before the stop time. After the deploys, every component reports its cut build. That cut's proofs pass using only the named proof cohort (JC1: SO8, SO11, JP4 and the legacy-path control; JC2: JP1–JP3), and the ordinary callers' first requests come after the last proof. A deliberately failed second deploy is part of the rehearsal on the private stack. It must leave every caller stopped, the proof cohort included, until a corrected build is deployed and every component reads back its cut build; only then does the cohort run that cut's proofs. No previous build is redeployed. A proxy approval token and a batch approval used once before JC2 are presented again after it, on the Worker and on Node, and both are refused at verification: the approval keys were rotated with store version 2 at JC2 (remediation R9). JC1 leaves the Switchboard and its keys untouched. **Wrong cuts that fail:** the issuer deployed alone with callers running, so the old Switchboard refuses its tokens; ordinary callers restarted before the JPs ran; a "drain" judged from quiet logs while an invocation started before the stop has no outcome; a failed deploy answered by redeploying the old Switchboard against the version 2 store. |
| **Reuses** | none |
| **Unverified** | customer deployments |

### U5 — One home per shape, a real test

| | |
|---|---|
| **Requirement** | U5 → R5 |
| **Proven by** | For each of K1–K10, the consumer's test is seen parsing the real producer's output, in whichever of the two slices merges second, and a changed producer field makes that test fail. |
| **Reference** | Each contract's home schema at its pinned commit |
| **Target and journey** | Each consumer's existing test command in its repository; journey: none (the tests themselves) |
| **Passes when** | Each consumer test reads the artifact the home generated, never a hand-written fixture. Renaming one required field in the home's artifact (for example `removal_revision`) and refreshing the consumer's copy makes the consumer's test fail. **Wrong build that fails:** a consumer test built on a hand-written copy of the shape. |
| **Reuses** | none |
| **Unverified** | the artifact-crossing scheme, until OD-R3 is decided |

### U6 — The real joint path

| | |
|---|---|
| **Requirement** | U6 → R6 |
| **Proven by** | JP4 at JC1 and JP1–JP3 at JC2 run on the private stack with every real component that cut deploys, and each passes. |
| **Reference** | The agent identity Specification's obligations for issuance, removal, refusal and admin freshness; the Switchboard Specification checks 13–14 |
| **Target and journey** | Private test stack: the remediated Switchboard Worker and the Node host, the sign-in Worker, Fleet central on its Durable Object host (its Tokio host is covered by identity SO4 in F9, not here), with JP2's restart being a Switchboard restart: a Worker redeploy and a Node host process restart, a real Router with real Claude and Codex harness sessions, and a test bot. `needed:` `verify-tool-portal` › `joint` (JP1–JP3) and the agent-vm `verify-auth` journey extended for JP4; codex-router's SO1 TypeScript journey (F8a, F8b) for the Router side. |
| **Lifetime** | lasting |
| **Passes when** | **JP1:** each principal's call produces exactly one upstream effect, recorded by the test upstream server, and the analytics data point names the principal. **JP2:** after the owner's removal, the next call is refused on both Switchboard hosts, including after a Switchboard restart, and central's removal status reads acknowledged. **JP3:** each of the four bad tokens is refused with its reason and the upstream records nothing. **JP4:** the admin command applies with a live session and is refused after sign-out. **Wrong builds that fail:** an issuer whose claims the Switchboard can't parse (JP1 fails); a Switchboard that keeps removal marks only in memory (JP2's restart fails); a stand-in central (the joint journey checks central's real build identity). |
| **Reuses** | none: the identity Verification Design's SO1–SO7 are re-pointed at this stack; none run yet |
| **Unverified** | VM sessions and hardware-attested isolation, both outside the first round |

### U7 — Questions go out fast

| | |
|---|---|
| **Requirement** | U7 → R7 |
| **Proven by** | The trace shows each blocking question sent when found. |
| **Reference** | The trace entries and the question pages in `docs/wip/` |
| **Target and journey** | The work trace; journey: none |
| **Passes when** | Each blocked slice in the trace has a question-sent entry with a timestamp at or before the block entry, naming the page or Sun message. **Wrong practice that fails:** a block recorded with its question only in a later report. |
| **Reuses** | none |
| **Unverified** | — |

### U8 — Heavy runs on sunclaw, VMs in CI

| | |
|---|---|
| **Requirement** | U8 → R8 |
| **Proven by** | Run records name sunclaw or CI for every heavy or VM run. |
| **Reference** | R8 |
| **Target and journey** | Implementer and Verifier receipts; journey: none |
| **Passes when** | Every host e2e, stress and long-running receipt names sunclaw, and every VM boot is a CI job. **Wrong practice that fails:** a host e2e receipt from the owner's Mac. |
| **Reuses** | none |
| **Unverified** | — |

### U9 — Gates unchanged except the guard

| | |
|---|---|
| **Requirement** | U9 → R9 |
| **Proven by** | Each repository's gate files are compared with their approved state. |
| **Reference** | agent-vm gate files at `38569fca` plus the guard; codex-router gate files at the Fleet release |
| **Target and journey** | Gate files at delivery; journey: none |
| **Passes when** | agent-vm's diff is the guard only (remediation Verification Design U10), and codex-router's gate files are unchanged by this work. **Wrong build that fails:** a new contract-test CI job. |
| **Reuses** | the remediation Verification Design's U10 row for agent-vm |
| **Unverified** | — |

## Coverage for review and the plan

| U | R | Seam | Observation | Target / journey | Passing condition | Unverified |
|---|---|---|---|---|---|---|
| U1 | R1 | plan slices against approval | records | plans, Git history | rows named; commits after approval | — |
| U2 | R2 | dependency-graph walk | structural | this design and page | complete, acyclic, owned | — |
| U3 | R3 | release before F1 | records | codex-router tags | tag precedes F1 | — |
| U4 | R4 | deployed-version check at JC1 and at JC2 | version read-back | private stack · `joint-cut` (needed, temporary) | all-old then all-new | customer deployments |
| U5 | R5 | consumer tests on home artifacts | test run with a mutated field | each repository's tests | parses real artifact; mutation fails | OD-R3 scheme |
| U6 | R6 | JP4 at JC1; JP1–JP3 at JC2 | real joint run | private stack, both Switchboard hosts · `joint` (needed, lasting), `verify-auth`, SO1 | one effect; removal; refusals; live session | VM sessions |
| U7 | R7 | trace timestamps | records | trace | sent at block time | — |
| U8 | R8 | run receipts | records | receipts | sunclaw / CI | — |
| U9 | R9 | gate-file diff | structural | gate files | guard only | — |

## Journeys this needs

| Journey | Lifetime | Drives | Reads |
|---|---|---|---|
| `verify-tool-portal` › `joint` | lasting | real sessions and a bot through the issuer to both Switchboard hosts; the owner's removal through central | upstream effect records, refusal reasons, central's removal status |
| `verify-tool-portal` › `joint-cut` | temporary | the deployment of the cut's builds | each component's deployed build identity before and after |
| `verify-auth` (extended) | lasting | a person's sign-in and an admin command to central | the command's result with and without a live session |
| codex-router SO1 (F8a and F8b, TypeScript) | lasting | Router registration of real harness sessions | the bound tuple and the token the forwarder attaches |
