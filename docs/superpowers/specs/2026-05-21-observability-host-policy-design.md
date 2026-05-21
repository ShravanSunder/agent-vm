# Observability — Host-Owned Debug/Log Policy + Zone External Resources

**Date:** 2026-05-21
**Worktree:** `feat/observability-host-policy`
**Owner repo:** `agent-vm` (consumed by `shravan-claw` and any other deployment).

## Goal

Make `agent-vm` the source of truth for two observability mechanisms so a deployment like `shravan-claw` configures them once and the controller fans out the policy to every subsystem.

1. **Unified debug/log policy.** A single `host.logging` block in `system.json` (with CLI/env overrides) sets one effective level. The controller translates that into native config for OpenClaw (`logging.level`), Gondolin (`sandbox.debug` + `debugLog`), and the worker runtime (`LOG_LEVEL` env). Operators run one command — `agent-vm controller start --debug` — and every subsystem starts emitting at the right level.
2. **Zone-level external TCP resources.** Reuse the existing `externalResourcesSchema` at zone scope so a deployment can declare host services (Victoria stack, etc.) that the Gateway VM reaches over Gondolin synthetic DNS. This is the plumbing for an OTLP exporter in OpenClaw to push to a host-side Victoria stack without forking agent-vm.

Both features live in `agent-vm`. A deployment opts in via `system.json` and/or CLI flags at `controller start`. shravan-claw uses both (debug for incident response, externalResources for the Victoria stack).

## Architecture

```
┌─ agent-vm (the implementation) ─────────────────────────────┐
│                                                             │
│  system.json:                                               │
│    host.logging       (new, Phase A)                        │
│    zones[N].externalResources   (new, Phase B — reuses      │
│                                  existing schema)           │
│                                                             │
│  CLI:                                                       │
│    --log-level <level>  (Phase A)                           │
│    --debug              (Phase A, alias)                    │
│    --gondolin-debug <flags>  (Phase A escape hatch)         │
│                                                             │
│  Env:                                                       │
│    AGENT_VM_LOG_LEVEL              (Phase A)                │
│    AGENT_VM_GONDOLIN_DEBUG         (Phase A escape hatch)   │
│                                                             │
│  Effective resolver:                                        │
│    CLI flag ▸ env ▸ host.logging.* ▸ defaults               │
│                                                             │
│  Propagation (single direction):                            │
│    effective policy ──► OpenClaw logging.level              │
│                    ──► Gondolin sandbox.debug + debugLog    │
│                    ──► worker LOG_LEVEL env                 │
│    zone.externalResources ──► buildGatewayTcpHosts overlay  │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─ shravan-claw (the consumer) ───────────────────────────────┐
│                                                             │
│  system.json:                                               │
│    host.logging.level = "info"   (default)                  │
│    zones[sunfam].externalResources = { vm-metrics, ... }    │
│                                                             │
│  Per-incident override:                                     │
│    pnpm start --debug              (or env)                 │
│                                                             │
│  docker-compose.observability.yml (operator-managed)        │
│                                                             │
│  config/gateways/sunfam/openclaw.json:                      │
│    diagnostics.otel.{metrics,logs,traces}Endpoint           │
│      pointing at vm-metrics.observability.vm.host:8428 etc. │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Grounded references

Local checkouts:
- agent-vm: `~/Documents/dev/project-dev/agent-vm.feat-observability-host-policy` (worktree off master @ `667937a`).
- openclaw: `~/Documents/dev/open-source/openclaw` at `2026.5.16-beta.3`.

Files referenced (verified current as of master `667937a`):

- `packages/agent-vm/src/config/system-config.ts:344-360` — `host: z.object({...})` (current shape has controllerPort, projectNamespace, secretsProvider, githubToken; **no logging field yet**).
- `packages/agent-vm/src/config/system-config.ts:369-389` — zone schema, currently has `egressHosts` and `websocketBypass`; **no `externalResources`** yet.
- `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts:125-147` — existing `externalResourceSchema` and `externalResourcesSchema` (used today for worker tasks).
- `packages/agent-vm/src/resources/resource-compiler.ts:62-88` — existing `compileResourceOverlay()` that turns externalResources into a tcpHosts overlay. Reused at zone scope in Phase B.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts:51-68` — `buildGatewayTcpHosts()`. The Phase B merge point.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts:348-358` — `buildEffectiveLoggingConfig()`. Today only injects `logging.file`. The Phase A translation point for OpenClaw.
- `packages/gondolin-adapter/src/vm-adapter.ts:90-103` — `CreateVmOptions`. Phase A adds `debug` + `debugLog` here.
- `packages/gondolin-adapter/src/vm-adapter.ts:284-324` — VM.create() invocation. Phase A passes `sandbox.debug` and `debugLog` through.
- `packages/agent-vm/src/cli/commands/controller-definition.ts:109-128` — `controller start` definition. Phase A adds `--log-level` / `--debug` / `--gondolin-debug` flags.
- `packages/agent-vm/src/cli/agent-vm-cli-support.ts:89-106` — `startControllerRuntime` options. Phase A threads the effective policy through.
- `packages/agent-vm/src/cli/vm-host-system-templates.ts:163-170` — generated systemd ExecStart. Phase A teaches the template to honor `AGENT_VM_LOG_LEVEL`.
- `packages/worker-gateway/src/worker-lifecycle.ts:25-75` — worker gateway VM spec. Phase A adds the same Gondolin debug plumbing and `LOG_LEVEL` env propagation.

Gondolin API (from `node_modules/.../gondolin@0.9.1/dist`):
- `VMOptions.sandbox.debug?: boolean | DebugFlag[]` — `server-options.d.ts:72-81`.
- `VMOptions.debugLog?: (component: string, message: string) => void` — `vm/types.d.ts:22-58`.
- `DebugFlag = "net" | "exec" | "vfs" | "protocol"` — `debug.d.ts:1-17`.

OpenClaw config (from `~/Documents/dev/open-source/openclaw`):
- Log levels are silent | fatal | error | warn | info | debug | trace — `src/logging/levels.ts:1-9`.
- `OPENCLAW_LOG_LEVEL` env override — `src/logging/env-log-level.ts:6`.
- OTEL plugin shape — `docs/gateway/opentelemetry.md`.

## Phase A — Unified debug/log policy

### Schema

Add to `host` object schema in `system-config.ts`:

```typescript
logging: z.object({
  level: z.enum(['silent','fatal','error','warn','info','debug','trace']).default('info'),
  gondolin: z.union([
    z.literal('default'),
    z.literal('off'),
    z.literal('all'),
    z.array(z.enum(['net','exec','vfs','protocol'])),
  ]).default('default'),
  openclaw: z.union([
    z.literal('inherit'),
    z.enum(['silent','fatal','error','warn','info','debug','trace']),
  ]).default('inherit'),
  worker: z.union([
    z.literal('inherit'),
    z.enum(['silent','fatal','error','warn','info','debug','trace']),
  ]).default('inherit'),
}).default(() => ({ level: 'info', gondolin: 'default', openclaw: 'inherit', worker: 'inherit' })),
```

### Resolution

Effective policy = `CLI flag ▸ env ▸ host.logging.* ▸ defaults`. Resolver lives in a new module `packages/agent-vm/src/logging/effective-logging-policy.ts` and is called once by the controller start handler.

Default mapping for `gondolin: "default"` and `openclaw/worker: "inherit"`:

| `level` | Gondolin                        | OpenClaw | Worker |
| ------- | ------------------------------- | -------- | ------ |
| info    | off                             | inherit  | info   |
| debug   | `["net", "exec", "vfs"]`        | debug    | debug  |
| trace   | true (all four flags)           | trace    | trace  |
| warn / error / fatal / silent | off | matches level | matches level |

Explicit subsystem keys (e.g. `host.logging.gondolin = ["net"]`) override the level-derived default for that subsystem.

### CLI

`agent-vm controller start` gains:

```
--log-level <silent|fatal|error|warn|info|debug|trace>
--debug                       # alias for --log-level debug
--gondolin-debug <flags>      # comma-separated; "off" or "all" accepted
```

Env equivalents: `AGENT_VM_LOG_LEVEL`, `AGENT_VM_GONDOLIN_DEBUG`.

### Translation

The effective policy is consumed at three boundaries:

1. `buildEffectiveLoggingConfig` in `openclaw-lifecycle.ts` injects `logging.level` (the file path stays as today). It preserves an explicit author `logging.level` in `openclaw.json` only when the host policy says `openclaw: "inherit"` AND a level is authored. Otherwise host policy wins.
2. `gondolin-adapter/vm-adapter.ts` `createManagedVm` accepts `debug` and `debugLog` options and passes them into `VM.create({ sandbox: { debug }, debugLog })`.
3. Worker gateway and openclaw gateway both pass the same translated env (`LOG_LEVEL`, `OPENCLAW_LOG_LEVEL`) and Gondolin debug options to their VM specs.

### Log sink for Gondolin

`debugLog` is a callback. The controller wires it to write `[gondolin:<component>] <message>` lines into:

```
<runtimeDir>/zones/<zoneId>/logs/gondolin-YYYY-MM-DD.log
```

Plus mirror at WARN-equivalent into the controller log so it surfaces in normal `pnpm start` output. Keeps Gondolin chatter out of the OpenClaw app log.

## Phase B — Zone external resources (OTEL plumbing)

### Schema

Add ONE line to zone schema in `system-config.ts` (line 369-389 block):

```typescript
externalResources: externalResourcesSchema,  // already defaults to {}
```

Import from `./resource-contracts/index.js`.

### Type plumb

Add `externalResources: ExternalResources` to `GatewayZoneConfig` in `packages/gateway-interface/src/gateway-lifecycle.ts`.

### Lifecycle merge

In `openclaw-lifecycle.ts:buildGatewayTcpHosts`, after the existing controller and tool-VM entries are inserted:

```typescript
const overlay = compileResourceOverlay({
  externalResources: zone.externalResources,
  repoFinalizations: [],
});
for (const [key, target] of Object.entries(overlay.tcpHosts)) {
  if (tcpHosts[key] !== undefined && tcpHosts[key] !== target) {
    throw new Error(`externalResources entry '${key}' conflicts with existing tcpHosts target`);
  }
  tcpHosts[key] = target;
}
```

`worker-gateway/src/worker-lifecycle.ts` does NOT get the same merge in v1 (Tool VMs see observability via Gateway VM tracing). Documented out-of-scope.

### shravan-claw consumption

shravan-claw declares three resources under `zones.<id>.externalResources`:

```jsonc
{
  "vm-metrics":  { name, binding: { host: "vm-metrics.observability.vm.host", port: 8428 },  target: { host: "127.0.0.1", port: 8428  }, env: {} },
  "vm-logs":     { name, binding: { host: "vm-logs.observability.vm.host",    port: 9428 },  target: { host: "127.0.0.1", port: 9428  }, env: {} },
  "vm-traces":   { name, binding: { host: "vm-traces.observability.vm.host",  port: 10428 }, target: { host: "127.0.0.1", port: 10428 }, env: {} },
}
```

Plus a `docker-compose.observability.yml` (operator-started, host-loopback ports) and a `diagnostics.otel.*` block in `config/gateways/sunfam/openclaw.json` pointing at the binding hostnames.

## Out of scope (v1)

- Tool VM Gondolin debug propagation — same shape as Gateway VM, deferred to a follow-up plan. Phase A only wires Gateway VM and worker.
- Tool VM direct OTEL emission — tool execution is already traced as `openclaw.tool.execution` spans by the Gateway VM's `diagnostics-otel`.
- Controller-managed docker-compose lifecycle for the Victoria stack — operator starts/stops it manually for v1 (parallels how openclaw VM is started).
- Alerting / Grafana / vmui — agents query via curl. Documented in the runbook.
- TLS or auth between Gateway VM and Victoria — containers bind to host loopback.

## Definition of done

Phase A:
- `agent-vm controller start --debug` with no other config produces Gondolin `[gondolin:net]`/`[gondolin:exec]`/`[gondolin:vfs]` lines in `<runtimeDir>/zones/<zone>/logs/gondolin-*.log` and OpenClaw runs at `logging.level: "debug"`.
- `agent-vm controller start --log-level info` produces no Gondolin debug output.
- shravan-claw `system.json` with `host.logging.level: "debug"` produces the same effect as `--debug` (config-first path works).
- All new code paths have vitest coverage. Existing tests still pass.

Phase B:
- shravan-claw `system.json` declaring three Victoria externalResources produces tcpHosts mappings in the Gateway VM. Verified by openclaw OTEL exporter posting OTLP/HTTP to `vm-metrics.observability.vm.host:8428` and landing in VictoriaMetrics.
- shravan-claw's existing config still validates without externalResources declared (defaults to `{}`).
- `compileResourceOverlay` conflict path triggers a clear error message during validation.

## Risks and mitigations

- **Existing OpenClaw configs author `logging.level`.** Mitigation: when `host.logging.openclaw = "inherit"`, prefer the OpenClaw-authored level. Document the precedence clearly.
- **Gondolin debug volume.** `["net","exec","vfs"]` at `debug` can be noisy. Mitigation: route Gondolin output to its own daily log file, surface only WARN-equivalents in controller stdout.
- **Worker VM doesn't speak OPENCLAW_LOG_LEVEL.** Worker uses its own runtime. Mitigation: set `LOG_LEVEL` (generic) and check that the worker reads it — confirmed in `worker-lifecycle.ts` env propagation; if the worker runtime ignores it, that's a worker-side follow-up.
- **shravan-claw's old observability spec/plan (in shravan-claw repo) is stale.** Mitigation: those docs are pre-pivot; the canonical design now lives in this agent-vm worktree. Delete or supersede them when this lands.
