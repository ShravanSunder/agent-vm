# Lane: validation-proof (parent-verified) - CANONICAL PROOF MATRIX

Status: answered and row-level. This file is the canonical requirements/proof
matrix. The implementation plan links here one way and keeps only selected DAG
echoes.

Row fields:
- id: stable proof id.
- source: source spec section or line anchor.
- owner: implementation slice responsible for the proof.
- files/harness: intended file or harness to create/edit.
- command: exact command or command family.
- red: expected failure before the slice lands.
- green: expected passing assertion after the slice lands.
- freshness guard: what prevents a stale or vacuous proof.
- split trigger: when to split the proof into a smaller task.

Infrastructure facts verified against the repo:
- Default `pnpm test:e2e` runs only `e2e-host-docker`, `e2e-host`,
  `e2e-vm`, and `e2e-vm-mediation` through `scripts/run-e2e-proof-lanes.ts`.
- `e2e-openclaw` and `e2e-worker` exist as env-gated projects, but are not in
  the default `pnpm test:e2e` lane set.
- `e2e-openclaw` includes only `packages/**/*.openclaw.e2e.test.ts`.
- `e2e-worker` includes only `packages/**/*.worker.e2e.test.ts`.
- Current code has zero production `handleUpgrade` references in packages.
- OPEN-1 constants are chosen in `implementation-plan.md`; BP-4 is no longer
  blocked on constants. Four magnitudes remain tune-during planning defaults:
  queue message cap, queue byte cap, dedupe/replay window, and per-source
  observation budget.
- The SSH-egress git execPolicy (GIT-1) is NET-NEW: zero repo refs to
  `execPolicy`/`git-receive-pack`/`git-upload-pack`/`sshEgress`, and
  gondolin-adapter exposes only inbound `SshAccess`. Gondolin itself DOES
  support git-verb egress `SshExecPolicy` (gondolin `host/src/qemu/ssh.ts:73`),
  so GIT-1 is an ownership/wiring gap owned by the new SG (SSH Git) slice, not a
  capability gap.
- socket.io-client has NO constructor option to disable the reconnect send
  buffer (BP-3): the mechanism is clearing `socket.sendBuffer` on
  connect/reconnect (or a wrapper); `volatile` for latest_wins/droppable only.

## Canonical Rows

| id | source | owner | files/harness | command | red | green | freshness guard | split trigger |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SCHEMA-1 | PROTO Shared Envelope, Zod v4 runtime authority | S1 | `packages/control-protocol-contracts/src/**/*.unit.test.ts` | `pnpm test:unit` | malformed envelope accepted | strict parse rejects malformed and unknown keys | negative fixtures include extra, missing, wrong-type fields | split if JSON Schema export needs separate tooling |
| SCHEMA-2 | PROTO JSON Schema export expectations | S1 | `packages/control-protocol-contracts/src/schema-artifacts.unit.test.ts` or package-local equivalent | `pnpm test:unit` | schema snapshot absent or stale | JSON Schema artifact matches Zod schema output | snapshot generated from current Zod module in test | split exporter if cross-package artifact writer is non-trivial |
| SCHEMA-3 | PROTO envelope/domain/kind equality | S1 | `packages/control-protocol-contracts/src/control-envelope.unit.test.ts` | `pnpm test:unit` | mismatched `kind`/domain/operation accepted | mismatches fail closed before dispatch | test imports shared enums, not string copies | split if enum ownership changes |
| SCHEMA-4 | PROTO single shared envelope layering | S1 | `packages/control-protocol-contracts/src/control-envelope.unit.test.ts` | `pnpm test:unit` | domain schema can replace shared identity fields | domain payload cannot override shared envelope identity | fixture repeats identity fields and asserts mismatch rejection | split if domain packages need shared test helpers |
| SCHEMA-5 | PROTO forbidden bulk and wrong-domain rejection | S1 | `packages/control-protocol-contracts/src/control-envelope.unit.test.ts` plus gateway/worker domain unit tests | `pnpm test:unit` | bulk payload or wrong domain reaches handler | `forbidden_bulk` and wrong-domain close/reject paths fire | planted positive bulk fixture exceeds control limit | split if close reason lives outside S1 |
| SCHEMA-6 | PROTO close reason/session state/protocol version | S1 | `packages/control-protocol-contracts/src/session-state.unit.test.ts` | `pnpm test:unit` | protocol mismatch resyncs or hangs | `protocol_version_mismatch` closes fail-closed | test includes supported literal and future literal | split if version negotiation is added |
| DELIVERY-1 | PROTO delivery classes latest-wins | S1/S2/SWb | `packages/control-protocol-contracts/src/delivery-policy.unit.test.ts` plus gateway/worker peer-service integration tests | `pnpm test:unit` and `pnpm test:integration` | latest state queues all stale values, reserves hard sequence slots, or advances the hard sequence frontier across lossy gaps | latest-wins coalesces by key, flushes queued messages in envelope-sequence order, uses volatile peer emit, and never advances/reserves the critical sequence frontier | fixture emits multiple same-key states plus a later critical command after a lossy sequence gap | split if coalescer becomes runtime-only |
| DELIVERY-2 | PROTO droppable/progress policy | S1/S2/SWb | `packages/control-protocol-contracts/src/delivery-policy.unit.test.ts` plus gateway/worker peer-service integration tests | `pnpm test:unit` and `pnpm test:integration` | droppable progress replays after reconnect, reserves hard sequence slots, or makes a later critical message look stale | droppable messages are dropped/volatile under pressure/reconnect and do not advance/reserve the critical sequence frontier | reconnect fixture has stale progress and a subsequent critical message using the next reserved hard sequence | split if Socket.IO volatile wrapper owns behavior |
| DELIVERY-3 | PROTO acked command timeout/dedupe | S3/S4a | `packages/agent-vm/src/controller/control-session/**/*.integration.test.ts` | `pnpm test:integration` | lost ack repeats side effect | duplicate command returns cached terminal result, side effect count 1 | test counts handler invocation | split if command store is separate module |
| DELIVERY-4 | PROTO single_use_critical reconnect behavior | S3/SWc | controller control-session integration + worker RPC integration | `pnpm test:integration` | reconnect replays stale mutation | mutation is retried only by explicit command id/idempotency policy | constructed client send buffer option asserted | split if worker/gateway policies diverge |
| DELIVERY-5 | CUT incident-critical append-only health observation | S1/S6c | health observation store/reducer unit + integration tests | `pnpm test:unit` and `pnpm test:integration` | 24 health events collapse to latest-wins | all 24 discrete observations remain queryable | regression fixture routes through latest-wins and must fail | split if storage migration needed |
| HANDSHAKE-1 | PROTO/CUT header-only credential schema | S1 | `packages/control-protocol-contracts/src/handshake.unit.test.ts` | `pnpm test:unit` | query-string credential accepted | query credentials rejected; headers parsed strictly | fixture includes `?token=` and Engine.IO query | split if header normalizer is runtime-owned |
| HANDSHAKE-2 | PROTO duplicate nonce rejection without incumbent eviction | S2 | `packages/openclaw-agent-vm-plugin/src/gateway-control-service/**/*.integration.test.ts` | `pnpm test:integration` | duplicate nonce evicts accepted session | duplicate valid nonce rejected; incumbent remains | test holds incumbent socket open | split if nonce store extracted |
| HANDSHAKE-3 | PROTO atomic consume concurrent double-present | S2 | gateway control service integration test | `pnpm test:integration` | two simultaneous upgrades succeed | exactly one of two concurrent presentations succeeds | test uses concurrent upgrade attempts, not sequential calls | split if Engine.IO harness is flaky |
| HANDSHAKE-4 | PROTO non-revealing/rate-limited auth failures | S2 | gateway control service integration test | `pnpm test:integration` | auth errors leak reason or unlimited attempts | failures are generic and rate-limited | test asserts response shape and repeated attempts | split if limiter is shared package |
| HANDSHAKE-5 | PROTO/CUT pre-101 private auth over real ingress | S2/S3 | new `*.openclaw.e2e.test.ts` ingress rig | `mise exec -- pnpm run test:e2e:openclaw` | bad credential reaches 101 or app connect | bad credential rejected before 101; good connects | runtime logs include transport `websocket`; no polling | split if GATE-0a fails placement |
| FENCE-1 | PROTO identity/fencing/generation rules | S3 | controller control-session integration test | `pnpm test:integration` | stale generation mutates state | stale generation rejected; before/after snapshot equal | state snapshot captured before and after stale message | split if generation store not yet centralized |
| CORR-1 | CUT correlation allowlist/operator evidence | S6c | health/event reducer unit + integration tests | `pnpm test:unit` and `pnpm test:integration` | raw sessionKey or non-allowlisted field propagates | only traceId/runId/sessionKeyDigest/toolCallId survive | planted non-allowlisted field rejected | split if telemetry export shape changes |
| BP-1 | PROTO bounded queues/overflow close | S3 | controller control-session queue integration test | `pnpm test:integration` | queue grows unbounded or extends liveness | overflow closes/stales without liveness extension | test forces cap using exported constants | split if queue implementation becomes per-domain |
| CONTROLLER-CEILING | PROTO controller resource ceiling: broker, never buffer | S3 | controller memory-ceiling integration test | `pnpm test:integration` | controller buffers bulk/stream data, or per-session memory grows with event/stream volume | forbidden_bulk rejected on the control socket; controller per-session memory stays bounded under a bulk + high-volume flood; heavy data never transits the heap/control socket | flood mixes forbidden_bulk + high-volume events; assert reject + bounded memory, not proxy-through | split if a brokered streaming path is added later |
| BP-2 | PROTO priority lanes and fail-safe stale | S3 | controller control-session integration test | `pnpm test:integration` | heartbeat blocked behind bulk/progress | heartbeat lane priority preserved; fail-safe stale fires | test saturates low-priority lane first | split if lane scheduler is separate module |
| BP-3 | PROTO no unbounded Socket.IO reconnect buffer | S3 | controller client reconnect integration test | `pnpm test:integration` | stale emit buffered during disconnect auto-flushes as fresh on reconnect | stale application emits do NOT deliver after reconnect (sendBuffer cleared on connect/reconnect, or wrapper) | NOTE: socket.io-client has NO constructor option to disable the buffer — test drives a real disconnect/reconnect and asserts the stale emit is not delivered, NOT a constructor flag | split if wrapper vs sendBuffer-clear diverge |
| BP-4 | PROTO timing-order invariants | S1 | control constants unit test | `pnpm test:unit` | constants violate ordering | chosen constants satisfy heartbeat < TTL, connect+ack < active-use-start, transport death < lease stale | test imports exported constants and current lease defaults | split only if constants module moves |
| BP-5 | PROTO forbidden bulk on control channel | S1/S3 | contract unit + controller integration tests | `pnpm test:unit` and `pnpm test:integration` | bulk payload accepted on control channel | oversized/bulk message rejected with close reason | payload size crosses `maxHttpBufferSize` | split if message limit lives in runtime config |
| FLAP-1A | PROTO reconnect/resync deterministic path | S3 | fake VM Socket.IO integration rig | `pnpm test:integration` | flap extends active-use liveness or skips resync | each flap classified; hello/resync before liveness resumes | repeated disconnect count is explicit fixture input | split if recovery policy dependencies leak in |
| FLAP-1B | CUT real-runtime flap/soak proof | S2/S3 | new `*.openclaw.e2e.test.ts` soak rig | `mise exec -- pnpm run test:e2e:openclaw` | real ingress flap wedges session or SSH | real controller+plugin+Gondolin resyncs; Tool VM SSH survives | soak count >= incident-motivating count | split if runtime instability requires separate debug plan |
| INGRESS-1 | CUT controller-to-VM Socket.IO through Gondolin | S2/S3 | new `*.openclaw.e2e.test.ts` ingress rig | `mise exec -- pnpm run test:e2e:openclaw` | no 101 or native/raw WS mismatch | Socket.IO client connects with `transport=websocket` | request URL includes Engine.IO websocket transport; no polling | split if GATE-0a blocks placement |
| RPC-VM-1 | CUT controller-originated gateway_control_rpc over private VM route | S2/S3/S4a | new `*.openclaw.e2e.test.ts` controller RPC route rig | `mise exec -- pnpm run test:e2e:openclaw` | ingress-connect-only proof passes while no controller command/result traverses the VM route, or command falls back to controller HTTP/raw TCP | controller sends `control_ping` over `/__agent-vm/gateway-control` to the managed VM and receives a typed `GatewayControlRpcCommandResultMessageSchema` `ok` result with matching domain/session/request identity | asserts websocket-only transport, route path without `/socket.io`, no `controller.vm.host:18800` control path, and parsed domain result rather than log text | split if lease RPC parity needs a separate live Tool VM proof after the ping route is green |
| INGRESS-2 | PROTO Socket.IO server/client options | S1/S2/S3 | option unit tests + ingress e2e assertion | `pnpm test:unit` and `mise exec -- pnpm run test:e2e:openclaw` | polling/compression/large default buffer accepted | websocket-only, configured buffer cap, compression policy asserted | test checks constructed options and runtime transport | split if option ownership crosses packages |
| RESIDUE-1 | CUT no `controller.vm.host:18800` control path | S5a | `scripts/audit-control-residue.ts` or architecture gate | `pnpm check` | current raw control strings in shippable surfaces pass | shippable control path residues fail the gate | allowlist separates specs/tests from shipped docs/runtime | split if audit false positives dominate |
| RESIDUE-2 | CUT raw tcpHosts/allowedHosts fail-closed | S5a/S5c | OpenClaw/Worker lifecycle unit + boot-fail integration | `pnpm test:unit` and `pnpm test:integration` | tcpHosts/allowedHosts still include controller/collector raw path | delivered tcpHosts only Tool VM SSH; collector-mode raw tcpHosts fail closed | planted positive fixture must fail | split if a future collector replacement transport needs a new spec |
| RESIDUE-3 | CUT no Worker `CONTROLLER_BASE_URL` callback | SWc | worker lifecycle/task-runner unit + architecture gate | `pnpm test:unit` and `pnpm check` | Worker controller tools still use callback base URL | git tools route through worker_control_rpc | planted env var usage fixture fails audit | split if worker runtime config changes shape |
| RESIDUE-4 | CUT Tool Portal backend taxonomy and MCP identity | S7/S5b | config-contract unit + portal architecture audit + managed Tool Portal runtime unit | `pnpm test:unit` and `pnpm check` | old `mcp`/`credentialed_runner` or MCP plugin identity remains shippable, or session-scoped MCP backend state survives entrypoint eviction/runtime close | only accepted backend taxonomy and `tool_portal_*` surface remain; managed entrypoint eviction/runtime close retires session-scoped MCP backend/session state | audit allowlist excludes historical specs/tests; runtime fixture evicts at least one session and closes the runtime with remaining sessions | split if image build proof is too slow |
| RESIDUE-5 | CUT `gateway-control-link` removal from health/recovery | S6a/S5a | health reducer/recovery unit + residue audit | `pnpm test:unit` and `pnpm check` | control-link remains current readiness/recovery source | control-session event kind replaces it | generated manual output scanned as shippable surface | split if manual template update needs separate task |
| RESIDUE-6 | CUT old controller route disposition | S4b/S6b/S7 | controller HTTP route integration test | `pnpm test:integration` | old mutation routes return unauthenticated success | deleted routes 404; retained routes require operator auth | tests cover all four route families in S4b table | split per route family if auth policy is unsettled |
| RECOVERY-1 | CUT control-session-unhealthy recovery trigger | S6b | recovery policy unit test | `pnpm test:unit` | gateway-control-link trigger still drives recovery | control-session-unhealthy replaces old trigger | fixture includes old trigger and must fail | split if state-machine names change |
| RECOVERY-2 | CUT forged observation budget/corroboration | S6b | recovery policy unit + controller integration test | `pnpm test:unit` and `pnpm test:integration` | forged observations trigger recovery or reset budget by spoofing source | controller-owned source key budget plus probe corroboration required | spoofed payload source fields varied in fixture | split worker path until Q2 is resolved |
| RESILIENT-GRACE | days-long: recovery is not over-sensitive | S3/S6b | control-session death-grace unit + controller integration | `pnpm test:unit` and `pnpm test:integration` | a transport blip while the owning controller process is alive triggers a VM recreate | reconnect within the death-grace resyncs and CANCELS recovery; recovery fires only after the grace elapses with no reconnect | fixture disconnects for < grace (must NOT recover) and > grace (must recover), using the exported grace constant; controller process restart/redeploy is excluded and covered by RECREATE-FENCE until a Gondolin VM-adoption API exists | split gateway/worker if grace differs |
| RECREATE-FENCE | days-long: recreate-VM reattach fencing | S3/S6b | controller session integration test | `pnpm test:integration` | post-recreate new-boot session rejected, or lingering old-boot/old-epoch traffic still mutates | new bootId + new controllerEpoch session accepted and resyncs; old-boot/old-epoch messages fenced | fixture presents old-boot and new-boot sessions; asserts old fenced, new accepted | split if boot vs epoch fencing diverge |
| GIT-1 | CUT host-boundary receive-pack denial (CUT:1844-1858, 2316-2322) | SG (SSH Git) | gondolin-adapter ssh-egress+execPolicy surface + openclaw-lifecycle.ts/worker-lifecycle.ts VM-spec wiring; new `*.vm.e2e.test.ts` git egress rig | `mise exec -- pnpm run test:e2e:vm` | no egress execPolicy exists (net-new); VM can run receive-pack or non-git exec over raw egress | receive-pack and non-git exec denied at host boundary; upload-pack allowed to configured upstream git hosts | proves Gondolin boundary (SshExecPolicy), not mocked git policy; adapter-level repo allowlisting remains separately covered when a trusted repo set is supplied | split gondolin-adapter surface from 2-lifecycle wiring |
| GIT-2 | CUT controller push policy | SWc | `git-push-operations` unit/integration tests | `pnpm test:unit` and `pnpm test:integration` | default/protected/force/non-ff/delete push allowed | controller refuses unsafe refs and non-ff cases | trusted state fixture includes protected patterns | split if trusted policy source needs schema work |
| GIT-3 | CUT no git pack over control socket | SWc/S3 | worker RPC integration test | `pnpm test:integration` | pack data travels through Socket.IO control channel | RPC carries intent/result only; pack path absent | payload size and operation schema inspected | split if artifact/log channel is added |
| SURFACE-1 | CUT lease/use RPC parity with controller authority | S4a | lease RPC integration test | `pnpm test:integration` | gateway-supplied authority fields trusted or parity missing | controller recomputes authority; lease/use behavior matches old API | before/after parity fixture covers identityPem snapshot | split if lease manager requires adapter seam |
| DOMAIN-SEP-1 | PROTO/CUT domain separation and event-only operation shape | S1/S4a/SWa | domain contract unit tests | `pnpm test:unit` | worker op accepted by gateway union, gateway op accepted by worker union, or event-only op accepted as command_result | cross-domain operations reject before dispatch; `worker_capacity_snapshot`, `worker_runtime_status`, and `worker_runtime_observation` cannot appear as command_result | test imports both domain packages and includes every event-only operation | split if package shells not ready |
| DP-TRUST | PROTO deliveryPolicy is derived, not trusted (AF-2) | S1/S3 | delivery-policy trust unit (S1) + control-session dispatch integration (S3) | `pnpm test:unit` and `pnpm test:integration` | receiver trusts envelope `deliveryPolicy`; a `single_use_critical` mutation mislabeled `latest_wins` coalesces or replays | receiver derives class from `(operation, payload)` and fails closed on a contradicting envelope `deliveryPolicy` | fixture sends a mutation with a deliberately wrong `deliveryPolicy` and asserts fail-closed, not silent accept | split if per-domain policy tables diverge |
| KIND-EXACT | PROTO every message kind has an owning home (AF-3) | S1 | control-envelope/kind unit test | `pnpm test:unit` | a declared `ControlMessageKindSchema` value has no payload/handler branch | every kind resolves to an owning payload/handler (resync via hello; snapshot/heartbeat/observation mapped per PROTO disposition); an unmapped kind fails | test enumerates the kind enum and asserts each maps; `resync_request`/`resync_response` are absent | split if kind ownership crosses packages |

## Harnesses

| harness | layer | env/command | owners | purpose |
| --- | --- | --- | --- | --- |
| control-contract unit suites | unit | `pnpm test:unit` | S1/S4a/SWa | Zod, JSON Schema, domain exactness |
| controller-session runtime rig | integration | `pnpm test:integration` | S3 | fake VM Socket.IO, reconnect, backpressure, fencing |
| gateway-control service integration | integration | `pnpm test:integration` | S2 | pre-101 auth seam, nonce state machine |
| ingress-upgrade Socket.IO e2e | e2e-openclaw | `mise exec -- pnpm run test:e2e:openclaw` | S2/S3 | real controller to VM Socket.IO through Gondolin ingress |
| controller RPC route e2e | e2e-openclaw | `mise exec -- pnpm run test:e2e:openclaw` | S2/S3/S4a | real controller-originated gateway_control_rpc command/result over the managed VM private route |
| flap/soak e2e | e2e-openclaw | `mise exec -- pnpm run test:e2e:openclaw` | S2/S3 | real reconnect/resync under repeated flaps |
| control-residue audit | architecture gate | `pnpm check` | S5/S6/S7/SW | no shippable old control vocabulary/surfaces |
| controller route disposition | integration | `pnpm test:integration` | S4b/S6b/S7 | 404/auth for old HTTP mutation routes |
| git-egress denial | e2e-vm | `mise exec -- pnpm run test:e2e:vm` | SG (SSH Git) | host-boundary receive-pack denial (gondolin-adapter execPolicy) |
| worker control e2e | e2e-worker | `set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker` | SWb/SWc | Worker Socket.IO handshake and git RPC path; the bare command may fail the evidence wrapper because live Worker model tests skip without this credential mapping |
| full-system beta deployment | external live proof | `../shravan-claw-beta` deployment run/logs | parent/PR wrapup | actual Discord plus actual OpenClaw managed runtime; no fake Discord provider or mock OpenClaw substitute |

## Open Questions

Blocking before named gate/slice:
- OPEN-4 proof-gating disposition is a user decision: either keep the three
  commands as explicit required lanes or add them to CI/default proof
  infrastructure with approval.
- Q2 worker corroboration probe source blocks only the Worker branch of S6b.

User implementation decision:
- Q1 per-route delete vs operator-auth-gate uses the plan default of deleting
  VM-mutation routes unless the user overrides before S4b.

Tune during implementation:
- Queue message cap, queue byte cap, dedupe/replay window, per-source
  observation budget, and the control-session-death/recovery grace are planning
  defaults. Tests assert behavior and ordering (RESILIENT-GRACE proves in-process
  transport reconnect within grace cancels recovery; recovery only after grace),
  not final magnitude. Controller process restart/redeploy is a recreate boundary
  for this cutover, not a RESILIENT-GRACE reconnect case.
- append_only_observation and dedupe windows are ROLLING/bounded over multi-day
  sessions — they must not accumulate for days. Tests assert boundedness.
- OPEN-3 `observation` kind defaults to retain-with-note unless S1 enum
  exactness work finds a cleaner removal.

Companion always-run gates:
- `pnpm typecheck`
- `pnpm lint`
- `pnpm lint:types`
- `pnpm fmt:check`
- `pnpm check:zod`
- `pnpm check`
- External `../shravan-claw-beta` full-system proof with actual Discord and
  actual OpenClaw before PR-ready status, or a concrete blocked-attempt record
  if live credentials/runtime prerequisites are unavailable.
  The proof must first refresh beta with local tarballs, reconcile the selected
  OpenClaw runtime to the PR target or recorded GATE-0a newer-version evidence,
  then exercise beta's real Discord `#beta-debug`/`pulse-bot` binding and
  capture redacted controller/OpenClaw/Discord evidence.
