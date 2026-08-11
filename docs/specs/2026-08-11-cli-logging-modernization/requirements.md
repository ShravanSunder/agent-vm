# CLI and Logging Modernization Requirements

## Authority and goal

The repository owner requires two related hard cutovers:

1. replace every active repository-owned CLI parser with Optique and
   `@optique/zod`, removing `cmd-ts`, manual parsers, and the prior compatibility
   architecture; then
2. replace ad hoc general diagnostics with categorized LogTape records and make
   those records available through structured stderr and `@logtape/otel`.

The delivery is two stacked pull requests. The Optique/Zod cutover lands first.
The LogTape/OTEL cutover is based on it and must not reopen CLI architecture.

## Consumers

- Developers and operators invoking `agent-vm`, `agent-vm-worker`,
  `tool-portal`, `mcp-portal`, and `agent-vm-gateway-runtime`.
- Maintainers extending commands without duplicating parser and TypeScript
  types.
- Operators diagnosing controller, worker, gateway, the Tool Portal CLI, MCP
  Portal, the managed common Tool Portal service, and active plugin behavior
  locally or through the existing OTLP path.
- Library integrators who must retain control of process-wide logging policy.
- Protocol and automation consumers that depend on exact stdout/result bytes.

## Required outcomes

### U1 — One CLI foundation

Every active repository-owned CLI MUST use Optique for command and option
composition. `cmd-ts` and package-owned manual argv parsing MUST be absent from
active source, tests, manifests, the lockfile, and current implementation docs.

Priority: required.

### U2 — Zod owns CLI value domains

Every CLI value domain MUST be expressed by a Zod schema and connected to
Optique through `@optique/zod`. Existing exact-domain schemas MUST be reused.
CLI-only narrower domains MUST have named adjacent schemas. TypeScript value
types MUST be inferred from their schemas rather than duplicated manually.

Priority: required.

### U3 — Standard Optique architecture, not a replacement shim

The cutover MUST adopt Optique's parser model directly. It MUST NOT recreate
the old `cmd-ts` `Type`, `oneOf`, handler, or `runSafely` interfaces; introduce
a repository-wide CLI framework; retain dual parser paths; or put business
effects in parser-definition modules.

Priority: required.

### U4 — Typed commands and stable operations

Parsing MUST yield a parser-inferred discriminated command union. Dispatch
MUST be exhaustive and select one existing operation. Command paths, option
names and aliases, positional inputs, defaults, successful effects, output
ownership, and action-level failures MUST remain stable unless Optique's
standard token grammar necessarily differs from the removed parser.

Priority: required.

### U5 — General diagnostics use LogTape

Active repository-hosted TypeScript packages that emit general operational
diagnostics MUST emit categorized `@logtape/logtape` records. The Tool Portal
CLI and MCP Portal are included wherever they emit general diagnostics. A
package that emits no general diagnostics does not gain a ceremonial LogTape
dependency. Code embedded in a foreign application process MUST use that
host's logging interface and MUST NOT configure a competing LogTape runtime.

Priority: required.

### U6 — Roots own structured stderr and OTLP export

Each executable root that hosts general diagnostics MUST configure LogTape once
for structured stderr and, when an existing OTLP endpoint is available, an
`@logtape/otel` sink. Libraries MUST only obtain categorized loggers; they MUST
NOT configure, reset, flush, or dispose process-global logging.

Priority: required.

### U7 — Logging remains diagnostic, not authoritative

LogTape MUST remain separate from existing typed controller and Gateway Runtime
telemetry providers. Logging setup, export, flush, or disposal failure MUST NOT
change a product result, protocol response, readiness decision, lifecycle
authority, or operation success/failure.

Priority: required.

### U8 — Protected channels and data remain protected

CLI help, version, results and parse errors; readiness and retirement JSON;
credentials output; interactive prompts/progress; raw child streams; and other
protocol bytes MUST retain direct owners. General structured fields MUST NOT
contain credentials, authorization material, prompts, responses, reasoning,
tool payloads, command/file content, raw streams, stacks, or credential-bearing
URLs.

Priority: required.

### U9 — Shipped behavior is proven

Every active built CLI MUST have black-box proof for help, representative valid
and invalid input, an existing value boundary, streams, status, and a safe
operation effect. Version proof is required only for binaries that already
expose a version surface. Each logging root MUST have process-level proof of
stderr structure, OTLP delivery when configured, protected-channel isolation,
and non-disruptive logging failure.

Priority: required.

### U10 — Managed application OTEL remains end to end

Managed Agent VM OpenClaw and Hermes zones MUST continue to export their
framework telemetry and managed common Tool Portal telemetry end to end through
the controller-authored mediated OTLP path. Producer identities, per-signal
toggles, source policies, admission limits, and Python Hermes ownership MUST
remain intact. The TypeScript LogTape cutover MUST complement this path without
rewriting, reinterpreting, or taking ownership of either managed framework's
telemetry contract.

Priority: required.

## Boundaries and non-goals

- `packages/openclaw-mcp-portal-plugin` is deprecated and excluded.
- No legacy CLI compatibility path, feature flag, or staged dual operation.
- No async or remote argument validation unless an existing command contract
  truly requires it; no such requirement is currently accepted.
- No command redesign, operation rewrite, configuration-schema change, or new
  shell-completion product commitment.
- No shared logging package, logging daemon, broker, durable queue, persistence,
  or new collector.
- No replacement or repackaging of typed logs, metrics, traces, health events,
  or managed common Tool Portal telemetry.
- No LogTape configuration inside the foreign OpenClaw application process or
  the Python Hermes framework process. OpenClaw integration uses its host logger;
  Python Hermes retains its fail-closed OpenTelemetry environment contract.
- No managed Worker-zone OTLP path; Worker zones continue to reject enabled
  zone observability.
- No guarantee that abrupt termination flushes buffered telemetry.

`U1` through `U10` are the complete accepted requirements for this program.
