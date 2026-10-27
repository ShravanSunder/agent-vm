# Agent identity delivery plan

## Result and basis

- **Planning result:** blocked on your decisions OD8, OD9 and OD10, and on your approval of the design.
  - The independent review closed every correction and returned `decision-needed`, because those choices are yours. A plan must not pick them for you.
  - The slices below are the proposed sequence, written on the recommended answers. Each slice an answer would change is marked with it.
  - Once you decide, the marked slices are adjusted and this record becomes `ready`.
  - Decide on the [identity decisions page](../../../wip/2026-10-27-identity-owner-decisions/index.html).
- **Originating planner:** `plan-implementation`
- **Governing planning basis:** reviewed four-document design
  - [Requirements](../requirements.md)
  - [Specification](../specification.md)
  - [Program Design](../program-design.md)
  - [Verification Design](../verification-design.md)
  - Review: the Sol Reviewer's four-document review at `66dd3b66` (`reviewer-four-document.md`, not-ready, F1–F8 and M1), its correction check at `33bee8bd` (`reviewer-recheck.md`, R1–R4) and its second check at `5327c6c7` (`reviewer-recheck-2.md`: every correction closed, verdict `decision-needed`). The Advisor's second look (`advisor-four-document.md`, A1–A8) and recheck (`advisor-recheck.md`, C1–C2) are also closed at `5327c6c7`. All five are in `tmp/practices-research/2026-10-27-identity-four-document-review/`.
  - Applicability anchors: agent-vm `design/portal-remediation`, design at `5327c6c7`; codex-router `f465808f`; Better Auth 1.7.11 (`52ab801c`)
- **Delivery context:**
  - Requested terminal: `plan-only`. You said nothing is built until the design is agreed, so this plan goes to you, not to an Implementer.
  - Delivery grouping: `single:identity-slices-in-the-delivery-order`
  - PR topology: `separate-prs`. One PR per slice, as the delivery orchestration's rule "every slice merges as one pull request" requires.
- **Order it extends:** the [delivery orchestration](../../2026-10-24-delivery-orchestration/program-design.md), which owns the cross-repository order.
  - **Adds** the slices the 2026-10-26 decisions need: B5, F2b, F10–F12, F14, V1, the private-stack Access removal JC2, and the production steps PROD2 and PROD3.
  - **Extends** B1, B4, P1, F1–F5, F8 and F9.
  - The orchestration's slice table is updated in the same change.

## Goal, scope and non-goals

**Goal:** every identity requirement (U1–U37) delivered and proven on its planned target. Your production fleet then moves to the new machine login in U34's three steps.

**In scope:**
- the identity parts of workstreams B (sign-in), P (Portal identity) and F (Fleet identity);
- the machine-login work in codex-router, the sign-in service and agent-vm (the VM creator);
- the private-stack joint cut, and the two production steps.

**Not in scope:**
- the Tool Portal remediation slices A1–A8 (their own plan; P1 waits on A8);
- the Fleet release F0;
- managers' powers;
- agent-vm `Vm` session launch records;
- a real cloud platform's OIDC (tested against a stand-in until you name one);
- a Firecracker-specific host (OD10);
- any new check gate. The Linux CI job below is proposed to you, not wired in.

## Waiting on you before the slices that need it

| Decision | Blocks | Recommendation |
|---|---|---|
| Design approval of this set | every slice | — |
| OD4, the sign-in tables (now with `deviceCode` and its `enrollmentId`) | B1 | approve the drawn tables and generated SQL together |
| OD8, one Fleet object per organization | F2b, and through it F4, JC1 and PROD2 | yes. The first organization adopts today's storage through a fixed mapping on both hosts. That is still a storage cutover, priced in the Requirements' OD8. |
| OD9, Linux without systemd | nothing blocks; F12 builds the systemd path either way | no: those machines log in through an issuer |
| OD10, which VMs | the VM leg of SO9 | agent-vm's own VMs (Gondolin on QEMU), with agent-vm as the creator; Firecracker only if you name a host |
| Linux CI job in codex-router (SO9) | the Linux leg of F14; U35 stays unverified on Linux until then | approve one `ubuntu-latest` job running SO8 with the Router as a systemd service |
| OD5, OD6, OD7 | nothing blocks; the proposed defaults are built, each one setting or one row to change | as recommended in the Requirements |
| OD-R1 to OD-R4, RD1 to RD6 | as in the delivery orchestration and the remediation design | unchanged |
| Running PROD2 and PROD3 | the production switch and Access removal | at PROD2 you run the new Router build and log every machine in again; nothing in production changes before you say go |

## Current evidence

- **codex-router `f465808f`:**
  - The Registry's `machine_enrollments` table carries no organization and couples the machine to an Access client (`machine_enrollment.rs:439–445`).
  - Machine identity comes from the Access assertion (`access_rules.rs:104–114, 143–160`), and `/v1/session` requires `Cf-Access-Jwt-Assertion` (`central_router.rs:119–136`).
  - The Fleet object is a singleton address (`core_contract.rs:34–42`; Cloudflare `FLEET`/`fleet`, `object_location.rs:8`; the Tokio key `fleet`, `object_keys.rs:12–17`).
  - Fleet reads are directory, snapshot and a contiguous feed (`session_scope/fleet_reads.rs:23–45`, `fleet_feed_store.rs:80–124`).
  - The Router reuses its saved installation and peer IDs (`service_identity_storage.rs:53–67, 120–135`).
  - Off macOS the secret store's data key returns `Unavailable` (`keychain_data_key.rs:164–185`).
  - CI runs on `ubuntu-latest`.
  - There is no request-rate limit.
- **Better Auth 1.7.11:**
  - The device plugin takes one grant object with added request and persisted fields (`device-authorization/index.ts:137–192`).
  - `redeemDeviceCode` is exported, and redemption is `consumeOne`, a single conditional statement (`routes.ts:509–645`; `drizzle-adapter.ts:1078–1131`).
  - `issueTokens` takes a `referenceId` that the refresh token stores and restores (`types/index.ts:164–173`; `token.ts:594–640, 1957–1969`), and the claim contributor receives it (`types/index.ts:374–392`).
  - The first signed-in visitor claims a pending code's user slot (`routes.ts:866–885`), which is why the owner hooks guard verify, approve and deny.
- **agent-vm:**
  - Check gates are yours (`scripts/run-check-gate.ts`).
  - VMs boot through Gondolin on QEMU, with host-to-guest VFS mounts (`docs/subsystems/gondolin-vm-layer.md`). VM e2e runs only in CI (`pnpm test:e2e:vm`).
  - Heavy runs go to sunclaw, a Mac with no `/dev/kvm`.

## Slices

**Every slice also passes its repository's existing gates, unchanged:**
- agent-vm: `pnpm check`, `pnpm typecheck`, `pnpm fmt:check`, and the vitest projects it touches. Heavy suites (workerd, `pnpm test:e2e:host`, whole sweeps) run on sunclaw.
- codex-router: `cargo check -p <crate>` and `cargo test -p <crate>` while building, then codex-router's required completion gates. On Apple Silicon these go through its signing runner. The Fleet Lead runs and accepts them, and nothing merges in codex-router without the Fleet Lead.
- No slice adds or changes a gate.

Each slice is one PR. "Earns" names the Verification Design rows whose passing condition the slice first meets and the command or journey that observes it. Focused proofs are the slice's own and never stand in for a row. Proof-layer names come from each repository: agent-vm's vitest projects (`unit`, `integration`, `e2e-host`, `e2e-vm`) and codex-router's `cargo test -p <crate>` plus `verify-codex-router` journeys.

### codex-router (Fleet Lead)

**F1 identity contracts (extended).**
- **Covers:** R26, plus the machine-login shapes: `MachineTokenClaims` and a `MachinePrincipal` kept outside the actor `Principal`, `DecideDeviceLogin`, `DeviceLoginDecision`, `DecideMachineToken`, `MachineTokenDecision` (with `decided_at`), `AdmitMachineConnection`, `MachineConnectionAdmission`, `MachineEnrollment` (reserved, approved, pending, enrolled, revoked, expired), `MachineIssuer`, `AdmissionId`/`AdmissionRef`, and the view frames `Withheld` and `ScopeChanged`.
- **New contracts:** K8 (device-login and machine-token decisions) and K9 (machine token claims), both homed here as JSON Schema with examples.
- **Writes:** `collaboration-central-core/src/identity_contract.rs`, generated schema.
- **Earns:** SO6's Rust half; U1's focused parse cases.
- **Focused proof:**
  - **Wrong behaviors caught:** a closed variant serialized under a different tag than the Program Design names; `machine` parsing as an actor.
  - **Layer:** `cargo test -p collaboration-central-core` round trips.
  - **Oracle:** the Program Design's shapes.
- **Waits on:** F0; design approval.

**F2 organization authority (extended).**
- **Covers:** R5, R6, R7, R10, R13, R14, R20; R34 (organization-scoped rows; cross-organization references answer as unknown); R35–R37 (admission-keyed roles, OD5's default, readmission); the generalized `Collaboration`; the operator check through the sign-in service (built, enabled at PROD2).
- **Earns (SO4 named scenarios, on Tokio and local workerd):** U26/U36; U27's central half; U21's command and guard cases.
- **Focused proof:**
  - **Wrong behaviors caught:** a role that still counts after its admission ends; a reference to another organization answering differently from a missing one.
  - **Layer:** `cargo test -p collaboration-central-core organization_authority`.
  - **Oracle:** R34–R37.
  - **Property:** for any sequence of admit, grant, end and readmit, a role counts exactly while its admission ID is active.
- **Waits on:** F1; K5 and K6 from B3.

**F2b Fleet data per organization and the filtered view (new; waits on OD8).**
- **Covers:** R34's storage separation and U29's view:
  - the Fleet object addressed by organization, the first organization adopting today's storage through a fixed mapping on both hosts, and refusing the old address;
  - each machine's visible set, pushed by the organization authority;
  - directory, snapshot and feed filtered, with `Withheld` and `ScopeChanged`.
- **Writes:** `core_contract.rs` addresses, `call_graph.rs`, both hosts' object routing, the Fleet read paths.
- **Earns:** SO4 "one Fleet object per organization, read back after a restart" and SO4's filtered-view scenarios (U27/U29).
- **Focused proof:**
  - **Wrong behaviors caught:** the first organization's workspaces not found after the change; a snapshot leaking a paired workspace's boards; a withheld feed position breaking the cursor.
  - **Layer:** a migration test over a populated Fleet store on both hosts, then read-path tests per frame.
  - **Oracle:** today's rows, and the view contract.
- **Waits on:** F2; OD8.
- **Stop if:** you choose the column. Then this slice becomes the backfill plus the organization filter on every Fleet read and write, with the same view contract, and the plan is re-cut.

**F3 decisions, service caller, receivers (extended).**
- **Covers:** R18, R25, R27 (central side), plus the device-login and machine-token decision receivers (C7).
- **Earns:** SO7 for every C7 edge.
- **Focused proof:**
  - **Wrong behavior caught:** an operation picked from the body, not the audience and scope.
  - **Oracle:** the C7 table.
- **Waits on:** F2, F10; K1 and K7 from B4.

**F4 Router registrar, binding, forwarder (extended).**
- **Covers:** R2, R3, R7, R8, R23, R24. Registration goes to the machine's organization authority, which looks the project up in its own Fleet object, and checks that the connection's enrollment is the active one.
- **Earns (in SO1):** U6/U32, U19, U18.
- **Waits on:** F2, F2b, F11.

**F5 removal outbox (extended).**
- **Covers:** R19–R21. A machine's revocation is one organization-authority transaction: allowances withdrawn, sessions removed, notices written, connection closed.
- **Earns:** U13's central half in SO4.
- **Focused proof:**
  - **Wrong behavior caught:** a grant decided after the revocation's commit.
  - **Layer:** `cargo test` with interleaved decisions.
  - **Oracle:** R19.
- **Waits on:** F2, F10.

**F6 collaboration admission, F7 bot messaging:** as in the delivery orchestration. Collaboration admission also answers `unknownTarget` across organizations, admits nothing for a person's collaboration, and refuses a superseded connection.
- **Earns:** U7/U8/U28 in SO1.

**F10 machine enrollment, issuers and the machine token check (new).**
- **Covers:** R39, R40, R42 (central side), C9, C10:
  - issuers and enrollments in the organization authority;
  - the Registry's `fleet_machines` index and the authorize, claim, then activate or cancel sequence, idempotent on the request ID;
  - reserved and approved enrollments, and supersession at a device-code enrollment's first token;
  - the active-enrollment check on every decision;
  - `DecideDeviceLogin`, `DecideMachineToken`, `AdmitMachineConnection`, `ApproveMachineEnrollment`, `RevokeMachineEnrollment`;
  - the token check for built-in, VM creator and OIDC issuers;
  - `RenewMachineToken`, and closing expired and superseded connections;
  - the single-valued `machineLogin` setting (production stays `accessEnrollment`);
  - the entry's request limit.
- **Writes:** `organization_authority`, the Registry object, new `machine_token_check`, `central_router.rs` `/v1/session`, both hosts' entries.
- **Earns (SO4's machine-login and token-check scenarios):** U31, and U33's central half.
- **Focused proof:**
  - **Wrong behaviors caught:**
    - a claim written for a refused attempt;
    - an unredeemed approval superseding a working enrollment;
    - a superseded connection getting a grant;
    - a token for another organization admitted.
  - **Layer:** `cargo test -p collaboration-central-core machine_` with a controlled clock, reading both owners after each refusal.
  - **Oracle:** C9's accept and refuse lists, R39, R40.
  - **Property:** for any interleaving of two organizations' authorized attempts on one installation, at most one claim exists, and it belongs to an authorized attempt.
- **Waits on:** F2; K8 and K9 from F1; K10 from B5.

**F11 Router machine login (new).**
- **Covers:** R40, R41 (Router side):
  - the device-code flow run in the Router host, with `fleet login` asking the host and printing the code;
  - `MachineTokenSource` (`deviceCodeRefresh`, `issuerFile`, `platformOidc`);
  - presenting and renewing the token;
  - applying `ScopeChanged` and `Withheld` to the replica;
  - deleting the old enrollment credential after a new login;
  - refusing a second organization.
- **Writes:** `codex-router-host` `fleet_machine_login`, `codex-router-cli`, the replica's feed consumer.
- **Earns (in SO8, with F14):** U33's Router half.
- **Focused proof:**
  - **Wrong behaviors caught:** a second long-lived credential kept; the installation ID lost on re-login; a withheld position stalling the cursor.
  - **Layer:** `cargo test -p codex-router-host fleet_machine_login` with an injected store and clock.
  - **Oracle:** R40, R41, the view contract.
- **Waits on:** F1; F12 for Linux; B5 for the real flow (stand-in: a device-code server honoring C8 in tests, named unverified until SO8).

**F12 Router secret store, Linux backend (new).**
- **Covers:** R41 and R44 for the store. `systemd_credential_data_key.rs`: `read_secret` reads `$CREDENTIALS_DIRECTORY`, `add_secret` returns `Unavailable`. The installer step seals the key with `systemd-creds` and writes the unit's `LoadCredentialEncrypted=`. Production refuses without it.
- **Earns:** SO9's store reads on Linux.
- **Focused proof:**
  - **Wrong behavior caught:** a plaintext fallback in a production build.
  - **Layer:** `cargo test -p codex-router-secret-store`. codex-router's existing Linux job already runs this crate's tests; the real sealed-credential case uses `sudo systemd-creds encrypt --with-key=host` there.
  - **Oracle:** R41.
- **Waits on:** design approval.
- **Stop if:** the existing job can't seal a credential without a workflow change. Then the real-credential case waits for the Linux CI job approval, and the slice ships with the refusal case.

**F8 SO1 TypeScript journey (extended).** Two organizations; the Router logged in by device code (F14's arrangement); other-organization start and message; the replica read for the filtered view.
- **Earns:** U3/U17, U6/U32, U7/U8/U28, U19, U27/U29's Router half, U18.
- **Waits on:** F4, F11, F14.

**F9 SO4 conformance (extended).** Every new named scenario, on both central hosts.
- **Earns:** U9, U21/U31, U26/U36, U27/U29, U34's lasting negatives.
- **Waits on:** F2b, F3, F10.

**F14 SO8 machine login journey (new, TypeScript).** `verify-codex-router` `fleet-machine-login`, with a test VM creator signer and a stand-in OIDC issuer.
- **Earns:** U33/U31 (consumer side), U17/U33/U35 on macOS, and U14's renewal case.
- **Waits on:** F10, F11, B5. The Linux leg also waits on the Linux CI job approval.

### agent-vm (Tool Portal Lead)

**B1 sign-in core and storage (extended).**
- **Covers:** R29–R33, with the device grant's `deviceCode` table (our four columns and `enrollmentId`) in the one schema module.
- **Earns:** U22, U23, U24 and U25 in SO2 on D1.
- **Waits on:** OD4.

**B2 sign-in Node host:** unchanged; it is also the sign-in host for SO9's Linux leg.

**B3 design-thread fixes:** unchanged.

**B4 identity issuer (extended).**
- **Covers:** R1, R4, R15, R16, R18, R25, R26, R27 (issuer side), and R38 (no workspace, collaboration or machine token for a person).
- **Earns:** U2, U10/U11 (issuer half), U12, U30 (issuer half), U4/U5 in SO2.
- **Waits on:** B3; K2–K4 from F1.

**B5 device-code login (new).**
- **Covers:** R42, R40 (issuer side), R31 (single use):
  - the Router login client;
  - the grant object with the machine fields;
  - owner before-hooks on verify, approve and deny;
  - the approve hook sending `DecideDeviceLogin` and storing `enrollmentId` on the code;
  - our device-code token handler, redeeming with `redeemDeviceCode` and minting with `referenceId` = `<organizationId>:<enrollmentId>`;
  - the contributor deciding device-code and refresh mints from `input.referenceId` only;
  - the OD6 lifetime;
  - the dispatch row and refused combinations;
  - K10 (example machine tokens from the real issuer).
- **Writes:** `packages/auth` `sign-in-core/device-login/`, the provider configuration, the dispatch.
- **Earns:**
  - SO2's device-code cases on D1 and `better-sqlite3`, including non-owner verify and deny, two machines under one owner kept apart across rotation and restart, and the held-grant window;
  - U22's redemption race;
  - U24's codes-not-UUIDs;
  - U25's single-use family.
- **Focused proof:**
  - **Wrong behaviors caught:**
    - a non-owner claiming or denying a code;
    - a code redeemed twice;
    - one machine's refresh minting another's token, including across two organizations;
    - a refresh after revocation minting.
  - **Layer:** sign-in core tests with a central client stand-in (unit), then the real provider on both databases (integration).
  - **Oracle:** C8, R40, R42.
- **Waits on:** B4, B2; K8 and K9 from F1.
- **Stop if:** at 1.7.11 the token handler can't be registered for the device-code grant type, or `referenceId` raises a consent requirement for the Router login client. Then take the fallback, our own device endpoints through `issueTokens` with the same reference, proven by the same rows.

**P1 Portal identity (extended).**
- **Covers:** R9, R17, R19–R22 (Portal side), plus R45 (one organization per deployment; configuration refuses a second) and R38 (no requester field read).
- **Earns:** U10/U11, U12's Portal half, U13's Portal half, U37 and U30's Portal half in SO3 (`pnpm test:e2e:host` on sunclaw).
- **Waits on:** A8; K2 from F1.

**V1 VM creator issuer (new).**
- **Covers:** R40 (issuer side for VMs), R24, R41:
  - the VM controller assigns each VM's installation and peer IDs;
  - it signs short-lived tokens with the issuer key;
  - it mounts a controller-owned directory holding only the token read-only into the guest through the existing `owned-host-directory` mount, publishes each token by atomic rename, writes the first before `start()`, and re-signs at half-life and after a controller restart;
  - the VM image carries the Router.
- **Writes:** agent-vm's VM controller and its use of the existing `owned-host-directory` mount; the VM image; no change to the mount contract or check gates.
- **Earns:** SO9's VM leg in agent-vm's existing VM test command, with the real creator (U33, U35, U17).
- **Focused proof:**
  - **Wrong behaviors caught:** a token whose `exp − iat` exceeds the organization's lifetime; a key written into the guest; a file not re-signed after a controller restart.
  - **Layer:** `pnpm test:unit` and `pnpm test:integration` for the signer and controller; the guest check in `pnpm test:e2e:vm` (CI only).
  - **Oracle:** the Program Design's VM creator claims and lifecycle.
- **Waits on:** F1 (K9); F10 for the real check; OD10 for the target.

### Joint and production steps

**JC1 identity joint cut, private stack (extended).**
- **Covers:** the delivery orchestration's JC1 procedure, unchanged, plus the private test central deployed with `machineLogin = machineTokens` behind the test Access application. The test Router logs in by device code before JP1–JP4.
- **Earns:** JP1–JP4; SO10 step 2 on the private stack; U34's step-2 row.
- **Waits on:** B4, B5, P1, F2b, F3–F6, F10, F11.

**JC2 private stack without Access (new).**
- **Covers:** R43 step 3 on the private stack: delete the test Access application.
- **Earns:** SO10 step 3 (SO8 against the test central; unauthenticated, malformed and wrong-kind requests change nothing; the request limit) and U34's step-3 row.
- **Waits on:** JC1.
- **Stop if:** anything fails. Then restore the test Access application and fix forward; production is untouched.

**PROD2 production step 2 (new; you run it).**
- **Covers:** R43 step 2 in production:
  - Fleet central deploys with `machineLogin = machineTokens`, the old login's code and table removed, the first organization created for you adopting today's Fleet storage (F2b), and operator commands through the sign-in service;
  - you run the new Router build and log every machine in again by device code.
- **Earns:** U34's production line: each machine connects with machine tokens; the old credential is refused (one spot check); your sessions, allowances and board relationships are still attached.
- **Waits on:** JC2; OD8; your go.
- **If it breaks:** fix forward. There is no revert to the old login, because a machine revoked after the switch could regain access through it. Access still guards central meanwhile.

**PROD3 production step 3 (new; the next change; you run it).**
- **Covers:** R43 step 3 in production: delete the production Access application, and the Routers' Access headers and stored Access token.
- **Earns:** the step-3 production observation: every machine still connects; an unauthenticated request changes nothing.
- **Waits on:** PROD2 holding for a period you choose; your go.

**DONE (extended).**
- **Covers:** the orchestration's DONE, plus SO8 on macOS, SO9's Linux leg (or named unverified until you approve its job), SO9's VM leg, and V1 merged.
- **Waits on:** JC2, B2, F7, F8, F9, F14, V1, P1.

## Dependency edges that matter

- **Contracts first:** F1 comes before every consumer of K2–K4, K8 and K9 (B4, B5, P1, F10, V1). B5 produces K10 for F10's tests.
- **Storage before the Router's routing:** F2b (OD8) comes before F4, because registration looks the project up in the organization's own Fleet object. Production waits on F2b too.
- **Machine login before the joint cut:** F10, F11 and B5 all come before JC1, because the test Router logs in the new way at the cut.
- **Steps in order:** JC1 → JC2 → PROD2 → PROD3, each only after the previous step's observations pass.
- **The deploy hold:** the orchestration's hold before JC1 also covers B5. The sign-in Worker isn't deployed from master between B4 or B5 merging and JC1.

## Verification Design rows, scheduled

| Row | Slice that earns it | Command or journey | When |
|---|---|---|---|
| U1 | F1, B4 | `cargo test -p collaboration-central-core`; sign-in unit; SO6 | in each slice |
| U2 | B4, F2 | SO2; SO4 | B4; F9 |
| U3, U17 | F4, F11, V1 | SO1, SO2, SO8; structural search | F8; F14 |
| U4, U5 | F2, B4 | SO4; SO1 + SO2 | F9; F8 |
| U6, U32 | F4 | SO1 | F8 |
| U7, U8, U28 | F6, F7 | SO1; SO3; SO4 | F8; F9 |
| U9 | F2, F10 | SO4 + SO1 + SO8 | F9 |
| U10, U11 | P1 | SO3 (`pnpm test:e2e:host`, sunclaw) | P1 |
| U12 | B4, P1 | SO2; SO3 | each slice |
| U13 | F5, P1 | SO1, SO3, SO4, SO5 | F9; P1; JC1 |
| U14 | F3, B5 | SO1, SO2, SO8, SO5 | F8; F14; JC1 |
| U15 | F3 | SO7 | F3 |
| U16 | B2, F9 | SO2/SO3/SO4 on both hosts | DONE |
| U18 | F4 | SO1 + SO4 + SO6 | F8 |
| U19 | F4 | SO1 | F8 |
| U20 | B3, F2 | `verify-auth` bootstrap + SO4 + SO7 | F9 |
| U21, U31 | F2, F10, B5 | SO4; SO8; SO2 | F9; F14; B5 |
| U22 | B1, B5 | SO2 on both databases | B1; B5 |
| U23 | B1, B2 | SO2 on both hosts | B2 |
| U24, U25 | B1, B5 | SO2 readback; Hegel families | B1; B5 |
| U26, U36 | F2 | SO4 | F9 |
| U27, U29 | F2, F2b, F8 | SO4 (filtered view); SO1 | F9; F8 |
| U30 | B4, P1 | SO2; SO3 | B4; P1 |
| U33, U31 | F10, F11, B5, V1 | SO8; SO2; SO4; SO9 VM leg | F14; DONE |
| U17, U33, U35 (R41) | F11, F12, V1 | SO8; SO9 | F14; DONE |
| U34 | F10, JC1, JC2 | SO10 (temporary); SO4 | JC1; JC2 |
| U35 | F12, F14, V1 | SO9 | DONE (Linux after approval; Firecracker per OD10) |
| U37 | P1 | SO3 | P1 |

## Existing tests these slices touch

| Existing tests | Slice | Disposition | Proof for a removal |
|---|---|---|---|
| codex-router `machine_enrollment.rs` tests of the enrollment credential and the Access-client match | F10 (old path kept behind `accessEnrollment` until PROD2) | keep through step 1; remove in the PROD2 change | dead contract: R43 retires the old login at step 2; F10's machine-token tests fail on the same wrong behavior (an unauthorized machine connecting) |
| codex-router `access_rules.rs` tests deriving the machine from the Access assertion | F10 | keep through step 1; remove in the PROD2 change | dead contract (R43 step 2); SO4's "same answer whatever Access identity" fails on a build that reads Access identity |
| codex-router `enrollment_prepare.rs` tests (operator token, expiry matching Access) | F10 | remove in the PROD2 change | dead contract: `EnrollMachine` is gone from step 2 |
| codex-router `keychain_data_key.rs` test that non-macOS returns `Unavailable` | F12 | repair: on Linux, `Unavailable` only when no systemd credential is present | — |
| codex-router Fleet read tests that assume every connection reads every record | F2b | repair: the same reads under a visible set that includes everything, plus new filtered cases | — |
| agent-vm sign-in integration tests on `node:sqlite` | B1 | repair onto `better-sqlite3` and D1, as the orchestration already plans | — |
| agent-vm Portal membership and agent-management tests | P1 | remove | dead contract: R17 (token-only) and the Program Design's "Removed" list; SO3's refusal cases fail on a build that reads membership from the store |

## Integration gates

- **F10 with B5:** a real issuer's machine token first meets central's check. B5's examples (K10) are parsed in F10's tests; the real path is SO8 in F14.
- **F11 with F10 and B5:** SO8 is the first run of the whole device-code login across processes.
- **F2b with F11:** the replica first consumes `Withheld` and `ScopeChanged`, observed in F8's SO1 run.
- **V1 with F10:** the real VM creator's tokens first meet central's check, in SO9's VM leg.
- **JC1:** every cross-repository contract goes live together, now with machine login.

## Risks and false greens

- **SO8 uses a test signer.** It proves the Router's side of the token file only. A build where agent-vm's controller never re-signs passes SO8 and is caught only by SO9's VM leg, so U33 isn't reported met before that leg runs.
- **F11 before B5:** if F11 merges first, its device-code flow is proven only against a stand-in. It stays named unverified until F14 runs against the real B5 issuer.
- **SO10 is temporary.** The step 2 and step 3 checks run once on the private stack; their lasting regression lives in SO4's entry negatives.
- **Linux:** U35 stays unverified on Linux until you approve the job. A Mac-only pass must not be reported as U35 met.
- **`referenceId`:** if a later Better Auth changes how it is restored on refresh, renewals stop (they fail closed). SO2's rotation and restart cases catch it at an upgrade.
- **The orchestration hold:** a sign-in deploy from master between B5 and JC1 would ship the new dispatch alone. The hold covers B5.

## Stop and replan

- **Better Auth:** the device-code token handler can't be registered, or `referenceId` raises a consent requirement, at 1.7.11. Take the fallback, same rows.
- **OD8:** you choose the column. Re-cut F2b.
- **OD10:** you name a Firecracker host. Add its leg to SO9 with its own target slice.
- **Linux CI:** the job is declined. U35's Linux leg becomes your accepted limit, and the plan records it.
- **Fleet replication:** the existing replica can't take a withheld position without a protocol version change. That is a design correction, routed back before F2b.
