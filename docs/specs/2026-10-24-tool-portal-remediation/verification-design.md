# Tool Portal remediation: Verification Design

How each need in the [Requirements](requirements.md) will be shown to hold. Each row names what will be done and seen, judged against the [Specification](specification.md), at a seam the [Program Design](program-design.md) exposes. This is a plan: nothing in it has been run or observed yet.

**Where the proof runs:** the delivered commit of this work, on:

- the Cloudflare host in workerd through Miniflare (the release R18 selects), with real Durable Object SQLite;
- the Node host as a real Node 24 process with a real `better-sqlite3` file;
- the owner's private test Worker deployment ([plans/2026-10-21-private-worker-deploy.md](../2026-10-14-portable-tool-portal-hosts/plans/2026-10-21-private-worker-deploy.md)) for the rows that need the real platform.

Heavy runs go to sunclaw. No VM is involved. Every time-dependent case moves a controlled clock; no row waits on real time.

## What the owner will see proven

| Need | Proven by | Still unverified |
|---|---|---|
| **U1** One core, every runtime only injects | The same scripted session is played against the Cloudflare host and the Node host; their recorded answers (tools listed, call results, refusals, approval outcomes, analytics data points) are compared and must match exactly. | Hosts other than these two; agent-vm's managed path, which keeps its own adapter |
| **U2** The core owns typed store operations and their one mapping | The same store test suite runs on Durable Object SQLite and on a `better-sqlite3` file through the one store implementation, and the hosts contain no store query. | — |
| **U3** Drizzle on SQLite only, with generated migrations | A scan of the Tool Portal's code finds no key-value storage call, `node:sqlite`, hand-written SQL or Kysely; a database created at every earlier schema version opens, upgrades and keeps its records. | Remote D1 is not used by the Portal, so not tried |
| **U4** The owner approves the schema before code | The schema in the Program Design carries the owner's approval before the plan admits any store code. | — |
| **U5** Nothing that must survive is lost on restart | Approvals are used, the host is restarted (and the Worker redeployed), and the same approvals are presented again: each is refused as used, or answered "ambiguous" if it was armed. | A machine crash mid-write (power loss), beyond what SQLite's own durability settings give |
| **U6** Crypto is injected | The core runs with fake crypto that records every call; every digest, signature and verification goes through it, and a fixed-capability run gives the same bytes twice. | — |
| **U7** Type safety, discriminated unions, the type-check guard | The core is type-checked with no Node or Workers types and must pass; a deliberately forbidden import and an unhandled union variant must each fail that check. | Whether no-argument `Date.now()` can be forbidden by types alone (open evidence) |
| **U8** UUIDv7 only | Every identifier the Portal mints during the shared session is parsed and must be version 7; a scan finds no `randomUUID`. | Identifiers received from other services, which keep their own format |
| **U9** No wall clock in tests | A scan of the test files finds no wall-clock read, sleep or real-time deadline deciding an outcome, and no clock substitution in a production bundle. | Hang guards, pending RD4 |
| **U10** Gates as approved | The gate files are compared with master and must differ only by the approved type-check guard. | — |
| **U11** TypeScript verification | A scan finds no Python driving or asserting Portal behaviour outside the Python SDK's own tests. | — |
| **U12** One SDK generation; one version each | The lockfile and imports are scanned: one MCP SDK generation in product code; one esbuild, jose and vitest; no alpha Miniflare. | RD3 decides whether one test fixture may keep the old SDK |
| **U13** Known defects fixed | Each of the six findings gets a test that fails on `2dfea38e` and passes on the delivered commit. | — |
| **U14** Large requests streamed, not capped | A call with a 12 MiB argument completes on the private Worker and on Node with the same result as a small one; on Node the spill file is private, outside durable state, and gone after every kind of ending, including a crash and restart. | Concurrent large requests sharing one Worker isolate: the shared-failure limit R26 states, pending RD7 |
| **U15** Hegel property tests | Five Hegel property families run against the real store implementation on both databases and against the canonical encoder and approval verifier. | Interleavings Hegel does not generate across separate OS processes (covered by the contention observation instead) |

## Shared observations

These are described once; the rows below name which obligations each one decides.

**O1 — Two-host conformance session** (needed journey `verify-tool-portal` › `conformance`, lasting: every later change to either host can make them drift.)
A fixed scenario script drives the MCP proxy way in on both hosts with the same workspace configuration, credentials, controlled clock, seeded UUIDv7 source and fixed key material. It records each exchange: `tools/list` in `direct` and `indirect`, search and describe, allowed calls, refused calls (unknown caller, wrong workspace, non-member, removed member, persona-narrowed tool), a call needing approval with and without a token, the same token twice, and the analytics data point each call writes. On Node it also drives the standalone Tool Portal routes and stdio, which have no Cloudflare counterpart. The two MCP proxy transcripts are compared field by field after replacing only transport framing.
- **Entry:** HTTP to `/workspaces/‹id›/mcp` on workerd; HTTP to the Node listener; the Node standalone MCP and JSON routes.
- **Reads:** response bodies, status codes, refusal codes, and the analytics sink's recorded data points.

**O2 — Restart and redeploy** (needed journey `verify-tool-portal` › `restart`, lasting.)
- **Node:** present a proxy token once, reserve and arm a batch approval, and reserve a second batch approval without arming it. Stop the process, start it again on the same `stateDirectory` and configuration, and present all three again.
- **Cloudflare in workerd:** the same steps, with Miniflare's persisted Durable Object storage directory kept across the runtime restart.
- **Private test Worker:** present, redeploy the same build, present again.
- **Reads:** each answer after the restart, and the store rows read through a store inspection operation used only by the test host.

**O3 — Contention** (needed journey `verify-tool-portal` › `contention`, lasting.) Present one approval many times at once:
- through two or more Worker copies on the private test Worker (the existing row 13 cross-copy check is the starting point);
- through two Node processes sharing one `stateDirectory`;
- through many concurrent requests in workerd.

It counts the `first-use` answers and the upstream effects the fake upstream server records. It also replays removal notices in a shuffled order with repeats once store version 2 exists.

Expiry cases (SEC-01, OBS-01), with controlled clocks on both hosts:
- **Held past expiry:** an approval that has already had its one effect is replayed by two requests. Both are held after the front verifier and released after expiry by the store's clock. This is done for the proxy token and for batch reserve and arm.
- **Clock offsets:** the verifier's clock is ahead of the store's, then behind it.
- **Step back:** the store's clock steps forward past expiry, the row is pruned, the clock steps back, and the approval is presented again, also across a restart.
- **Mismatched open:** a store database opened with another workspace's identifier.

Passes when there are **zero additional upstream effects** in every case: each late presentation answers `expired`, and the mismatched open answers `workspace-mismatch`. **Wrong builds that fail:** one that prunes before checking the presentation's expiry (a second `first-use` and a second effect after the held release); one that uses the raw clock instead of the stored security time (step-back resurrects the token); one that ignores `store_meta` (a second workspace reads the first's rows).

**O4 — Hegel store properties** (no journey: decided by property tests in the core's suite, run on both databases.)
The stateful model test that exists today (`tool-host-core/src/workspace-authority/workspace-authority.stateful.unit.test.ts` at `2dfea38e`) runs against the in-memory volatile store. It is re-pointed at the Drizzle store on a `better-sqlite3` file and on Durable Object SQLite in workerd, with the controlled clock. Families:

1. Proxy token one-use under arbitrary presentation orders, expiries, holds between verification and the store, and clock steps forward and back: the model counts effects, and an Approval never has more than one.
2. The batch approval lifecycle with a restart inserted at any step.
3. Removal marks under arbitrary orders and repeats (store version 2).
4. Store results matching a pure model after any operation sequence.
5. Canonical encoding: equal data under shuffled keys and any collation gives equal bytes.

**O5 — Structural scans** (no journey: structural evidence.) Source and manifest scans of the Tool Portal packages and their tests, the lockfile, and the gate files, each named in its row with the behaviour it leaves unevaluated.

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

## Rows

### U1 — One core, every runtime only injects

| | |
|---|---|
| **Requirement** | U1 → R1 (every rule in the core: same outcomes on both hosts), R2 (the Node host runs the core) |
| **Proven by** | The same scripted session is played against both hosts, and their answers must match exactly. |
| **Reference** | The Tool Portal Specification's checks 1–17 for each scenario's expected answer; R1's list of rules; the transcript of the other host for equality |
| **Target and journey** | Cloudflare host in workerd and Node host process, delivered commit, the conformance configuration; O1 (`needed:` `verify-tool-portal` › `conformance`, driving both hosts' HTTP entries and reading responses and analytics data points) |
| **Lifetime** | lasting |
| **Passes when** | Every MCP proxy exchange in O1 is equal on both hosts, and every Node-only route answers as the Tool Portal Specification says. **Wrong build that fails:** a Node host that keeps its own approval list or gateway. It answers a repeated token differently after the O2 restart, and its analytics data point lacks a field the core writes. **Allowed different build that passes:** a host that supplies a different transport framing. |
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
| **Target and journey** | O5 for R5. For R6: an upgrade case per earlier schema version on each database, plus a request sent while migration is held open. Journey: none, decided by the store suite run on both databases. |
| **Passes when** | **R5:** no `ctx.storage.get/put/list/delete/transaction` on key-value storage, `node:sqlite`, `.prepare(` SQL string, or Kysely in the Tool Portal packages. **R6:** every earlier-version database reaches the latest version with identical records; the held-migration request is answered only after migration completes, or refused with `store-unavailable`; each database shows one `__drizzle_migrations` history. **Wrong builds that fail:** a host that serves before migrating; a migration applied twice. |
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
| **Passes when** | **O2:** after the restart, the used proxy token is `already-used`, the armed batch approval is `ambiguous` and the reserved one is `already-consumed`, and nothing is dispatched. **O3:** exactly one `first-use` across all copies and processes. **O7:** the fresh approval's call succeeds once; both kept tokens fail at approval verification with zero upstream effects. **Wrong builds that fail:** today's Node host (its batch-approval records are a `Map` and its generation comes from configuration, so after restart the token is accepted again); a store that checks then inserts in two transactions (two first uses under O3); a cutover that keeps the old keys (the kept token passes verification); a cutover that forgets to re-add members (the positive control fails, so an old-token refusal can't be mistaken for success). |
| **Reuses** | none counted. The existing deployed row 13 check (cross-copy one-use, `tool-host-cloudflare/src/deployed-checks/deployed-check-suites/`) is the starting point for O3 on the Worker; it counts only once re-pointed at the remediated Worker and read again. |
| **Unverified** | power loss mid-write; removal-mark durability until store version 2 |

### U6 — Crypto is injected

| | |
|---|---|
| **Requirement** | U6 → R3 (runtime only through capabilities) |
| **Proven by** | The core runs with fake crypto, clock and identifier capabilities that record every call; every crypto operation goes through them, and two runs give the same bytes. |
| **Reference** | R3's pass and fail conditions; the `PortalPlatform` contract |
| **Target and journey** | The core's suite with recording capabilities, plus O6 for the static half; journey: none |
| **Passes when** | Every digest, HMAC and signature check in the O1 scenarios appears in the recording, and two runs produce byte-identical tokens, fingerprints and responses. The injected adapters are trusted components, so each real adapter is also run, on both hosts, against fixed known-answer and tamper vectors:<br>• SHA-256 and HMAC-SHA-256 known answers;<br>• an HMAC with one byte changed is refused;<br>• JWS vectors with a valid signature, a changed signature, a disallowed algorithm and a key not in the pinned key set;<br>• a key fetch that fails, which must answer `keys-unavailable`, never verified.<br>**Wrong builds that fail:** a core function that calls `globalThis.crypto.subtle` directly, whose digest never appears in the recording; an adapter that returns verified on a tampered signature or on a key-fetch failure. **Allowed build that passes:** web-platform adapters using a different crypto library. |
| **Reuses** | none |
| **Unverified** | a malicious host, which controls execution and can bypass the core; no in-core check can contain it (the trusted-base limit in Program Design, "Security and the other qualities") |

### U7 — Type safety, discriminated unions, the type-check guard

| | |
|---|---|
| **Requirement** | U7 → R10 (discriminated unions), R11 (the core type-checks without runtime types) |
| **Proven by** | The core is type-checked with no Node or Workers types and must pass; a forbidden import and an unhandled union variant must each fail. |
| **Reference** | R10's listed unions; R11's forbidden imports |
| **Target and journey** | The core packages at the delivered commit; O6; journey: none |
| **Passes when** | The guard passes on the delivered code. Each of these, added to a core module, makes it fail:<br>• `import 'node:crypto'`<br>• `import 'cloudflare:workers'`<br>• `import 'drizzle-orm/better-sqlite3'`<br>• `/// <reference types="node" />` (caught by the declaration inventory)<br>• `Date.now()`, `new Date()`, `Math.random()`, `setTimeout(...)`, `crypto.subtle`, `AbortSignal.timeout(1)`<br>Adding a variant to `ProxyTokenPresentation` without handling it makes the type-check fail at each switch.<br>**Wrong build that fails:** a core that compiles only because Node types are visible. |
| **Reuses** | none |
| **Unverified** | type errors inside dependency declarations, which `skipLibCheck` hides; deliberate casts and `any` |

### U8 — UUIDv7 only

| | |
|---|---|
| **Requirement** | U8 → R12 (every Portal identifier is a UUIDv7) |
| **Proven by** | Every identifier the Portal mints during the shared session must parse as version 7, and a scan finds no `randomUUID`. |
| **Reference** | RFC 9562 version 7 layout |
| **Target and journey** | O1 transcripts (operation ids, receipt references, approval token ids, correlation ids) and O5; journey: O1 |
| **Lifetime** | lasting (O1) |
| **Passes when** | Every minted identifier in O1 parses as version 7, and O5 finds no `randomUUID(` or other UUID version call in Tool Portal code or tests. **Wrong build that fails:** today's `newId: crypto.randomUUID`, which mints version 4. |
| **Reuses** | none |
| **Unverified** | identifiers received from sign-in or Fleet |

### U9 — No wall clock in tests

| | |
|---|---|
| **Requirement** | U9 → R13 (no wall-clock time in tests), R14 (time controlled only through the clock capability) |
| **Proven by** | A scan of the test files finds no wall-clock read, sleep or real-time deadline deciding an outcome; a scan of production bundles finds no clock substitution or test entry. |
| **Reference** | R13's fail list; the 23 clock-dependent and 10 timestamp sites the evidence lists at `2dfea38e`, each of which must be gone |
| **Target and journey** | O5 over the test files of the Tool Portal packages and the built production bundles; journey: none |
| **Passes when** | No test file calls `Date.now()`, no-argument `new Date()`, `performance.now()`, or a real timer to compute an expected value, an expiry or a deadline. The built Worker and Node bundles contain no `Date.now` replacement, no test-only route and no test-only export. **Wrong build that fails:** today's `worker-approval.host.e2e.test.ts:19–20`, which issues tokens from the real Worker clock. |
| **Reuses** | none |
| **Unverified** | timeouts that only fail a hung external process, until RD4 is decided |

### U10 — Gates as approved

| | |
|---|---|
| **Requirement** | U10 → R19 (the owner's gates, as approved) |
| **Proven by** | The gate files are compared with master and must differ only by the approved type-check guard. |
| **Reference** | `scripts/run-check-gate.ts`, `vitest.config.ts`, the root `package.json` scripts and `.github/workflows/` at `38569fca`; the guard step |
| **Target and journey** | O5; journey: none |
| **Passes when** | The diff against `38569fca` contains only the guard step and its configuration files, and none of the 26 scripts #262 added remains unless RD5 kept it. **Wrong build that fails:** today's `portal-exports` step change. |
| **Reuses** | none |
| **Unverified** | — |

### U11 — TypeScript verification

| | |
|---|---|
| **Requirement** | U11 → R16 |
| **Proven by** | A scan finds no Python driving or asserting Portal behaviour outside the Python SDK's own tests. |
| **Reference** | R16 |
| **Target and journey** | O5 over the repository's Python files touched by this work; journey: none |
| **Passes when** | `python/agent-vm-agent-portal-sdk/tests/mcp_node_host_journey.py`'s wire and protocol assertions live in a TypeScript host test. Any remaining Python only calls the Python SDK's public API in its own suite. **Wrong build that fails:** the journey script kept as the Portal's protocol proof. |
| **Reuses** | none |
| **Unverified** | — |

### U12 — One SDK generation; one version each

| | |
|---|---|
| **Requirement** | U12 → R17, R18 |
| **Proven by** | The lockfile and imports are scanned. |
| **Reference** | R17, R18; RD3's decision |
| **Target and journey** | O5 over the lockfile and every `import` in product code; journey: none |
| **Passes when** | No product module imports `@modelcontextprotocol/sdk`. The lockfile resolves one version each of esbuild, jose and vitest, and no Miniflare version ending in `-alpha`. **Wrong build that fails:** today's three `jose` versions. |
| **Reuses** | none |
| **Unverified** | the fixture exception, pending RD3 |

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
| **Proven by** | A tool call carrying a 12 MiB argument completes on the private test Worker and on Node with the same result as a small one. On Node, the temporary file is seen while the request is read and gone afterwards. |
| **Reference** | R26's pass condition; the call's result at a size under 4 MiB, taken as the expected result for the same tool and arguments structure |
| **Target and journey** | Private test Worker and the Node host process, delivered commit. `needed:` `verify-tool-portal` › `large-request`: drives one call at 3 MiB, 5 MiB and 12 MiB through the MCP proxy entry; keeps each raw response (status, headers, body, CF-Ray) and the `wrangler tail` invocation outcome; on Node, lists the spill directory during and after the call. |
| **Lifetime** | lasting |
| **Passes when** | All three calls return the tool's normal result. No response is a Portal size refusal or a 502. On Node, these spill checks hold (SEC-04):<br>• The spill file exists during the 12 MiB call, in the spill directory and not under `stateDirectory`. It has mode `0600` in a `0700` directory.<br>• The file is gone after the call, after a client abort mid-upload, and after a malformed tail. A malformed tail also produces no upstream effect.<br>• After a host killed mid-upload restarts, the dead process's spill directory is removed. A second live process's spill directory is not removed.<br>• A planted approval token and argument value from the request appear nowhere under `stateDirectory` afterwards.<br>• A full spill directory fails only that request, and a store decision made at the same time still succeeds.<br>**Wrong builds that fail:** today's handler path, which answers 413 at 4 MiB; a Node build that buffers in memory and leaves no spill file; one that spills under `stateDirectory`; one with no startup cleanup, which leaves the killed process's file behind. **Allowed build that passes:** a different streaming parser. Before building, the same journey takes the one correlated observation of today's 502 (Program Design, "Large requests", step 4). |
| **Reuses** | none: today's `row-15-limits` check asserts a 413, which R26 replaces, and keeps no response details |
| **Unverified** | requests near the account ceiling (100 MB) and near isolate memory. Concurrent large requests from two workspaces in one isolate, and many-field or deep objects, are not proven safe: under RD7 option A they are the accepted shared-failure limit R26 states. Under option B they become a required observation in the same isolate, with memory, invocation outcomes and effect counts kept. Three calls that land in different isolates prove nothing about this. |

### U15 — Hegel property tests

| | |
|---|---|
| **Requirement** | U15 → R15 |
| **Proven by** | Five Hegel property families run against the real store on both databases, and against the canonical encoder and approval verifier. |
| **Reference** | R15's five families; the pure models each family compares against |
| **Target and journey** | O4; journey: none |
| **Passes when** | All five families exist, run on both databases where they touch storage, and compare against a pure model. A mutant store that inserts first use after checking in a separate transaction is caught by family 1, as is a canonical encoder that uses `localeCompare` by family 5. **Wrong build that fails:** today's stateful test, which runs only on the volatile store, so it says nothing about either database. |
| **Reuses** | the existing stateful test's model and generators, once re-pointed |
| **Unverified** | separate OS processes, which O3 covers |

## Coverage for review and the plan

| U | R | Seam (Program Design trace) | Observation | Target / journey or test | Passing condition | Unverified |
|---|---|---|---|---|---|---|
| U1 | R1 R2 | conformance suite against both hosts; Node process proof | O1 | workerd + Node · `conformance` (needed, lasting) | transcripts equal; Node-only routes per spec | managed path |
| U2 | R4 | the same store suite on both databases | O4, O5 | store suite · none | same results; no host query | — |
| U3 | R5 R6 | source scan; upgrade run; request-before-migration probe | O5, upgrade cases | store suite · none | no forbidden API; upgrades keep records; nothing served early | version-2 upgrade later |
| U4 | R6 gate | owner approval | design record | — | RD1 decided before store code | — |
| U5 | R7 R8 R9 | restart and redeploy runs; contention runs; cutover run | O2, O3, O7 | Node, workerd, private Worker · `restart`, `contention` (lasting), `cutover` (temporary) | used/ambiguous/consumed after restart; one first use; old token fails | power loss; marks until v2 |
| U6 | R3 | fixed-capability determinism run; type-check guard | recording capabilities, O6 | core suite · none | every crypto call recorded; identical bytes | — |
| U7 | R10 R11 | type tests; guard run | O6 | core packages · none | guard passes; forbidden import and unhandled variant fail | `Date.now()` by types |
| U8 | R12 | minted ids parsed; source scan | O1, O5 | `conformance` | all v7; no `randomUUID` | received ids |
| U9 | R13 R14 | test-file scan; bundle scan | O5 | scans · none | no wall-clock reads; no substitution | hang guards (RD4) |
| U10 | R19 | gate diff | O5 | gate files · none | diff = guard only | — |
| U11 | R16 | Python scan | O5 | Python files · none | no Python Portal verification | — |
| U12 | R17 R18 | lockfile and import scan | O5 | lockfile · none | one generation; one version each; no alpha | RD3 |
| U13 | R20–R25 | each defect's focused case | focused tests, O4 family 5 | owning modules · none | each fails before, passes after | — |
| U14 | R26 | the U14 row: 3, 5 and 12 MiB calls; spill cases | raw responses, `wrangler tail` outcomes, spill directory listings | private Worker and Node host · `large-request` (needed, lasting) | normal result; no Portal 413 or 502; spill file private, outside `stateDirectory`, removed on every end | same-isolate concurrency (RD7) |
| U15 | R15 | Hegel families on both databases | O4 | core suite · none | five families vs pure models; mutants caught | separate processes |

## Journeys this needs

The project has no `verify-tool-portal` skill yet; only `verify-auth` exists. These journeys are needed, and the lasting ones are built before any observation depends on them:

| Journey | Lifetime | Drives | Reads |
|---|---|---|---|
| `conformance` | lasting | both hosts' MCP proxy HTTP entries; Node's standalone routes and stdio | responses, refusal codes, analytics data points, minted identifiers |
| `restart` | lasting | Node process stop/start on one `stateDirectory`; workerd restart with persisted storage; private Worker redeploy | answers after restart; store rows through the test host's inspection operation |
| `contention` | lasting | concurrent presentations across Worker copies, Node processes and workerd requests | count of `first-use` answers |
| `cutover` | temporary | an approval used on the old Worker, then the remediation deployed | the kept token's answer |
| `large-request` | lasting | the MCP proxy entry on the private Worker and the Node host, at 3, 5 and 12 MiB, with abort, malformed tail, killed-process restart and a full spill directory on Node | raw response (status, headers, body, CF-Ray), `wrangler tail` invocation outcome, spill directory and `stateDirectory` listings |
