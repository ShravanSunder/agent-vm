# Hermes Framework OpenTelemetry Implementation Plan

Date: 2026-07-29
Source:
`../2026-07-29-hermes-framework-opentelemetry.md`
Validated source: 664 lines,
SHA-256 `5936e64d5f26169734b4619974df6d124b390b4be760b030f767efeb91f4ad0b`
Validated base: `93ad40964571317bcfb6bba4a5c6c8bbdb4c98b2`

## Goal

Extend the existing in-process `agent-vm-hermes-adapter` OpenTelemetry runtime
to emit bounded Hermes turn, provider-attempt, and pinned `post_tool_call`
telemetry through the existing mediated OTLP path.

The implementation must preserve the single process, wheel, plugin entry point,
Tool Portal operation trace, RealFS state, RAM-only profile secrets, and
Gondolin mediation boundaries.

## Non-goals

- No new process, plugin distribution, entry point, service, collector, queue,
  timer, persistence, migration, recovery, or compatibility path.
- No upstream Hermes or Gondolin change.
- No direct collector network route.
- No prompt, response, tool-content, raw-error, identity, or secret capture.
- No private Hermes ContextVar dependency.
- No microbenchmark framework or flaky wall-clock performance assertion.

## Current baseline

- Hermes lifecycle unit:
  `14 passed`, Vitest test duration `185ms`; command wall time `1.81s`.
- Existing focused Python plugin/package tests after
  `uv sync --locked --all-packages`:
  `13 passed, 9 subtests passed`; pytest duration `2.90s`, command wall time
  `3.16s`.

These timings are comparison evidence only. Deterministic call-count,
event-order, queue-bound, and non-blocking tests own the performance contract.

## Write surfaces

Production:

- `packages/hermes-gateway/src/hermes-lifecycle.ts`
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_tool_portal_observability.py`
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_framework_observability.py`
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_tool_portal_capability_tools.py`
- `python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py`

Tests:

- `packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts`
- `python/agent-vm-hermes-adapter/tests/test_managed_tool_portal_observability.py`
- `python/agent-vm-hermes-adapter/tests/test_managed_framework_observability.py`
- `python/agent-vm-hermes-adapter/tests/test_managed_tool_portal_capability_tools.py`
- `python/agent-vm-hermes-adapter/tests/test_managed_gateway_bootstrap.py`
- `python/agent-vm-hermes-adapter/tests/test_package_boundary.py`
- one focused Hermes observability E2E under
  `packages/agent-vm/src/integration-tests/`

The plan does not authorize edits to configuration schemas, controller
ownership, Gondolin mediation, collector configuration, image recipes, package
dependencies, or upstream checkouts.

## Vertical slices

### Slice 1: lifecycle signal and admission contract

Requirements: R1–R3, R13.

Red:

- Extend `hermes-managed-contracts.unit.test.ts` to require:
  - exact `OTEL_{TRACES,METRICS,LOGS}_EXPORTER=otlp|none`;
  - `AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES`;
  - `AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS`;
  - controller-authored `OTEL_RESOURCE_ATTRIBUTES`;
  - rejection of protected OTel overrides.

Green:

- Project only those values in `hermes-lifecycle.ts`.
- Source the two adapter-private limits from the existing framework admission
  limits.
- Do not change the public configuration schema.

Checkpoint:

```text
pnpm vitest run packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts
```

### Slice 2: process-owned signal runtime and admission

Requirements: R3, R9, R11–R13.

Red:

- Add focused Python tests for:
  - exact signal selector parsing and invalid/unset values;
  - all-signals-disabled zero-constructor fast path;
  - independent provider/exporter creation;
  - per-signal constructor failure;
  - closed resource allowlist;
  - record-size boundaries;
  - flush/shutdown isolation.

Green:

- Keep provider ownership in `managed_tool_portal_observability.py`.
- Construct only enabled signals.
- Use explicit resources rather than ambient detector ingestion.
- Enforce the two projected admission limits.
- Keep exporter queues bounded and asynchronous.

Performance gate:

- With all signals `none`, assert zero provider, exporter, processor,
  instrument, serialization, propagation, or network constructor calls.
- With enabled exporters blocked on test events, prove observation callbacks
  return before exporters are released.
- Do not add elapsed-time pass/fail thresholds.

Checkpoint:

```text
uv run pytest python/agent-vm-hermes-adapter/tests/test_managed_tool_portal_observability.py -q
```

### Slice 3: framework hook mapper and single-entry-point composition

Requirements: R4–R12, R14.

Red:

- Add mapper tests covering all six framework hooks, exact callback `None` returns,
  closed attributes/result classes, numeric/string bounds, failover reason,
  `post_tool_call`-supplied duration, malformed values, content canaries, and
  forbidden arbitrary `str()` conversion.
- Add capped turn/API-request map tests, matching-only cleanup, turn-scoped
  `on_session_end`, missing/duplicate/out-of-order hooks, and shutdown.
- Interleave two turns and provider attempts with barriers/events and prove
  parent/attribute isolation.
- Assert registered names belong to `hermes_cli.plugins.VALID_HOOKS` and the
  observer schema remains `hermes.observer.v1`.
- Execute the installed Hermes `finalize_turn` boundary and require the
  authoritative `on_session_end` `turn_id`, `completed`, and `interrupted`
  payload. Keep the exact distribution and lockfile-hash gates so a Hermes
  update cannot silently bypass compatibility review.

Green:

- Put framework hook mapping and correlation in
  `managed_framework_observability.py`.
- Register it through the existing `agent-vm-tool-portal` entry point.
- Keep `pre_tool_call` unregistered.
- Build tool observations only from `post_tool_call`.
- Keep the Tool Portal operation trace independent and preserve its existing
  parentage into the common Gateway Runtime producer.

Checkpoint:

```text
uv run pytest \
  python/agent-vm-hermes-adapter/tests/test_managed_framework_observability.py \
  python/agent-vm-hermes-adapter/tests/test_managed_tool_portal_capability_tools.py \
  python/agent-vm-hermes-adapter/tests/test_managed_gateway_bootstrap.py \
  python/agent-vm-hermes-adapter/tests/test_package_boundary.py -q
```

### Slice 4: packaged and live mediated proof

Requirements: R1–R14.

- Build and inspect the wheel. Confirm the single existing plugin entry point,
  exact pinned dependencies, and new module inclusion.
- Add one real Hermes E2E using the existing harness:
  - real controller, Gondolin VM, installed wheel, and pinned Hermes;
  - more than one actual provider attempt with provider/model transition;
  - one non-Tool-Portal and one Tool Portal `post_tool_call`;
  - traces, metrics, and logs through mediated OTLP;
  - Victoria query for fresh `service.name=agent-vm-hermes`;
  - Tool Portal operation trace into `agent-vm-tool-portal`;
  - forbidden-canary absence and approved resource identity presence.
- Keep independent signal-negative boots separate if one test would otherwise
  require four VM lifecycles.

Checkpoints:

```text
uv build --package agent-vm-hermes-adapter
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:hermes
```

## Requirements and proof matrix

| Requirements | Owner | Proof |
| --- | --- | --- |
| R1–R3 | Slice 1–2 | lifecycle unit + signal-construction unit + wheel inspection |
| R4–R8 | Slice 3–4 | hook-manager integration + real Hermes E2E/Victoria |
| R9 | Slice 2–4 | record/resource canaries in SDK records, encoded OTLP, Victoria |
| R10–R11 | Slice 3 | concurrent barrier tests + fixed-cap map tests |
| R12 | Slice 2–3 | constructor/export/hook/flush/shutdown fault injection |
| R13 | Slice 1, 4 | unchanged mediation tests + real mediated OTLP |
| R14 | Slice 3 | `VALID_HOOKS`, schema version, and pinned package assertions |
| performance | Slice 2–3 | zero-work disabled path + event-based non-blocking proof + baseline comparison |

Every behavior slice requires red/green evidence. A broader E2E does not replace
its unit or integration checkpoint.

## Execution DAG

```text
gate 0: validate source, branch, baseline tests
  |
  +-- lane A: lifecycle projection + TS red/green
  |
  `-- lane B: Python runtime admission + red/green
             |
             `-- framework hook mapper + plugin composition
                         |
integration gate: parent reviews full diff and reruns targeted suites
  |
wheel build and inspection
  |
Hermes mediated-OTLP E2E
  |
full Python quality + pnpm check
  |
implementation-review-swarm
```

Lane A and the initial part of lane B have disjoint write sets. Framework hook
composition follows the runtime interface and remains serial with Python
integration.

## Full validation

```text
uv run ruff format --check python
uv run ruff check python
uv run ty check
uv run pytest
pnpm vitest run packages/hermes-gateway/src/hermes-managed-contracts.unit.test.ts
pnpm check
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:hermes
```

## Split and stop triggers

- Stop and reconverge if implementation requires `pre_tool_call`, private
  Hermes ContextVars, cross-hook attached context, another plugin/process, or
  upstream/Gondolin changes.
- Split SDK/exporter construction from record mapping if tests require private
  OTel internals.
- Split positive Hermes/Victoria proof from signal-negative boots if a single
  test becomes a multi-VM state machine.
- Do not edit unrelated infrastructure in response to an out-of-scope E2E
  failure.
- No migration or rollback mechanism is needed; the change is process-local
  and disabling the three existing signal booleans returns the runtime to a
  no-emission state.

## Open questions

None. Any new architecture, authority, persistence, or public configuration
need is a design break, not an implementation detail.
