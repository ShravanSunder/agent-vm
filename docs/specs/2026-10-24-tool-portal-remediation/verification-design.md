# Switchboard remediation: Verification Design

How each need in the [Requirements](requirements.md) will be shown to hold. Each row names what will be done and seen, judged against the [Specification](specification.md), at a seam the [Program Design](program-design.html) exposes. This is a plan: nothing in it has been run or observed yet.

**Where the proof runs:** the delivered commit of this work, on:

- the Cloudflare host in workerd through Miniflare (the release R18 selects), with real Durable Object SQLite;
- the Node host as a real Node 24 process with a real `better-sqlite3` file;
- the owner's private test Worker deployment ([plans/2026-10-21-private-worker-deploy.md](../2026-10-14-portable-tool-portal-hosts/plans/2026-10-21-private-worker-deploy.md)) for the rows that need the real platform.

Heavy runs go to sunclaw. No VM is involved. Every time-dependent case moves a controlled clock; no row waits on real time.

## What the owner will see proven

| Need | Proven by | Still unverified |
|---|---|---|
| **U1** One core, every runtime only injects | The same scripted session is played against the Cloudflare host and the Node host; their recorded answers (tools listed, call results, refusals, approval outcomes, analytics data points) are compared and must match exactly. The one exception is a limit: a scenario that crosses one must get the Worker's refusal on the Worker and a normal result on Node. The deployed Worker's limit checks are run again after the large-request change and the cutover. | Hosts other than these two; agent-vm's managed path, which keeps its own adapter |
| **U2** The core owns typed store operations and their one mapping | The same store test suite runs on Durable Object SQLite and on a `better-sqlite3` file through the one store implementation, and the hosts contain no store query. | — |
| **U3** Drizzle on SQLite only, with generated migrations | A scan of the Switchboard's code finds no key-value storage call, `node:sqlite`, Kysely, or SQL text executed outside the query builder; a database created at every earlier schema version opens, upgrades and keeps its records. | Remote D1 is not used by the Switchboard, so not tried |
| **U4** The owner approves the schema before code | The schema in the Program Design carries the owner's approval before the plan admits any store code. | — |
| **U5** Nothing that must survive is lost on restart | Approvals are used, the host is restarted (and the Worker redeployed), and the same approvals are presented again: each is refused as used, or answered "ambiguous" if it was armed. | A machine crash mid-write (power loss), beyond what SQLite's own durability settings give |
| **U6** Crypto is injected | The core runs with fake crypto that records every call; every digest, signature and verification goes through it, and a fixed-capability run gives the same bytes twice. | — |
| **U7** Type safety, discriminated unions, the type-check guard | The core is type-checked with no Node or Workers types and must pass; a deliberately forbidden import (including any Drizzle driver module) and an unhandled union variant must each fail that check. | Type errors hidden inside dependency declarations; deliberate casts |
| **U8** UUIDv7 only | Every identifier the Switchboard mints during the shared session is parsed and must be version 7; a scan finds no `randomUUID`. | Identifiers received from other services, which keep their own format |
| **U9** No wall clock in tests | A scan of the test files finds no wall-clock read, sleep or real-time deadline deciding an outcome, and no clock substitution in a production bundle. | Hang guards, pending RD4 |
| **U10** Gates as approved | The gate files are compared with master and must differ only by the approved type-check guard. | — |
| **U11** TypeScript verification | A scan finds no Python driving or asserting Switchboard behaviour outside the Python SDK's own tests. | — |
| **U12** One SDK generation; one version each | The lockfile and imports are scanned: one MCP SDK generation in product code; one esbuild, jose and vitest; no alpha Miniflare. | RD3 decides whether one test fixture may keep the old SDK |
| **U13** Known defects fixed | Each of the six findings gets a test that fails on `2dfea38e` and passes on the delivered commit. | — |
| **U14** Large requests streamed, not capped | A call with a 12 MiB argument completes on the private Worker and on Node with the same result as a small one; on Node with spilling enabled the spill file is private, outside durable state, and gone after every kind of ending (with spilling off, no file and the same result), including a crash and restart. | Concurrent large requests sharing one Worker isolate: the shared-failure limit R26 states, pending RD7 |
| **U15** Hegel property tests | Five Hegel property families run in Node against the real store implementation on both databases (a `better-sqlite3` file, and Durable Object SQLite reached through the test runtime's object stub), and against the canonical encoder and approval verifier. | Interleavings Hegel does not generate across separate OS processes (covered by the contention observation instead) |

## Shared observations

These are described once; the rows below name which obligations each one decides.

**O1 — Two-host conformance session** (needed journey `verify-tool-portal` › `conformance`, lasting: every later change to either host can make them drift.)
A fixed scenario script drives the MCP proxy way in on both hosts with the same workspace configuration, credentials, controlled clock, seeded UUIDv7 source and fixed key material. It records each exchange: `tools/list` in `direct` and `indirect`, search and describe, allowed calls, refused calls (unknown caller, wrong workspace, non-member, removed member, persona-narrowed tool), a call needing approval with and without a token, the same token twice, and the analytics data point each call writes. On Node it also drives the standalone Switchboard routes and stdio, which have no Cloudflare counterpart. The two MCP proxy transcripts are compared field by field after replacing only transport framing.

**Limit scenarios (F3).** Limit values are the one allowed difference between hosts (R1), so these scenarios carry each host's own expected answer instead of being compared for equality:
- a batch of 51 calls;
- seven concurrent calls against an upstream the fake server holds open;
- an upstream response one byte over 4 MiB;
- a reply over 16 MiB;
- a proxy approval presented with the approval-use cap full.

Expected: the upstream response over 4 MiB is refused on both hosts with the same code, because that limit is the engine's and shared (check 8). The batch of 51, the seventh concurrent call and the reply over 16 MiB get the limit refusal Switchboard check 15 defines on the Worker, each with its code, and the normal result on Node, which has none of those three (check 8). A full approval-use cap answers `saturated` on both hosts, at each host's own cap.
- **Entry:** HTTP to `/workspaces/‹id›/mcp` on workerd; HTTP to the Node listener; the Node standalone MCP and JSON routes.
- **Reads:** response bodies, status codes, refusal codes, and the analytics sink's recorded data points.
- **Deployed limits again:** the deployed row 15 checks on the private test Worker (batch size, upstream response size and the six in flight, which cycle 6 did not run) are run again after slice A7 (large requests) and after A8 (the cutover), because R26 rewrites the request path in front of those limits.

**O2 — Restart and redeploy** (needed journey `verify-tool-portal` › `restart`, lasting.)
- **Node:** present a proxy token once, reserve and arm a batch approval, and reserve a second batch approval without arming it. Stop the process, start it again on the same `stateDirectory` and configuration, and present all three again.
- **Cloudflare in workerd:** the same steps, with Miniflare's persisted Durable Object storage directory kept across the runtime restart.
- **Private test Worker:** present, redeploy the same build, present again.
- **Reads:** each answer after the restart, and the store rows. The rows are read by the test harness with no production surface (R14):
  - **Node:** the harness opens the store file directly, read-only, with its own `better-sqlite3` connection;
  - **workerd:** the harness uses the test runtime's direct Durable Object access (for example vitest-pool-workers' `runInDurableObject`) to read the object's SQLite;
  - **private Worker:** answers only. A deployed Worker exposes no row reads, and none is added.

**O3 — Contention** (needed journey `verify-tool-portal` › `contention`, lasting.) Present one approval many times at once:
- through two or more Worker copies on the private test Worker (the existing row 13 cross-copy check is the starting point);
- through two Node processes sharing one `stateDirectory`;
- through many concurrent requests in workerd.

It counts the `first-use` answers and the upstream effects the fake upstream server records. It also replays removal notices in a shuffled order with repeats once store version 2 exists.

Removal subject cases (F4), once store version 2 exists:
- For one bot, one session and one machine, a notice and a token are each reduced by `deriveRemovalSubjectKey` and `coveringRemovalSubjectKeys`, and the keys must be equal.
- A notice for a machine is then recorded, and a session token on that machine must be refused.
- A session token on another machine must still pass.

**Wrong builds that fail:** a receiver that keys the notice by Fleet's internal session reference while the caller check keys the token's session tuple (the session token passes after its notice); a caller check that passes only the session key (the machine notice never covers its sessions).

Expiry cases (SEC-01, OBS-01), with controlled clocks on both hosts:
- **Held past expiry:** an approval that has already had its one effect is replayed by two requests. Both are held after the front verifier and released after expiry by the store's clock. This is done for the proxy token and for batch reserve and arm.
- **Clock offsets:** the verifier's clock is ahead of the store's, then behind it.
- **Step back:** the store's clock steps forward past expiry, the row is pruned, the clock steps back, and the approval is presented again, also across a restart.
- **Mismatched open:** a store database opened with another workspace's identifier.
- **Late-minted workspace token (OBS-01):** a covered session token whose `grant_expires_at` is minute 60 and whose `exp` is minute 62. Its removal mark is pruned just after minute 61. All clocks then step back by the same amount to before minute 60, and the token is presented again, also after a restart. The caller check passes `min(grant_expires_at, exp + 60 s)` as `tokenExpiresAtMs`.

Passes when there are **zero additional upstream effects** in every case, with branch-specific answers: a late proxy presentation or batch reservation answers `expired`; an arm after expiry answers `not-dispatched` (`expired-before-arming`) for a still-reserved row and `ambiguous` for an already-armed one; the late-minted token's mark read answers `expired`; the mismatched open answers `workspace-mismatch`. A build that passes raw `exp` as `tokenExpiresAtMs` fails the late-minted case (the pruned mark is gone and minute 62 is still ahead of security time). **Wrong builds that fail:** one that prunes before checking the presentation's expiry (a second `first-use` and a second effect after the held release); one that uses the raw clock instead of the stored security time (step-back resurrects the token); one that ignores `store_meta` (a second workspace reads the first's rows).

**O4 — Hegel store properties** (no journey: decided by property tests in the core's suite, run on both databases.)
The stateful model test that exists today (`tool-host-core/src/workspace-authority/workspace-authority.stateful.unit.test.ts` at `2dfea38e`) runs against the in-memory volatile store. It is re-pointed at the Drizzle store with the controlled clock, on both databases. Hegel always runs in Node, because it loads native code through FFI (`koffi`, lockfile at `2dfea38e`). That it cannot load inside a workerd isolate is inferred from that dependency, not observed. So:
- **`better-sqlite3`:** Hegel drives `createWorkspaceStore` on a file directly.
- **Durable Object SQLite:** Hegel drives `WorkspaceStoreObject`'s own methods through the test runtime's Durable Object stub, one generated step per call, with the object running in workerd. A restart step restarts the test runtime on its persisted storage.

Families:

1. Proxy token one-use under arbitrary presentation orders, expiries, holds between verification and the store, and clock steps forward and back: the model counts effects, and an Approval never has more than one.
2. The batch approval lifecycle with a restart inserted at any step.
3. Removal marks under arbitrary orders and repeats (store version 2), with notices and tokens generated for bots, sessions and machines: the mark a token reads equals the model's highest mark over its covering keys.
4. Store results matching a pure model after any operation sequence.
5. Canonical encoding: equal data under shuffled keys and any collation gives equal bytes.

**O5 — Structural scans** (no journey: structural evidence.) Source and manifest scans of the Switchboard packages and their tests, the lockfile, and the gate files, each named in its row with the behaviour it leaves unevaluated.

**O6 — The type-check guard** (no journey.) The core packages' guard configuration is run; then a deliberately forbidden import and an unhandled variant are introduced in a throwaway branch of the check and must each fail it.

**O7 — Storage cutover on the private test Worker and a Node host** (needed journey `verify-tool-portal` › `cutover`, temporary: it runs once, at the cutover.)
1. **Before the cutover:** use an approval on the old Worker, and a batch approval on the old Node host, and keep both tokens.
2. **Deploy:** the new object class with rotated approval keys; the Node host with rotated standalone HMAC credentials.
3. **Re-add members:** re-add each workspace's members through the management route.
4. **Then, three checks:**
   - **positive control:** a member gets a fresh approval, and its call succeeds exactly once;
   - **old Worker token:** presented again, it fails at approval verification (signature), not at membership;
   - **old Node batch token:** presented again, it fails the same way.
   The upstream server records zero effects for both old tokens.

**The same check at the second storage change (F15, R9).** Store version 2 re-keys approval rows by principal and deletes the existing ones at the identity joint cut. So O7 runs a second time there, on the private stack, as part of that cut:
- before the cut, a proxy approval is used on the Worker and a batch approval on a Node host, and both tokens are kept;
- the cut deploys store version 2 with the approval keys rotated on the Worker and on every Node host;
- after it, a fresh approval for a member works exactly once (the positive control), and both kept tokens fail at approval verification with zero upstream effects.

**Wrong build that fails:** a version 2 migration deployed without rotating the Node host's keys. The Node batch token's row is gone, so the token is accepted again. The incidental `agent-mismatch` refusal at `2dfea38e` is not counted as the control, because the design rests on rotation.

## Rows

### U1 — One core, every runtime only injects

| | |
|---|---|
| **Requirement** | U1 → R1 (every rule in the core: same outcomes on both hosts), R2 (the Node host runs the core) |
| **Proven by** | The same scripted session is played against both hosts, and their answers must match exactly. |
| **Reference** | The Switchboard Specification's checks 1–17 for each scenario's expected answer; R1's list of rules; the transcript of the other host for equality |
| **Target and journey** | Cloudflare host in workerd and Node host process, delivered commit, the conformance configuration; O1 (`needed:` `verify-tool-portal` › `conformance`, driving both hosts' HTTP entries and reading responses and analytics data points) |
| **Lifetime** | lasting |
| **Passes when** | Every MCP proxy exchange in O1 is equal on both hosts, except the limit scenarios. Each of those gets its own host's expected answer: the Worker refuses with the check 15 code; Node returns the normal result. Every Node-only route answers as the Switchboard Specification says. The deployed row 15 limit checks pass again after A7 and after A8. **Wrong builds that fail:** a Node host that keeps its own approval list or gateway (it answers a repeated token differently after the O2 restart, and its analytics data point lacks a field the core writes); a Node host given the Worker's limits (its 51-call batch is refused, breaking check 8); a Worker whose limits were lost with the old request path (the deployed rerun accepts a 51-call batch). **Allowed different build that passes:** a host that supplies a different transport framing. |
| **Reuses** | none: the existing Node and Cloudflare suites at `2dfea38e` test each host's own composition, which is the duplication being removed |
| **Unverified** | agent-vm's managed adapter path (out of scope); hosts other than these two |

### U2 — The core owns typed store operations and their one mapping

| | |
|---|---|
| **Requirement** | U2 → R4 (typed operations, one Drizzle mapping, owned by the core) |
| **Proven by** | One store test suite runs on both databases through the one store implementation; a scan finds no store query in either host. |
| **Reference** | The `WorkspaceStore` interface and its result unions in the Program Design |
| **Target and journey** | The core's store suite on a `better-sqlite3` file and on Durable Object SQLite in workerd; O4 and O5; journey: none |
| **Passes when** | Every store case gives the same result union on both databases, and O5 finds no Drizzle query builder or SQL in `tool-host-cloudflare` or `tool-host-node` apart from opening the database and running the migrator. **Wrong build that fails:** a Cloudflare host that writes its own approval query. **Allowed build that passes:** a host that opens the database with different pragmas. |
| **Reuses** | none |
| **Unverified** | — |

### U3 — Drizzle on SQLite only, with generated migrations

| | |
|---|---|
| **Requirement** | U3 → R5 (only the chosen databases), R6 (generated, checked-in migrations, applied once) |
| **Proven by** | A scan finds no forbidden storage API, and databases created at every earlier schema version open, upgrade and keep their records on both hosts. |
| **Reference** | R5's forbidden list; the checked-in migration journal; the records written before upgrade |
| **Target and journey** | O5 for R5. For R6: an upgrade case per earlier schema version on each database, and structural evidence for "nothing served before migration". Journey: none, decided by the store suite run on both databases. |
| **Passes when** | **R5:** the scan of the Switchboard packages finds none of:<br>• `ctx.storage.get/put/list/delete/transaction` on key-value storage;<br>• `node:sqlite` or Kysely;<br>• SQL-text execution: `sql.raw(`, `.sql.exec(`, `.run(sql`, `.all(sql`, `.get(sql`, `.values(sql`, a driver's `.prepare(` or `.exec(`.<br>Every `sql` template that remains sits inside a query-builder call (`.set(`, `.where(`, `.values(`, `.select(`) with bound values; each is listed for review.<br>**R6:** every earlier-version database reaches the latest version with identical records, and each database shows one `__drizzle_migrations` history. A request cannot be served before migration, for a structural reason that the review reads in the delivered code: on the Durable Object, `migrate` runs inside `ctx.blockConcurrencyWhile` in the constructor, which holds every request until it returns or throws; on Node, the listener is created only after `migrate` returns. No test-only hook is added to hold a migration open, because that would be a production export for tests (R14). **Wrong builds that fail:** a host that serves before migrating (the structural reading finds the listener or the RPC method reachable before `migrate`); a migration applied twice (two history rows); a store that runs `db.run(sql\`insert …\`)` (the scan). |
| **Reuses** | none |
| **Unverified** | Only one earlier version exists at first (version 1); the version-2 upgrade is proven when the identity cutover adds it |

### U4 — The owner approves the schema before code

| | |
|---|---|
| **Requirement** | U4 → R6's owner gate |
| **Proven by** | The schema and migrations in the Program Design carry the owner's recorded approval before the plan admits store code. |
| **Reference** | The owner's approval on RD1 |
| **Target and journey** | The design documents and the plan's admission record; journey: none |
| **Passes when** | RD1 is recorded as decided by the owner, with the schema version it approved, before any store slice starts, and the built schema matches that version. **Wrong build that fails:** a store slice started before RD1. |
| **Reuses** | none |
| **Unverified** | — |

### U5 — Nothing that must survive is lost on restart

| | |
|---|---|
| **Requirement** | U5 → R7 (what survives a restart), R8 (atomic decisions), R9 (no approval revived at cutover) |
| **Proven by** | Approvals are used, the host restarted or redeployed, and the same approvals presented again; many simultaneous presentations of one approval get exactly one acceptance; a token used before the storage change is refused after it. |
| **Reference** | R7's three after-restart answers; R8's "exactly one first use"; R9's pass condition |
| **Target and journey** | Node process, workerd and the private test Worker; O2 (`needed:` `restart`), O3 (`needed:` `contention`), O7 (`needed:` `cutover`) |
| **Lifetime** | `restart` and `contention` lasting; `cutover` temporary |
| **Passes when** | **O2:** after the restart, the used proxy token is `already-used`, the armed batch approval is `ambiguous` and the reserved one is `already-consumed`, and nothing is dispatched. **O3:** exactly one `first-use` across all copies and processes; the removal subject keys match, and a machine notice refuses that machine's session token. **O7:** at each storage change, the fresh approval's call succeeds once; both kept tokens fail at approval verification with zero upstream effects. **Wrong builds that fail:** today's Node host (its batch-approval records are a `Map` and its generation comes from configuration, so after restart the token is accepted again); a store that checks then inserts in two transactions (two first uses under O3); a cutover that keeps the old keys (the kept token passes verification); a cutover that forgets to re-add members (the positive control fails, so an old-token refusal can't be mistaken for success). |
| **Reuses** | none counted. The existing deployed row 13 check (cross-copy one-use, `tool-host-cloudflare/src/deployed-checks/deployed-check-suites/`) is the starting point for O3 on the Worker; it counts only once re-pointed at the remediated Worker and read again. |
| **Unverified** | power loss mid-write; removal-mark durability until store version 2 |

### U6 — Crypto is injected

| | |
|---|---|
| **Requirement** | U6 → R3 (runtime only through capabilities) |
| **Proven by** | The core runs with fake crypto, clock and identifier capabilities that record every call; every crypto operation goes through them, and two runs give the same bytes. |
| **Reference** | R3's pass and fail conditions; the `PortalPlatform` contract |
| **Target and journey** | The core's suite with recording capabilities, plus O6 for the static half; journey: none |
| **Passes when** | Every digest, HMAC and signature check in the O1 scenarios appears in the recording, and two runs produce byte-identical tokens, fingerprints and responses. The injected adapters are trusted components, so each real adapter is also run, on both hosts, against fixed known-answer and tamper vectors:<br>• SHA-256 and HMAC-SHA-256 known answers;<br>• an HMAC with one byte changed is refused;<br>• JWS vectors with a valid signature, a changed signature and a disallowed algorithm, each checked against the one key passed in;<br>• a key-set fetch that fails, which the key-set adapter answers `unavailable`, and which the core turns into an unauthenticated refusal, never verified.<br>**The issuer key cache, with the controlled clock (F6):**<br>• a token is verified, the issuer's key is withdrawn, and the clock is moved to 4 minutes 59 seconds: the cached key still verifies;<br>• the clock is moved past 5 minutes: the next verification fetches again and refuses the withdrawn key;<br>• a token with an unknown `kid` causes exactly one refetch, recorded by the key-set capability, then a refusal.<br>Nothing waits on real time.<br>**Wrong builds that fail:** a core function that calls `globalThis.crypto.subtle` directly, whose digest never appears in the recording; an adapter that returns verified on a tampered signature or on a key-fetch failure; a key cache inside the adapter on its own clock (moving the controlled clock past 5 minutes does not refetch, and the withdrawn key still verifies). **Allowed build that passes:** web-platform adapters using a different crypto library. |
| **Reuses** | none |
| **Unverified** | a malicious host, which controls execution and can bypass the core; no in-core check can contain it (the trusted-base limit in Program Design, "Security and the other qualities") |

### U7 — Type safety, discriminated unions, the type-check guard

| | |
|---|---|
| **Requirement** | U7 → R10 (discriminated unions), R11 (the core type-checks without runtime types) |
| **Proven by** | The core is type-checked with no Node or Workers types and must pass; a forbidden import and an unhandled union variant must each fail. |
| **Reference** | R10's listed unions; R11's forbidden imports |
| **Target and journey** | The core packages at the delivered commit; O6; journey: none |
| **Passes when** | The guard passes on the delivered code, including a module that imports `drizzle-orm` and `drizzle-orm/sqlite-core`. Each of these, added to a core module, makes it fail:<br>• `import 'node:crypto'`<br>• `import 'cloudflare:workers'`<br>• `import { drizzle } from 'drizzle-orm/better-sqlite3'`, and the same from `drizzle-orm/durable-sqlite`, `drizzle-orm/d1` and `drizzle-orm/libsql` (the sentinel's error)<br>• a side-effect `import 'drizzle-orm/better-sqlite3'` and a type-only `import type * as X from 'drizzle-orm/durable-sqlite'`<br>• `/// <reference types="node" />` (caught by the declaration inventory)<br>• `Date.now()`, `new Date()`, `Math.random()`, `setTimeout(...)`, `crypto.subtle`, `AbortSignal.timeout(1)`<br>Adding a variant to `ProxyTokenPresentation` without handling it makes the type-check fail at each switch.<br>The experiment already observed the mechanisms: the custom library's TS2339 for no-argument `Date.now()` (`report-2.md` §2), and the sentinel rejecting all four driver subpaths and the side-effect and type-only case while the allowed program compiles (`experiment-3-driver-subpaths/driver-subpath-probe.log`). This row repeats them on the delivered guard.<br>**Wrong builds that fail:** a core that compiles only because Node types are visible; a guard without the `paths` allowlist (each driver import compiles, exit 0, as observed); an allowlist pointing at a missing file (TypeScript falls back to `node_modules`, so the imports compile). |
| **Reuses** | none |
| **Unverified** | type errors inside dependency declarations, which `skipLibCheck` hides; deliberate casts and `any` |

### U8 — UUIDv7 only

| | |
|---|---|
| **Requirement** | U8 → R12 (every Switchboard identifier is a UUIDv7) |
| **Proven by** | Every identifier the Switchboard mints during the shared session must parse as version 7, and a scan finds no `randomUUID`. |
| **Reference** | RFC 9562 version 7 layout |
| **Target and journey** | O1 transcripts (operation ids, receipt references, approval token ids, correlation ids) and O5; journey: O1 |
| **Lifetime** | lasting (O1) |
| **Passes when** | Every minted identifier in O1 parses as version 7, and O5 finds no `randomUUID(` or other UUID version call in Switchboard code or tests. **Wrong build that fails:** today's `newId: crypto.randomUUID`, which mints version 4. |
| **Reuses** | none |
| **Unverified** | identifiers received from sign-in or Fleet |

### U9 — No wall clock in tests

| | |
|---|---|
| **Requirement** | U9 → R13 (no wall-clock time in tests), R14 (time controlled only through the clock capability) |
| **Proven by** | A scan of the test files finds no wall-clock read, sleep or real-time deadline deciding an outcome; a scan of production bundles finds no clock substitution or test entry. |
| **Reference** | R13's fail list; the 23 clock-dependent and 10 timestamp sites the evidence lists at `2dfea38e`, each of which must be gone |
| **Target and journey** | O5 over the test files of the Switchboard packages and the built production bundles; journey: none |
| **Passes when** | No test file calls `Date.now()`, no-argument `new Date()`, `performance.now()`, or a real timer to compute an expected value, an expiry or a deadline. The built Worker and Node bundles contain no `Date.now` replacement, no test-only route and no test-only export. **Wrong build that fails:** today's `worker-approval.host.e2e.test.ts:19–20`, which issues tokens from the real Worker clock. |
| **Reuses** | none |
| **Unverified** | timeouts that only fail a hung external process, until RD4 is decided |

### U10 — Gates as approved

| | |
|---|---|
| **Requirement** | U10 → R19 (the owner's gates, as approved) |
| **Proven by** | In agent-vm, the root gate files are compared with `38569fca` and must match, with #262's 26 scripts gone (RD5). In `agent-collaboration`, the checks are compared with the commands the moved packages ran under agent-vm's gate at `38569fca` and must differ only by the approved type-check guard. |
| **Reference** | `scripts/run-check-gate.ts`, `vitest.config.ts`, the root `package.json` scripts and `.github/workflows/` at `38569fca`; the guard step |
| **Target and journey** | O5; journey: none |
| **Passes when** | agent-vm's root gate files equal `38569fca`, and none of the 26 scripts #262 added remains unless RD5 kept it. `agent-collaboration`'s checks are the moved packages' commands plus only the guard step and its configuration files. **Wrong build that fails:** today's `portal-exports` step change, in either repository. |
| **Reuses** | none |
| **Unverified** | — |

### U11 — TypeScript verification

| | |
|---|---|
| **Requirement** | U11 → R16 |
| **Proven by** | A scan finds no Python driving or asserting Switchboard behaviour outside the Python SDK's own tests. |
| **Reference** | R16 |
| **Target and journey** | O5 over agent-vm's Python files touched by this work and `agent-collaboration`'s TypeScript host tests; journey: none |
| **Passes when** | `python/agent-vm-agent-portal-sdk/tests/mcp_node_host_journey.py`'s wire and protocol assertions live in a TypeScript host test. Any remaining Python only calls the Python SDK's public API in its own suite. **Wrong build that fails:** the journey script kept as the Switchboard's protocol proof. |
| **Reuses** | none |
| **Unverified** | — |

### U12 — One SDK generation; one version each

| | |
|---|---|
| **Requirement** | U12 → R17, R18 |
| **Proven by** | `agent-collaboration`'s lockfile and imports are scanned. agent-vm's remaining 1.x uses are checked when #255's cleanup lands (OD-R4). |
| **Reference** | R17, R18; RD3's decision |
| **Target and journey** | O5 over `agent-collaboration`'s lockfile and every `import` in its product code; journey: none |
| **Passes when** | No product module imports `@modelcontextprotocol/sdk`. The lockfile resolves one version each of esbuild, jose and vitest, and no Miniflare version ending in `-alpha`. **Wrong build that fails:** today's three `jose` versions. |
| **Reuses** | none |
| **Unverified** | the fixture exception, pending RD3; agent-vm's 1.x SDK in `gateway-runtime` and the two old packages, until #255's cleanup (OD-R4) |

### U13 — Known defects fixed

| | |
|---|---|
| **Requirement** | U13 → R20, R21, R22, R23, R24, R25 |
| **Proven by** | Each finding gets a focused test that fails on `2dfea38e` and passes on the delivered commit. |
| **Reference** | Each R's own pass condition |
| **Target and journey** | Each owning module's focused test (Program Design, "The defects and their owners"); R24 also by O4 family 5; journey: none |
| **Passes when** | **R20:** a quick Google command with `timeoutMs` is refused at admission. **R21:** in a batch where one call's assessment throws, approval-free siblings run and only that call is refused. **R22:** the published `mcp_portal_call` schema validates an input carrying `portalApprovalToken`. **R23:** loading a configuration whose origin has a path fails with the field named. **R24:** keys differing only by collation produce one fingerprint. **R25:** the wrapped client receives the callback's second argument. **Wrong build that fails:** each test on `2dfea38e`. |
| **Reuses** | none |
| **Unverified** | — |

### U14 — Large requests streamed, not capped

| | |
|---|---|
| **Requirement** | U14 → R26 |
| **Proven by** | A tool call carrying a 12 MiB argument completes on the private test Worker and on Node with the same result as a small one. On Node with spilling enabled, the temporary file is seen while the request is read and gone afterwards; with spilling off, no file is written and the call still completes. |
| **Reference** | R26's pass condition; the call's result at a size under 4 MiB, taken as the expected result for the same tool and arguments structure |
| **Target and journey** | Private test Worker and the Node host process, delivered commit. `needed:` `verify-tool-portal` › `large-request`: drives one call at 3 MiB, 5 MiB and 12 MiB through the MCP proxy entry; keeps each raw response (status, headers, body, CF-Ray) and the `wrangler tail` invocation outcome; on Node, lists the spill directory during and after the call. |
| **Lifetime** | lasting |
| **Passes when** | All three calls return the tool's normal result. No response is a Switchboard size refusal or a 502. On Node with spilling enabled, these spill checks hold (SEC-04):<br>• The spill file exists during the 12 MiB call, in the spill directory and not under `stateDirectory`. It has mode `0600` in a `0700` directory.<br>• The file is gone after the call, after a client abort mid-upload, and after a malformed tail. A malformed tail also produces no upstream effect.<br>• After a host killed mid-upload restarts, the dead process's spill directory is removed, including when an unrelated live process now has the dead one's process id (a different start time). A second live process's spill directory is not removed.<br>• A planted approval token and argument value from the request appear nowhere under `stateDirectory` afterwards.<br>• With a declared separate allocation domain, filling it fails only that request, and a store decision made at the same time still succeeds. With no capacity declaration, including a spill parent on a different volume of the same disk, the host reports spilling off at startup and a large body is parsed in memory instead. A declaration on the same device as `stateDirectory` is refused at startup.<br>**Wrong builds that fail:** today's handler path, which answers 413 at 4 MiB; a Node build with spilling enabled that buffers in memory and leaves no spill file; a Node build with spilling off that writes a file or refuses the call; one that spills under `stateDirectory`; one with no startup cleanup, which leaves the killed process's file behind. **Allowed build that passes:** a different streaming parser. Before building, the same journey takes the one correlated observation of today's 502 (Program Design, "Large requests", step 4). |
| **Reuses** | none: today's `row-15-limits` check asserts a 413, which R26 replaces, and keeps no response details |
| **Unverified** | requests near the account ceiling (100 MB) and near isolate memory. Concurrent large requests from two workspaces in one isolate, and many-field or deep objects, are not proven safe: under RD7 option A they are the accepted shared-failure limit R26 states. Under option B they become a required observation in the same isolate, with memory, invocation outcomes and effect counts kept. Three calls that land in different isolates prove nothing about this. |

### U15 — Hegel property tests

| | |
|---|---|
| **Requirement** | U15 → R15 |
| **Proven by** | Five Hegel property families run in Node against the real store on both databases (directly on a `better-sqlite3` file; through the test runtime's Durable Object stub for Durable Object SQLite), and against the canonical encoder and approval verifier. |
| **Reference** | R15's five families; the pure models each family compares against |
| **Target and journey** | O4; journey: none |
| **Passes when** | All five families exist, run on both databases where they touch storage, and compare against a pure model. On the Durable Object, each generated step is one call to `WorkspaceStoreObject`'s own method through the stub, so the object's real transaction runs. A mutant store that inserts first use after checking in a separate transaction is caught by family 1, as is a canonical encoder that uses `localeCompare` by family 5. **Wrong builds that fail:** today's stateful test, which runs only on the volatile store, so it says nothing about either database; a suite that runs the Durable Object half against `better-sqlite3` and calls it Durable Object coverage (no stub call reaches workerd). |
| **Reuses** | the existing stateful test's model and generators, once re-pointed |
| **Unverified** | separate OS processes, which O3 covers |

## Coverage for review and the plan

| U | R | Seam (Program Design trace) | Observation | Target / journey or test | Passing condition | Unverified |
|---|---|---|---|---|---|---|
| U1 | R1 R2 | conformance suite against both hosts, with limit scenarios; Node process proof; deployed row 15 rerun | O1 | workerd + Node · `conformance` (needed, lasting); private Worker row 15 checks after A7 and A8 | transcripts equal except limits; each host's own limit answer; Node-only routes per spec | managed path |
| U2 | R4 | the same store suite on both databases | O4, O5 | store suite · none | same results; no host query | — |
| U3 | R5 R6 | source scan (storage APIs and SQL-text execution); upgrade run; structural reading of migrate-before-serve | O5, upgrade cases | store suite · none | no forbidden API or SQL text; upgrades keep records; migrate runs before any request can be served | version-2 upgrade later |
| U4 | R6 gate | owner approval | design record | — | RD1 decided before store code | — |
| U5 | R7 R8 R9 | restart and redeploy runs; contention, expiry and subject-key runs; cutover run at both storage changes | O2, O3, O7 | Node, workerd, private Worker · `restart`, `contention` (lasting), `cutover` (temporary, run at each change) | used/ambiguous/consumed after restart; one first use; zero extra effects after expiry; one key per subject; old token fails on every host | power loss; marks until v2 |
| U6 | R3 | fixed-capability determinism run; real-adapter vectors; issuer key cache with the controlled clock; type-check guard | recording capabilities, O6 | core suite · none | every crypto call recorded; identical bytes; vectors pass; cache refetches past 5 minutes and once on an unknown key | malicious host |
| U7 | R10 R11 | type tests; guard run with the Drizzle `paths` allowlist | O6 | core packages · none | guard passes; forbidden imports (including every driver subpath) and unhandled variant fail | dependency declarations under `skipLibCheck`; casts |
| U8 | R12 | minted ids parsed; source scan | O1, O5 | `conformance` | all v7; no `randomUUID` | received ids |
| U9 | R13 R14 | test-file scan; bundle scan | O5 | scans · none | no wall-clock reads; no substitution | hang guards (RD4) |
| U10 | R19 | gate diff in both repositories | O5 | agent-vm's root gate files vs `38569fca`; `agent-collaboration`'s checks vs the moved packages' commands · none | agent-vm equal; agent-collaboration differs by the guard only | — |
| U11 | R16 | Python scan | O5 | Python files · none | no Python Switchboard verification | — |
| U12 | R17 R18 | lockfile and import scan in `agent-collaboration` | O5 | its lockfile · none | one generation; one version each; no alpha | RD3; agent-vm's part until #255 (OD-R4) |
| U13 | R20–R25 | each defect's focused case | focused tests, O4 family 5 | owning modules · none | each fails before, passes after | — |
| U14 | R26 | the U14 row: 3, 5 and 12 MiB calls; spill cases | raw responses, `wrangler tail` outcomes, spill directory listings | private Worker and Node host · `large-request` (needed, lasting) | normal result; no Switchboard 413 or 502; with spilling enabled, spill file private, outside `stateDirectory`, removed on every end; with spilling off, no file | same-isolate concurrency (RD7) |
| U15 | R15 | Hegel families in Node on both databases; Durable Object through the test runtime's stub | O4 | core suite · none | five families vs pure models; mutants caught | separate processes |

## Journeys this needs

The project has no `verify-tool-portal` skill yet; only `verify-auth` exists. These journeys are needed, and the lasting ones are built before any observation depends on them:

| Journey | Lifetime | Drives | Reads |
|---|---|---|---|
| `conformance` | lasting | both hosts' MCP proxy HTTP entries; Node's standalone routes and stdio | responses, refusal codes, analytics data points, minted identifiers |
| `restart` | lasting | Node process stop/start on one `stateDirectory`; workerd restart with persisted storage; private Worker redeploy | answers after restart; store rows read by the harness (Node: the file opened read-only; workerd: the test runtime's direct Durable Object access); no production read surface |
| `contention` | lasting | concurrent presentations across Worker copies, Node processes and workerd requests; held-past-expiry, clock-offset and step-back cases; removal notices for bots, sessions and machines | count of `first-use` answers; upstream effect counts; subject keys and refusals |
| `cutover` | temporary, run at each storage change | approvals used on the old Worker and a Node host, then the remediation deployed (and later store version 2 at the joint cut), with keys rotated | the kept tokens' answers; the fresh approval's single effect; upstream effect counts |
| `large-request` | lasting | the MCP proxy entry on the private Worker and the Node host, at 3, 5 and 12 MiB, with abort, malformed tail, killed-process restart and a full spill directory on Node | raw response (status, headers, body, CF-Ray), `wrangler tail` invocation outcome, spill directory and `stateDirectory` listings |
