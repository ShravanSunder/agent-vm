# Agent identity delivery plan

## Result and basis

- **Planning result:** proposed, not yet `ready`.
  - Your decisions of 27 October are in the design at `b734d002`: OD5–OD10 decided, device-code login only, agent-vm out of this set, no new Linux CI job, and U39 (starting a session on another machine).
  - Those decisions changed the design, so the Sol Reviewer checks the changed parts. When that check closes and you approve the design, this record becomes `ready`.
- **Originating planner:** `plan-implementation`
- **Governing planning basis:** reviewed four-document design
  - [Requirements](../requirements.md)
  - [Specification](../specification.md)
  - [Program Design](../program-design.md)
  - [Verification Design](../verification-design.md)
  - Review: the Sol Reviewer's four-document review at `66dd3b66` (`reviewer-four-document.md`, not-ready, F1–F8 and M1), its correction check at `33bee8bd` (`reviewer-recheck.md`, R1–R4) and its second check at `5327c6c7` (`reviewer-recheck-2.md`: every correction closed, verdict `decision-needed`). The Advisor's second look (`advisor-four-document.md`, A1–A8) and recheck (`advisor-recheck.md`, C1–C2) are also closed at `5327c6c7`. All five are in `tmp/practices-research/2026-10-27-identity-four-document-review/`. The check of your 27 October changes at `b734d002` is the next review step.
  - Applicability anchors: agent-vm `design/portal-remediation`, design at `b734d002`; codex-router `f465808f` (and `main` for the create path and mail kinds); Better Auth 1.7.11 (`52ab801c`)
- **Delivery context:**
  - Requested terminal: `plan-only`. You said nothing is built until the design is agreed, so this plan goes to you, not to an Implementer.
  - Delivery grouping: `single:identity-slices-in-the-delivery-order`
  - PR topology: `separate-prs`. One PR per slice, as the delivery orchestration's rule "every slice merges as one pull request" requires.
- **Order it extends:** the [delivery orchestration](../../2026-10-24-delivery-orchestration/program-design.md), which owns the cross-repository order.
  - **Adds:** B5, F2b, F10–F12, F14, F15, F16, the private-stack Access removal JC2, and the production steps PROD2 and PROD3.
  - **Extends:** B1, B4, P1, F1–F5, F8 and F9.
  - The orchestration's slice table is updated in the same change.

## Goal, scope and non-goals

**Goal:** every identity requirement (U1–U39) delivered and proven on its planned target. Your production fleet then moves to the new machine login in U34's three steps.

**In scope:**
- the identity parts of workstreams B (sign-in), P (Portal identity) and F (Fleet identity);
- the device-code machine login in codex-router and the sign-in service;
- starting a session on another machine of the organization (U39);
- the private-stack joint cut, and the two production steps.

**Not in scope:**
- the Tool Portal remediation slices A1–A8 (their own plan; P1 waits on A8);
- the Fleet release F0;
- managers' powers;
- machine issuers other than the sign-in service, such as VM creators and platforms (later, U31), and all agent-vm work;
- sessions launched inside VMs, and any proof inside a VM (U35);
- any new check gate. No Linux CI job is added (your call, 27 October).

## Waiting on you before the slices that need it

| Decision | Blocks | Recommendation |
|---|---|---|
| Design approval of this set, after the Reviewer's check of `b734d002` | every slice | — |
| OD4, the sign-in tables (now with `deviceCode` and its `enrollmentId`) | B1 | approve the drawn tables and generated SQL together |
| OD2, the default token lifetime | nothing blocks; 5 minutes is built and is one setting | 5 minutes |
| OD-R1 to OD-R4, RD1 to RD6 | as in the delivery orchestration and the remediation design | unchanged |
| Running PROD2 and PROD3 | the production switch and Access removal | at PROD2 you run the new Router build and log every machine in again; nothing in production changes before you say go |

## Current evidence

- **codex-router `f465808f`:**
  - The Registry's `machine_enrollments` table carries no organization and couples the machine to an Access client (`machine_enrollment.rs:439–445`).
  - Machine identity comes from the Access assertion (`access_rules.rs:104–114, 143–160`), and `/v1/session` requires `Cf-Access-Jwt-Assertion` (`central_router.rs:119–136`).
  - The Fleet object is a singleton address (`core_contract.rs:34–42`; Cloudflare `FLEET`/`fleet`, `object_location.rs:8`; the Tokio key `fleet`, `object_keys.rs:12–17`).
  - Fleet reads are directory, snapshot and a contiguous feed (`session_scope/fleet_reads.rs:23–45`, `fleet_feed_store.rs:80–124`).
  - A machine's connection object has a session face (rank 1) and a delivery face (rank 5) that higher-ranked objects call to push frames to that Router (`call_graph.rs:97–171`).
  - The Router reuses its saved installation and peer IDs (`service_identity_storage.rs:53–67, 120–135`).
  - Off macOS the secret store's data key returns `Unavailable` (`keychain_data_key.rs:164–185`).
  - CI's test job runs the Rust workspace on `ubuntu-latest` (`.github/workflows/ci.yml`).
  - There is no request-rate limit.
- **codex-router `main`:**
  - A create naming a creator on another Router is refused (`collaboration-client/src/conversation_client.rs:312–326`), and a Codex create needs a session as creator (`conversation_create_actor.rs:53–70`).
  - The fleet carries only messages, notifications, cancels and wakes between machines (`collaboration-mail-protocol/src/mail_content.rs:52`).
- **Better Auth 1.7.11:**
  - The device plugin takes one grant object with added request and persisted fields (`device-authorization/index.ts:137–192`).
  - `redeemDeviceCode` is exported, and redemption is `consumeOne`, a single conditional statement (`routes.ts:509–645`; `drizzle-adapter.ts:1078–1131`).
  - `issueTokens` takes a `referenceId` that the refresh token stores and restores (`types/index.ts:164–173`; `token.ts:594–640, 1957–1969`), and the claim contributor receives it (`types/index.ts:374–392`).
  - The first signed-in visitor claims a pending code's user slot (`routes.ts:866–885`), which is why the owner hooks guard verify, approve and deny.
- **The Tool Portal and sign-in repository** (agent-vm's repository until they move out):
  - Check gates are yours (`scripts/run-check-gate.ts`).
  - Heavy runs go to sunclaw, a Mac.

## Slices

**Every slice also passes its repository's existing gates, unchanged:**
- Tool Portal and sign-in repository: `pnpm check`, `pnpm typecheck`, `pnpm fmt:check`, and the vitest projects it touches. Heavy suites (workerd, `pnpm test:e2e:host`, whole sweeps) run on sunclaw.
- codex-router: `cargo check -p <crate>` and `cargo test -p <crate>` while building, then codex-router's required completion gates. On Apple Silicon these go through its signing runner. The Fleet Lead runs and accepts them, and nothing merges in codex-router without the Fleet Lead.
- No slice adds or changes a gate.

Each slice is one PR. "Earns" names the Verification Design rows whose passing condition the slice first meets and the command or journey that observes it. Focused proofs are the slice's own and never stand in for a row. Proof-layer names come from each repository: the vitest projects (`unit`, `integration`, `e2e-host`) and codex-router's `cargo test -p <crate>` plus `verify-codex-router` journeys.

### codex-router (Fleet Lead)

**F1 identity contracts (extended).**
- **Covers:** R26, plus:
  - the machine-login shapes: `MachineTokenClaims` and a `MachinePrincipal` kept outside the actor `Principal`, `DecideDeviceLogin`, `DeviceLoginDecision`, `DecideMachineToken`, `MachineTokenDecision` (with `decided_at`), `AdmitMachineConnection`, `MachineConnectionAdmission`, `MachineEnrollment` (reserved, approved, enrolled, revoked, expired), `AdmissionId`/`AdmissionRef`;
  - the view frames `Withheld` and `ScopeChanged`;
  - the remote-start shapes: `RequestRemoteStart`, `RemoteStartAdmission`, `StartRequestedSession`, `RemoteStartOutcome`, `RemoteStartStatus`, `ListWorkspaceMachines`, and the `remoteSession` starter.
- **New contracts:** K8 (device-login and machine-token decisions) and K9 (machine token claims), both homed here as JSON Schema with examples. The remote-start shapes stay inside codex-router.
- **Writes:** `collaboration-central-core/src/identity_contract.rs`, generated schema.
- **Earns:** SO6's Rust half; U1's focused parse cases.
- **Focused proof:**
  - **Wrong behaviors caught:** a closed variant serialized under a different tag than the Program Design names; `machine` parsing as an actor.
  - **Layer:** `cargo test -p collaboration-central-core` round trips.
  - **Oracle:** the Program Design's shapes.
- **Waits on:** F0; design approval.

**F2 organization authority (extended).**
- **Covers:** R5, R6, R7, R10, R13, R14, R20; R34 (organization-scoped rows; cross-organization references answer as unknown); R35–R37 (admission-keyed roles, OD5, readmission); the generalized `Collaboration`; the operator check through the sign-in service (built, enabled at PROD2).
- **Earns (SO4 named scenarios, on Tokio and local workerd):** U26/U36; U27's central half; U21's command and guard cases.
- **Focused proof:**
  - **Wrong behaviors caught:** a role that still counts after its admission ends; a reference to another organization answering differently from a missing one.
  - **Layer:** `cargo test -p collaboration-central-core organization_authority`.
  - **Oracle:** R34–R37.
  - **Property:** for any sequence of admit, grant, end and readmit, a role counts exactly while its admission ID is active.
- **Waits on:** F1; K5 and K6 from B3.

**F2b Fleet data per organization and the filtered view (new).**
- **Covers:** R34's storage separation (OD8) and U29's view:
  - the Fleet object addressed by organization, the first organization adopting today's storage through a fixed mapping on both hosts, and refusing the old address;
  - each machine's visible set, pushed by the organization authority;
  - directory, snapshot and feed filtered, with `Withheld` and `ScopeChanged`.
- **Writes:** `core_contract.rs` addresses, `call_graph.rs`, both hosts' object routing, the Fleet read paths.
- **Earns:** SO4 "one Fleet object per organization, read back after a restart" and SO4's filtered-view scenarios (U27/U29).
- **Focused proof:**
  - **Wrong behaviors caught:** the first organization's workspaces not found after the change; a snapshot leaking a paired workspace's boards; a withheld feed position breaking the cursor.
  - **Layer:** a migration test over a populated Fleet store on both hosts, then read-path tests per frame.
  - **Oracle:** today's rows, and the view contract.
- **Waits on:** F2.

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

**F10 machine enrollment and the machine token check (new).**
- **Covers:** R39, R40, R42 (central side), C9:
  - enrollments in the organization authority;
  - the Registry's `fleet_machines` index and the authorize, claim, then activate or cancel sequence, idempotent on the request ID;
  - reserved and approved enrollments, and supersession at an enrollment's first token;
  - the active-enrollment check on every decision;
  - `DecideDeviceLogin`, `DecideMachineToken`, `AdmitMachineConnection`, `RevokeMachineEnrollment`;
  - the token check for the sign-in service's machine tokens, refusing any other issuer;
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
    - a token for another organization, or from another issuer, admitted.
  - **Layer:** `cargo test -p collaboration-central-core machine_` with a controlled clock, reading both owners after each refusal.
  - **Oracle:** C9's accept and refuse lists, R39, R40.
  - **Property:** for any interleaving of two organizations' authorized attempts on one installation, at most one claim exists, and it belongs to an authorized attempt.
- **Waits on:** F2; K8 and K9 from F1; K10 from B5.

**F11 Router machine login (new).**
- **Covers:** R40, R41 (Router side):
  - the device-code flow run in the Router host, with `fleet login` asking the host and printing the code;
  - `RefreshCredentialKeeping` (`encryptedStore`, `memoryOnly`), chosen at host start and reported at login;
  - presenting and renewing the token;
  - applying `ScopeChanged` and `Withheld` to the replica;
  - deleting the old enrollment credential after a new login;
  - refusing a second organization.
- **Writes:** `codex-router-host` `fleet_machine_login`, `codex-router-cli`, the replica's feed consumer.
- **Earns (in SO8, with F14):** U33's Router half; R41's memory-only case.
- **Focused proof:**
  - **Wrong behaviors caught:** a second long-lived credential kept; the memory-only credential written to disk; the installation ID lost on re-login; a withheld position stalling the cursor.
  - **Layer:** `cargo test -p codex-router-host fleet_machine_login` with an injected store and clock.
  - **Oracle:** R40, R41, the view contract.
- **Waits on:** F1; F12 for Linux; B5 for the real flow (stand-in: a device-code server honoring C8 in tests, named unverified until SO8).

**F12 Router secret store, Linux backend (new).**
- **Covers:** R41 and R44 for the store. `systemd_credential_data_key.rs`: `read_secret` reads `$CREDENTIALS_DIRECTORY`, `add_secret` returns `Unavailable`. The installer step seals the key with `systemd-creds` and writes the unit's `LoadCredentialEncrypted=`. Without the credential, the Router keeps the refresh credential only in memory.
- **Earns:** SO9's Linux tests in codex-router's existing CI test job.
- **Focused proof:**
  - **Wrong behavior caught:** a plaintext fallback in a production build.
  - **Layer:** `cargo test -p codex-router-secret-store`, reading a credentials directory as systemd hands it over. The existing `ubuntu-latest` test job runs it with no workflow change.
  - **Oracle:** R41.
- **Waits on:** design approval.
- **Named unverified:** sealing with `systemd-creds` and running the Router as a service; no Linux job is added.

**F15 starting a session on another machine (new).**
- **Covers:** R46, R8's extension, C11:
  - the organization authority's admission of `RequestRemoteStart`, its remote-start records (`forwarded`, `started`, `refusedByTarget`, `refused`, `unknown`), and the lapse to `unknown` on a wake;
  - delivering `StartRequestedSession` through the target connection's delivery face, and the outcome back through the requester's;
  - accepting a `remoteSession` starter only for its own forwarded record;
  - `RemoteStartStatus` and `ListWorkspaceMachines`;
  - the Router's create path sending `RequestRemoteStart` for another machine, with the same-Router check kept for local creates;
  - the target's `StartRequestedSession` handler, creating through the session registrar with the central-vouched creator.
- **Writes:** `organization_authority` (`remote_start` table), the connection protocol's new frames, `collaboration-client` `conversation_client.rs`, `collaboration-service` (new `remote_session_start`).
- **Earns:** SO4's remote-start scenarios (U39's central half).
- **Focused proof:**
  - **Wrong behaviors caught:** a start delivered to a machine without an allowance for W; a refusal that reveals another organization's machine; a lapsed start redelivered; a `remoteSession` starter accepted without a forwarded record.
  - **Layer:** `cargo test -p collaboration-central-core remote_start` with a controlled clock, and `cargo test -p collaboration-client` for the create path.
  - **Oracle:** R46, C11's result table.
- **Waits on:** F2, F4, F10, F11.
- **Stop if:** the delivery face can't carry a request to the Router and its outcome back without a protocol version change. That is a design correction, routed back before this slice.

**F8 SO1 TypeScript journey (extended).** Two organizations; the Router logged in by device code (F14's arrangement); other-organization start and message; the replica read for the filtered view.
- **Earns:** U3/U17, U6/U32, U7/U8/U28, U19, U27/U29's Router half, U18.
- **Waits on:** F4, F11, F14.

**F9 SO4 conformance (extended).** Every new named scenario, on both central hosts.
- **Earns:** U9, U21/U31, U26/U36, U27/U29, U39's central half, U34's lasting negatives.
- **Waits on:** F2b, F3, F10, F15.

**F14 SO8 machine login journey (new, TypeScript).** `verify-codex-router` `fleet-machine-login`, including a Router host started with no encrypted store and restarted.
- **Earns:** U33/U31 (consumer side), U17/U33/U35 on macOS, and U14's renewal case.
- **Waits on:** F10, F11, B5.

**F16 SO11 remote start journey (new, TypeScript).** `verify-codex-router` `fleet-remote-start`: two Routers under isolated debug Hosts, a local Fleet central, a third Router in another organization; B creates a real Codex conversation (a provider account on the run machine, as SO1).
- **Earns:** U39.
- **Waits on:** F15, F14.

### Tool Portal and sign-in (Tool Portal Lead)

**B1 sign-in core and storage (extended).**
- **Covers:** R29–R33, with the device grant's `deviceCode` table (our four columns and `enrollmentId`) in the one schema module.
- **Earns:** U22, U23, U24 and U25 in SO2 on D1.
- **Waits on:** OD4.

**B2 sign-in Node host:** unchanged.

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
  - OD6's 10-minute lifetime;
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
- **Waits on:** JC2; your go.
- **If it breaks:** fix forward. There is no revert to the old login, because a machine revoked after the switch could regain access through it. Access still guards central meanwhile.

**PROD3 production step 3 (new; the next change; you run it).**
- **Covers:** R43 step 3 in production: delete the production Access application, and the Routers' Access headers and stored Access token.
- **Earns:** the step-3 production observation: every machine still connects; an unauthenticated request changes nothing.
- **Waits on:** PROD2 holding for a period you choose; your go.

**DONE (extended).**
- **Covers:** the orchestration's DONE, plus SO8 on macOS, SO9's Linux tests in codex-router's existing CI, and SO11.
- **Waits on:** JC2, B2, F7, F8, F9, F14, F16, P1.

## Dependency edges that matter

- **Contracts first:** F1 comes before every consumer of K2–K4, K8 and K9 (B4, B5, P1, F10). B5 produces K10 for F10's tests.
- **Storage before the Router's routing:** F2b comes before F4, because registration looks the project up in the organization's own Fleet object. Production waits on F2b too.
- **Machine login before the joint cut:** F10, F11 and B5 all come before JC1, because the test Router logs in the new way at the cut.
- **Remote start after registration and login:** F15 comes after F4 and F11, because the target registers the new session and both machines must be logged in.
- **Steps in order:** JC1 → JC2 → PROD2 → PROD3, each only after the previous step's observations pass.
- **The deploy hold:** the orchestration's hold before JC1 also covers B5. The sign-in Worker isn't deployed from master between B4 or B5 merging and JC1.

## Verification Design rows, scheduled

| Row | Slice that earns it | Command or journey | When |
|---|---|---|---|
| U1 | F1, B4 | `cargo test -p collaboration-central-core`; sign-in unit; SO6 | in each slice |
| U2 | B4, F2 | SO2; SO4 | B4; F9 |
| U3, U17 | F4, F11 | SO1, SO2, SO8; structural search | F8; F14 |
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
| U33, U31 | F10, F11, B5 | SO8; SO2; SO4 | F14 |
| U17, U33, U35 (R41) | F11, F12 | SO8; SO9 | F14; F12 |
| U34 | F10, JC1, JC2 | SO10 (temporary); SO4 | JC1; JC2 |
| U35 | F12, F14 | SO9 | F12; F14 (the end-to-end Linux login stays unverified, your call) |
| U37 | P1 | SO3 | P1 |
| U39 | F15, F16 | SO4; SO11 | F9; F16 |

## Existing tests these slices touch

| Existing tests | Slice | Disposition | Proof for a removal |
|---|---|---|---|
| codex-router `machine_enrollment.rs` tests of the enrollment credential and the Access-client match | F10 (old path kept behind `accessEnrollment` until PROD2) | keep through step 1; remove in the PROD2 change | dead contract: R43 retires the old login at step 2; F10's machine-token tests fail on the same wrong behavior (an unauthorized machine connecting) |
| codex-router `access_rules.rs` tests deriving the machine from the Access assertion | F10 | keep through step 1; remove in the PROD2 change | dead contract (R43 step 2); SO4's "same answer whatever Access identity" fails on a build that reads Access identity |
| codex-router `enrollment_prepare.rs` tests (operator token, expiry matching Access) | F10 | remove in the PROD2 change | dead contract: `EnrollMachine` is gone from step 2 |
| codex-router `keychain_data_key.rs` test that non-macOS returns `Unavailable` | F12 | repair: on Linux, `Unavailable` only when no systemd credential is present, and the Router then keeps memory only | — |
| codex-router Fleet read tests that assume every connection reads every record | F2b | repair: the same reads under a visible set that includes everything, plus new filtered cases | — |
| codex-router `collaboration-client` tests of the same-Router create check | F15 | keep for local creates; add remote-start cases beside them | — |
| sign-in integration tests on `node:sqlite` | B1 | repair onto `better-sqlite3` and D1, as the orchestration already plans | — |
| Portal membership and agent-management tests | P1 | remove | dead contract: R17 (token-only) and the Program Design's "Removed" list; SO3's refusal cases fail on a build that reads membership from the store |

## Integration gates

- **F10 with B5:** a real issuer's machine token first meets central's check. B5's examples (K10) are parsed in F10's tests; the real path is SO8 in F14.
- **F11 with F10 and B5:** SO8 is the first run of the whole device-code login across processes.
- **F2b with F11:** the replica first consumes `Withheld` and `ScopeChanged`, observed in F8's SO1 run.
- **F15 with two Routers:** SO11 is the first remote start across processes, with a real conversation created on the target.
- **JC1:** every cross-repository contract goes live together, now with machine login.

## Risks and false greens

- **F11 before B5:** if F11 merges first, its device-code flow is proven only against a stand-in. It stays named unverified until F14 runs against the real B5 issuer.
- **SO10 is temporary.** The step 2 and step 3 checks run once on the private stack; their lasting regression lives in SO4's entry negatives.
- **Linux:** the store and memory-only tests run on Linux, but the end-to-end login with the Router as a systemd service runs nowhere (no Linux job, your call). A Mac pass plus those tests must not be reported as the whole of U35.
- **A lost remote-start outcome:** the requester reports `unknown` while the session may exist on the target. SO11 step 3 checks that it is registered normally and findable.
- **`referenceId`:** if a later Better Auth changes how it is restored on refresh, renewals stop (they fail closed). SO2's rotation and restart cases catch it at an upgrade.
- **The orchestration hold:** a sign-in deploy from master between B5 and JC1 would ship the new dispatch alone. The hold covers B5.

## Stop and replan

- **Better Auth:** the device-code token handler can't be registered, or `referenceId` raises a consent requirement, at 1.7.11. Take the fallback, same rows.
- **Fleet replication:** the existing replica can't take a withheld position without a protocol version change. That is a design correction, routed back before F2b.
- **Remote start:** the connection's delivery face can't carry a start and its outcome without a protocol version change. That is a design correction, routed back before F15.
- **The Tool Portal and sign-in move out of agent-vm's repository:** the slices keep their content; their repository, gates and paths are re-anchored to the new home.
