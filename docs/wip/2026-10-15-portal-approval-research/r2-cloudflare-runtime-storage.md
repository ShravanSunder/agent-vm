# Cloudflare VPC, runtime, and storage evidence

Research date: 2026-10-15. Read-only assignment R2 for the 🦁 Lead. Repository: `agent-vm.design-portable-tool-portal-hosts`, branch `design/portable-tool-portal-hosts`, HEAD `8535fdd433dc90fed627ee7a05f63e59d58cf8ee`.

**Finding:** The documented VPC setup can reach a same-machine localhost service and share `cloudflared` with an existing public application. VPC remains beta and requires QUIC. DO SQLite directly supports a synchronous JavaScript read/check/consume transaction. D1 supports atomic SQL statements and batches; a shared ORM schema does not give it DO's transaction callback semantics. Precise VPC idle timeouts and its complete HTTP-version/streaming matrix remain unverified.

Labels: **FACT** = directly read primary documentation/source; **INFERENCE** = conclusion from those facts, not a runtime observation; **UNKNOWN** = evidence missing or conflicting. Confidence concerns documentary support, not a deployed test. No account, deployment, credential, running service, or product code was changed. Examples below are illustrative and were not executed.

## 1. Workers VPC → Tunnel → loopback origin

### Setup and scope

- **FACT · high:** Install/run `cloudflared` on a machine that can reach the origin; VPC requires version **2025.7.0 or later**, the **QUIC** transport (`auto` or `quic`), and outbound UDP port **7844**. A tunnel connects outbound; inbound firewall openings and a public origin IP are unnecessary. [VPC Tunnel, “Create and run tunnel”](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/#create-and-run-tunnel-cloudflared), anchors: “2025.7.0 or later”; “QUIC transport protocol”.
- **FACT · high:** For a **VPC Service**, register its tunnel ID, internal hostname or IPv4/IPv6 address, HTTP/HTTPS ports, and optional DNS/TLS settings; bind the resulting `service_id` to the Worker. The dashboard guide explicitly gives `localhost` as an internal service address. Service creation needs Connectivity Directory Admin; binding existing services needs Bind or Admin. [Get started, steps 2–5](https://developers.cloudflare.com/workers-vpc/get-started/#3-create-a-vpc-service), anchor: “Host or IP address”.
- **FACT · high:** The Service registration fixes the destination host and port. The URL host passed to `fetch()` supplies Host/SNI, and its port does not override the registration. [Binding API, “VPC Service”](https://developers.cloudflare.com/workers-vpc/api/#vpc-service), anchor: “port provided in `fetch()` is ignored”.
- **FACT · high:** A **VPC Network** can instead bind directly to a tunnel UUID; its runtime URL/address chooses the destination. No per-origin registration is required. Direct tunnel binding needs Connectivity Directory Admin. Network scope includes any reachable destination, unlike the fixed Service target. [VPC Networks, “Bind to a Cloudflare Tunnel”](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/#bind-to-a-cloudflare-tunnel), anchor: “without pre-registering individual hosts or ports”.

Illustrative Wrangler binding fragments, adapted from those two configuration guides:

```jsonc
// Alternative A: registration selects this tunnel + localhost + MCP port.
{
  "vpc_services": [
    { "binding": "MAC_MCP", "service_id": "<registered-service-id>", "remote": true }
  ]
}
```

```jsonc
// Alternative B: the fetch URL selects the origin through this tunnel.
{
  "vpc_networks": [
    { "binding": "MAC_NETWORK", "tunnel_id": "<existing-tunnel-uuid>", "remote": true }
  ]
}
```

- **INFERENCE · high:** An MCP listener may remain bound only to `127.0.0.1` when `cloudflared` runs in the same host/network namespace and the registered/dynamic target reaches IPv4 loopback. The guide's localhost example plus the connector's origin-dialing model supports this. A connector in a container, VM, or different machine has a different loopback; `localhost` resolving to `::1` also needs attention for an IPv4-only listener. No live Mac connection was tested. Sources: Get started and VPC Tunnel above.

### Protocols, limits, and commercial status

| Item | Answer, label, confidence, and primary evidence |
| --- | --- |
| HTTP/HTTPS | **FACT · high:** both binding kinds expose HTTP `fetch()`; HTTP Services support HTTP and HTTPS origin schemes. HTTPS uses the fetch hostname for SNI. [VPC Services, HTTP services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#http-services), anchor: “plaintext connection”; [Binding API, fetch](https://developers.cloudflare.com/workers-vpc/api/#fetch), anchor: “standard Fetch API Response object”. |
| HTTP/1.1 versus HTTP/2 | **FACT · high, limited scope:** published-application Tunnel origin settings default to HTTP/1.1; `http2Origin` attempts HTTP/2 and requires HTTPS. **UNKNOWN:** no VPC-specific version negotiation/configuration guarantee found. Those settings explicitly describe published applications, so they cannot establish the VPC path's matrix. QUIC to Cloudflare is a separate hop from origin HTTP. [Origin parameters, http2Origin](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#http2origin), anchor: “HTTP/2 to the origin requires HTTPS”. |
| WebSocket | **INFERENCE · medium:** VPC's documented `http_upgrade_failed` error expressly includes WebSocket, indicating an upgrade path. **UNKNOWN:** no complete support/limits contract or live upgrade proof found for both binding kinds. [VPC troubleshooting, Bad Upstream errors](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/#bad-upstream-errors), anchor: “for example, WebSocket”. |
| Streaming/SSE | **FACT · high, general Tunnel:** troubleshooting says the origin's `Content-Type: text/event-stream` causes live streaming; otherwise proxied Tunnel traffic is buffered by default. **INFERENCE · medium:** returning the VPC Fetch Response directly can preserve its stream, but **UNKNOWN** whether every VPC path has exactly the published-Tunnel buffering behavior. No latency/backpressure test was run. [Tunnel troubleshooting, streaming response](https://developers.cloudflare.com/tunnel/troubleshooting/#cloudflare-tunnel-is-buffering-my-streaming-response-instead-of-streaming-it-live), anchor: “Content-Type: text/event-stream”. |
| Request/response sizes | **FACT · high:** VPC defers request size, timeout, and subrequest limits to Workers. See Q3 for the current sizes. It lists **1,000 Services/account**, not a separate VPC payload maximum. [VPC limits](https://developers.cloudflare.com/workers-vpc/platform/limits/), anchor: “Standard Workers limits apply”. |
| VPC timeouts | **UNKNOWN:** numeric connection, read-idle, write-idle, or overall stream limits are not specified in the VPC limits/API/Tunnel pages inspected. Troubleshooting names `connection_timeout`, `connection_read_timeout`, `connection_write_timeout`, and `dns_timeout`; unlimited Worker wall time does not remove these. Published-origin settings separately list TCP connect 30s, TLS handshake 10s, idle keepalive expiration 90s; their applicability to VPC was not established. [VPC troubleshooting, Client errors](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/#client-errors), anchor: “connection_read_timeout”; [Origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#connecttimeout), anchor: “Connect Timeout”. |
| Status/pricing | **FACT · high:** VPC is **open beta**, free during beta on Workers plans; standard Worker compute/request billing still applies. Future VPC GA pricing is **UNKNOWN**. [VPC pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/), anchor: “free during the open beta period”. |
| Raw TCP | **FACT · high:** Network bindings expose `connect()`, currently plaintext TCP only. TCP Services are used through Hyperdrive rather than a Service-binding `connect()` method. This does not imply general UDP support. [Binding API, connect](https://developers.cloudflare.com/workers-vpc/api/#connect), anchor: “plaintext TCP only”; [VPC Services, TCP services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#tcp-services), anchor: “used with Hyperdrive”. |

Open gaps: the VPC-specific HTTP/2, WebSocket, streaming/backpressure, and numeric timeout contract. Searches are recorded below; these are deliberately not presented as deployment guarantees.

## 2. One cloudflared for an Access website and private VPC origin

- **FACT · high:** Cloudflare explicitly permits the same `cloudflared` instance to cover Zero Trust and Workers VPC simultaneously. Public ingress configuration is unnecessary for VPC because VPC Service registration supplies routing. [VPC Tunnel, “Create and run tunnel”](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/#create-and-run-tunnel-cloudflared), anchors: “same `cloudflared` instance”; “simultaneously”; “not required for Workers VPC”.
- **FACT · high:** For the existing website, the dashboard model is **Networking → Tunnels → existing tunnel → Routes → Add route → Published application**, with public hostname and local Service URL. This is the website route; the separate VPC registration references that tunnel and the MCP origin. [Tunnel get started, “Publish an application”](https://developers.cloudflare.com/tunnel/get-started/#publish-an-application), anchor: “maps a public hostname to a local service”.
- **INFERENCE · high:** Leave the website's existing Access application attached to its public hostname; register MCP separately as a VPC Service on the same tunnel (or bind that tunnel as a Network). No public MCP hostname is needed. Existing hostname Access policy must not be assumed to authorize VPC calls: the documented VPC permission/routing boundary is separate. Sources: those two pages and Q1's VPC roles.

Illustrative local configuration for the public half, adapted from [Tunnel configuration file, “File structure for published applications”](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/#file-structure-for-published-applications), anchor: “catch-all rule”:

```yaml
tunnel: <existing-tunnel-uuid>
protocol: quic
ingress:
  - hostname: website.example.com
    service: http://localhost:8080
  - service: http_status:404
```

**INFERENCE · high:** This illustrates the two configuration planes: the YAML publishes only the website; the VPC registration/Worker binding reaches the MCP port. Tunnel credential/runtime installation details and Access policy are deliberately omitted. The remotely managed dashboard model above avoids a local YAML change. No current owner account/tunnel/Access settings were inspected, so compatibility of the actual existing tunnel is **UNKNOWN**.

## 3. Worker and Durable Object limits for long MCP calls

**FACT · high:** Current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time), anchors: “does **not** count toward CPU time”; “No enforced limit”; “tasks associated with that request may be canceled”:

| Boundary | Documented limit/behavior |
| --- | --- |
| CPU | Free: 10ms/request. Paid: default 30s, configurable to 300s. Waiting for I/O does not count. |
| HTTP wall time | No hard duration limit while the client remains connected, including response streaming. |
| Subrequests | Free: 50/invocation; Paid: default 10,000, configurable higher. Redirects count. Internal services have separate entries. |
| Concurrent connections | Six waiting for initial response headers; after headers, those fetches no longer consume that six-slot limit. Outbound WebSockets count. |
| Memory | 128MB/isolate, shared by its concurrent invocations. |
| Request body | Account/zone plan, not Worker plan: Free/Pro 100MB, Business 200MB, Enterprise up to 5GB self-serve. |
| Other HTTP sizes | URL 16KB; request and response headers each 128KB total; no enforced response-body maximum. Cache limits are separate. |
| Client disconnect | Outstanding request work, including subrequests, may be canceled. `ctx.waitUntil()` permits up to 30s after disconnect/response. |

- **FACT · high:** DO HTTP/RPC wall time is unlimited while the caller stays connected; pending requests, streams, WebSockets, and I/O keep it active. DO CPU defaults to 30s and is configurable to 5min; alarm handlers have a 15min wall-time limit. [DO limits, “Wall time limits by invocation type”](https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type), anchor: “No hard limit while the caller stays connected”.
- **INFERENCE · high:** A long network wait need not exhaust CPU, but buffering/JSON parsing consumes memory/CPU. A disconnect is not a transactional rollback or proof the Mac canceled its side effect; the docs only promise possible Worker cancellation. `waitUntil()` is not an unbounded detached-call guarantee. Sources: the two limits pages above.
- **UNKNOWN:** VPC's separate numeric idle/deadline behavior (Q1), and exact cancellation propagation from a dropped browser through a DO and VPC to the Mac. No running call was started. The unlimited-wall-time statement should not become a promise that arbitrary MCP calls survive disconnects, deployments, or failures.

## 4. Durable Object SQLite semantics and operations

### Transactions and consistency

- **FACT · high:** Storage is transactional, strongly consistent, private to one object. Each storage method is atomic/isolated. `transactionSync(callback)` rolls back on a throw and requires a synchronous callback; SQL uses synchronous `sql.exec()`. Raw SQL `BEGIN`/`SAVEPOINT` is prohibited. Consecutive writes without `await` coalesce atomically; the documented read-then-write protection requires no intervening non-storage I/O or `allowConcurrency` escape. [SQLite Storage API, intro / transactionSync / transaction](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync), anchors: “strongly consistent storage”; “callback must complete synchronously”.
- **FACT · high:** Input gates defer other events during storage work; output gates hold new outgoing network messages until preceding writes commit, and discard those messages if the write fails. This is not a general lock across arbitrary awaited network calls. [Cloudflare's gate explanation](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/), anchors: “Input gates”; “Output gates”.

### Capacity and recovery

- **FACT · high:** Paid per-object storage: 10GB; an object is single-threaded with a soft 1,000 requests/s limit, workload dependent. SQL row/string/BLOB maximum 2MB, 100 columns, 100KB SQL, 100 bindings. Overload can queue then fail. **UNKNOWN · conflicting docs:** the limits table says 10GB/object without a Free qualifier, but its storage-full FAQ says 1GB on Free. The page separately gives 5GB/account on Free. Do not silently choose one Free-object value. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/#sqlite-backed-durable-objects-general-limits), anchors: “soft limit”; “1 GB on the Free plan”.
- **FACT · high:** PITR restores the entire object's SQL and KV contents within the preceding 30 days using bookmarks, including `getCurrentBookmark`, `getBookmarkForTime`, and `onNextSessionRestoreBookmark`; restoration happens on restart, normally induced with `ctx.abort()`. It is unavailable in local development. It is not a documented downloadable SQLite backup. [SQLite Storage API, PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api), anchor: “past 30 days”.

### Inspection, edits, and export

- **FACT · high:** Dashboard **Durable Objects → namespace → Data Studio → object name/ID** can read/write SQL-backed tables. It needs at least Worker Editor access, operates on remote deployed objects, incurs normal usage charges, and logs queries. “Run all” sends each statement as a separate DO request. The page does not currently offer KV-table access. [DO Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/#view-data-studio), anchors: “each SQL statement”; “separate Durable Object request”.
- **FACT · high:** The public DO Objects REST reference inspected exposes object listing and stored-data presence, not a D1-like SQL query/export endpoint. This is evidence of that published surface, not proof no internal endpoint exists. [DO Objects API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/), anchor: “List Objects in a Durable Object namespace”.
- **INFERENCE · high:** An application-owned Worker/DO method can provide domain-specific reads/edits/export using `sql.exec()` results. External callers would use that application's API; it is not a direct generic SQLite connection. [Access DO Storage, “SQL in Durable Objects vs D1”](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/#sql-in-durable-objects-vs-d1), anchors: “accessed with Workers-only”; “build some of your own database tooling”.
- **UNKNOWN:** No documented generic remote `wrangler` SQL console, complete database export/download command, or public DO data SQL REST API was found in the inspected storage/API/Data Studio pages or targeted searches. Data Studio supplies a real dashboard editor; claiming DO has no external editing UI would be wrong. Consistent full-database export mechanics and arbitrary administrator edits versus application invariants were not tested.

## 5. D1 semantics and operations

### Transactions and replicas

- **FACT · high:** D1 uses auto-commit; `batch()` executes a prepared list sequentially/non-concurrently and rolls the whole batch back if a statement fails. It provides results after submission, without a JavaScript branch point between statements. Sessions expose ordered queries, not a transaction closure. [D1 Database API, batch / withSession](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), anchors: “Batched statements are SQL transactions”; “rolls back the entire sequence”.
- **FACT · high:** Each D1 query runs inside an implicit transaction. Foreign keys are enforced; `PRAGMA defer_foreign_keys` defers checks until transaction completion rather than disabling enforcement globally. [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/#defer-foreign-key-constraints), anchor: “every query inside an implicit transaction”.
- **INFERENCE · high:** No supported interactive JavaScript read/check/write transaction API was established in the current D1 binding reference. The 2022 Cloudflare article explicitly says raw `BEGIN TRANSACTION` errors and describes procedures as future work; that old proposal is not a current API promise. Current import docs still require stripping `BEGIN TRANSACTION`/`COMMIT`. [Historical Cloudflare explanation](https://blog.cloudflare.com/whats-new-with-d1/), anchor: “you'll get an error”; [D1 import/export, conversion](https://developers.cloudflare.com/d1/best-practices/import-export-data/#convert-sqlite-database-files), anchor: “Remove `BEGIN TRANSACTION` and `COMMIT;`”. **UNKNOWN:** a future or unpublicized interactive API; none is claimed here.
- **FACT · high:** Replicas are asynchronous; writes go to the primary. Replica use requires Sessions API; ordinary binding queries continue at the primary. Sessions provide sequential consistency, monotonic reads, and read-your-writes, not exclusion of other writers. `first-primary` starts current at the primary; default `first-unconstrained` may start at a lagging replica. A bookmark starts at least as recent as its recorded version. Sessions are currently binding-only, not REST. [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/#use-sessions-api), anchors: “sequential consistency”; “not yet available via the REST API”.

### Limits, recovery, and operator access

- **FACT · high:** Database size: 10GB Paid / 500MB Free; account storage: 1TB Paid / 5GB Free. Queries and entire batches have a 30s limit. SQL constraints include 100 columns, 2MB row/string/BLOB, 100KB statement, 100 bound parameters. A primary database processes queries one at a time; throughput depends on query cost, not an unlimited writer pool. The D1 page states 1,000 queries/Worker invocation Paid and 50 Free. **UNKNOWN · discrepancy:** generic Workers limits now give 10,000 Paid subrequests; do not assume that automatically raises D1's documented 1,000. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), anchors: “Maximum SQL query duration”; “entire batch call”.
- **FACT · high:** Time Travel is always on, no additional backup/restore charge, 30 days Paid / 7 days Free, restore to a minute/bookmark in-place. Restoration cancels in-flight queries; an undo bookmark is returned. [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/#restore-a-database), anchors: “always on”; “overwrites the database in place”.
- **FACT · high:** Operators can inspect/edit via D1 dashboard Console, Worker binding, Wrangler `d1 execute` (use `--remote` for the deployed database), or the public SQL REST endpoint. [D1 getting started, query](https://developers.cloudflare.com/d1/get-started/#4-run-a-query-against-your-d1-database), anchor: “Console”; [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/), anchor: “Execute a SQL query”.
- **FACT · high:** Wrangler exports remote schema/data to SQL; imports use SQL, not raw SQLite database files. Export blocks other database requests; virtual-table databases and large integer precision have documented limitations. [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/#export-an-existing-d1-database), anchor: “block other database requests”. Source-read command shape: `pnpm exec wrangler d1 export <database_name> --remote --output=./database.sql`. Not executed.

Open gaps: current cross-page query quota discrepancy; no current interactive callback contract; no owner database was queried or edited.

## 6. Drizzle support, migrations, and one shared schema

### Documented adapters and current source

- **FACT · high:** Drizzle documents both `drizzle-orm/durable-sqlite` and `drizzle-orm/d1` as supported Cloudflare integrations. Current guide installation snippets select `drizzle-orm@rc`/`drizzle-kit@rc`; this describes those guides, not a claim every released version is equivalent. [DO connection](https://orm.drizzle.team/docs/connect-cloudflare-do), anchor: “fully supports”; [D1 connection](https://orm.drizzle.team/docs/connect-cloudflare-d1), anchor: “fully supports”.
- **FACT · high:** Source inspected at immutable Drizzle commit `eab8bedbb65d5429c54e612ddbd88aa23091d398` (main when read). Its manifests say ORM `0.45.4`, Kit `0.31.11`; these are checkout versions, not verified registry dist-tags. [ORM manifest](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/package.json), anchor: `0.45.4`; [Kit manifest](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-kit/package.json), anchor: `0.31.11`.
- **FACT · high:** DO `db.transaction` delegates to `client.transactionSync`; D1 `db.batch` delegates to the platform batch, while D1 `db.transaction` issues raw `begin`/`commit`/`rollback` and nested savepoints. Thus an available TypeScript method is not proof of supported platform execution. [DO session lines 63–70](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/durable-sqlite/session.ts#L63), anchor: `transactionSync`; [D1 session lines 77–96 and 111–144](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/d1/session.ts#L111), anchor: `begin`.

### Migration tools

| Target | FACT · high: documented/source-supported path |
| --- | --- |
| DO SQLite | Kit config `dialect: 'sqlite', driver: 'durable-sqlite'`; `drizzle-kit generate` produces bundled migration inputs. Apply them inside the Worker/object with `drizzle-orm/durable-sqlite/migrator`, before accepting queries, typically under `blockConcurrencyWhile`. The guide says migrations can be applied only from Workers; it does not establish direct remote Kit `migrate`/`push` support. [DO getting started, steps 6–8](https://orm.drizzle.team/docs/get-started/do-new), anchor: “only from Cloudflare Workers”. |
| D1 | Kit's `d1-http` driver uses account/database/token credentials and documents `migrate`, `push`, introspection and Studio via D1 HTTP API. Wrangler SQL migrations are another platform path; do not silently mix migration journals. [D1 HTTP Kit guide](https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit), anchor: “using Cloudflare D1 HTTP API”; [D1 connection](https://orm.drizzle.team/docs/connect-cloudflare-d1), anchor: `migrations_dir`. |
| Node / better-sqlite3 | Native supported Node driver and file connection. Kit generates SQLite SQL; the SQLite migration guide demonstrates applying it with `drizzle-orm/better-sqlite3/migrator`. [SQLite connection guide](https://orm.drizzle.team/docs/get-started-sqlite#better-sqlite3), anchor: “native support”; [SQLite migrations, runtime option](https://orm.drizzle.team/docs/sqlite/migrations), anchor: `better-sqlite3/migrator`. The common schema does not install this native driver inside Workers. |

- **FACT · high:** The DO migrator is an `async` function in the inspected source, but its actual database transaction callback is synchronous. D1's migrator reads migration files and applies pending statements using `session.batch()`. This differs from DeepWiki's suggestion that all SQLite migration paths use the generic transaction callback. [DO migrator lines 41–84](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/durable-sqlite/migrator.ts#L41), anchor: `db.transaction`; [D1 migrator lines 28–47](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/d1/migrator.ts#L28), anchor: `session.batch`.

### One schema, different execution contracts

- **INFERENCE · high:** A shared table schema using `drizzle-orm/sqlite-core` can be supplied to all three adapters. They share `BaseSQLiteDatabase` and schema extraction, while D1 chooses an async dialect and DO/better-sqlite3 choose sync dialects. This supports shared table definitions, not one identical driver, transaction API, result type, migration transport, or runtime module graph. [D1 driver lines 24–70](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/d1/driver.ts#L24), [DO driver lines 16–56](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/durable-sqlite/driver.ts#L16), [better-sqlite3 driver lines 24–58](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/drizzle-orm/src/better-sqlite3/driver.ts#L24).
- **INFERENCE · high:** Portability must respect the Cloudflare SQL/parameter/row limits, D1 foreign-key rules, numeric representation, and migration differences in Q4–5. Shared schema generation cannot prove that every generated table-rebuild migration or custom SQL extension executes on all three. **UNKNOWN:** a tested common schema and exact pinned release set for this project; no dependencies were installed, schema compiled, migrations applied, or runtime tested.

## 7. Atomic approval validity check and consumption

| Required interpretation | Evidence-supported answer |
| --- | --- |
| Read approval + current config revision; run synchronous JavaScript checks; mark consumed, with no writer interleaving | **INFERENCE · high: DO SQLite supports this directly**, provided both records belong to the same object's storage and all database/check work is inside one synchronous transaction. Q4's private, strongly consistent storage and `transactionSync` contract establish that boundary. Drizzle DO actually delegates to that API (Q6). Awaiting a remote configuration read is outside this proof. |
| Express validity as SQL and consume conditionally in the same database operation | **INFERENCE · high: both stores can support this.** D1 documents implicit transactions and atomic batches. A SQL mutation whose predicate checks the current config revision and unused approval state in that same database can make the check and consume one atomic operation; a fixed batch may also encode SQL-side dependent work. This is not a tested query/schema. Primary semantics: [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [D1 implicit transactions](https://developers.cloudflare.com/d1/sql-api/foreign-keys/#defer-foreign-key-constraints); [SQLite isolation](https://www.sqlite.org/isolation.html), anchor: “serializing the writes”. |
| D1 SELECT → JavaScript decision → separate UPDATE, even in a Session or Drizzle transaction callback | **INFERENCE · high: not established as atomic.** Sessions order observations but do not exclude other writers. No supported current interactive transaction was found; Drizzle's raw-BEGIN method does not fill that gap. Q5–6 provide the primary anchors. |
| Config and approvals split across DOs, databases, or external configuration authority | **UNKNOWN:** no cross-store transaction is established by any cited contract. The same-object/database qualification is load-bearing. |

**INFERENCE · high:** A stale replica read should not be the final approval authority merely because it is sequentially consistent. The authoritative consume operation must itself validate the relevant current revision under its transaction. An SQL transaction can protect the decision/consume state change, but it does not atomically include a later MCP side effect on the Mac. Sources: Q5 read-replication semantics and Q7's transaction boundaries.

## Surprises / things the Lead probably assumes wrongly

- **FACT, Q1–2:** One connector can serve both paths, but VPC requires QUIC; the website's working HTTP/2 tunnel transport is insufficient evidence for VPC.
- **FACT, Q1:** A VPC Service's fetch URL port does not select another origin; a Network URL does. A Network binding grants a substantially broader destination scope.
- **UNKNOWN, Q1:** Standard Worker unlimited wall time does not specify VPC idle timers or guarantee every streaming transport combination.
- **FACT, Q4:** DO now has a production dashboard SQL editor. Its “run all” executes separate requests, not an application transaction.
- **FACT/INFERENCE, Q5–7:** D1 does have transactions (statements/batches); it lacks an established interactive JavaScript transaction contract. Claiming “only DO can atomically consume approval” would be too broad if the condition fits one D1 SQL operation.
- **FACT, Q6:** Drizzle's common SQLite surface still exposes a D1 transaction implementation based on raw transaction SQL. Do not treat its method signature or DeepWiki's synthesis as platform proof.
- **UNKNOWN, Q4–5:** Current docs conflict on DO Free per-object capacity and on the newer generic Paid subrequest quota versus D1's own query quota.

## Coverage, searches, and proof limits

**Direct observations:** cwd/branch/HEAD match the packet. Existing untracked design/WIP directories were left alone. The only new file is this report. README was read for local orientation; no local implementation conclusion is asserted. Memory registry lookup produced no evidence used for these platform claims.

**Source routes:** local orientation → DeepWiki for Drizzle source pointers → official Cloudflare/Drizzle docs and immutable Drizzle source. The expected local OSS checkout was absent; primary GitHub source was read without creating one. `web.run` returned HTTP 404 twice; official Markdown/HTML was fetched read-only with `curl`. Perplexity was discovery only; primary pages were opened for material claims. Saved-reader research, account inspection, UI operations, deployments and runtime experiments were outside this packet. No independent reviewer was commissioned; this Worker was not granted delegation authority. The Lead owns acceptance.

**Verbatim discovery queries:**

1. `site:developers.cloudflare.com workers vpc WebSocket SSE HTTP2 tunnel localhost streaming timeout`
2. `site:developers.cloudflare.com d1 interactive transactions BEGIN not supported batch`
3. `site:orm.drizzle.team durable-sqlite drizzle-kit generate migrations driver durable-sqlite`
4. `site:developers.cloudflare.com durable objects export sqlite wrangler download database`
5. `site:developers.cloudflare.com/d1 "transactions" "not" "BEGIN"`
6. `site:developers.cloudflare.com/tunnel "http2Origin"`
7. `site:developers.cloudflare.com/durable-objects "export" "Data Studio" "API"`
8. `site:blog.cloudflare.com D1 "transactions" "interactive"`
9. `site:github.com/drizzle-team/drizzle-orm "D1" "transactions" "not supported"`
10. `site:developers.cloudflare.com/api "durable_objects" "query" "sql"`
11. `site:developers.cloudflare.com "Durable Objects" "export" "Wrangler" database download`

DeepWiki query: `Give exact source paths for the drizzle-orm/durable-sqlite, drizzle-orm/d1 and better-sqlite3 adapters and their transaction APIs, and drizzle-kit migrate/generate/push support. Need verify whether one sqlite-core schema works across all three and whether D1 interactive db.transaction is supported vs batch only. Distinguish Durable Object SQLite synchronous transactions from asynchronous migrate. Point to source/tests.`

**Null/unresolved results:** Q1's VPC-specific HTTP version matrix and numeric idle timers were not found in the VPC index, API, configuration, limits, pricing, troubleshooting, or protocol search. Q4's generic DO remote export/SQL CLI/REST route was not found in the primary object API/Data Studio/storage docs or queries 4, 7, 10, 11. Q5's current interactive callback was not found in the D1 binding reference or queries 2, 5, 8; the 2022 proposal remains historical evidence only. Incorrect legacy URL candidates returned empty curl output and were replaced with links discovered from official product indexes; they are not cited as evidence.

**Artifact exception:** This report also carries the evidence ledger because the packet authorizes only this one file, not a separate `tmp/practices-research` ledger. Board lookup found no project associated with `github.com/ShravanSunder/agent-vm`; `no-home` was reported to the Lead. As a Worker, I keep no separate work trace and do not post to an unsupplied board root.

**Validation boundary:** documentary/source research only. Seven numbered questions answered or explicitly UNKNOWN; citation and file readback checked. No application, VM, Cloudflare account, migration, runtime, lint, typecheck, or test-suite proof is claimed. No stand-in was built. Source-supported findings are accepted as documentary evidence; runtime gaps remain unresolved.

Return token: **program-design-gap** — the Lead must retain the transaction's same-object/database boundary and resolve the explicitly UNKNOWN VPC protocol/timeout guarantees before claiming an end-to-end long-call contract. No solution design or store selection is made by this report.
