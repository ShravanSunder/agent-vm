# CLI and Logging Modernization Program Design

Requirements: [requirements.md](requirements.md)
Specification: [specification.md](specification.md)

## Design summary

The program changes two boundaries and leaves business operations and typed
telemetry intact:

```text
argv
  -> package-owned Optique parser
  -> @optique/zod value parser
  -> parser-inferred discriminated command
  -> exhaustive package dispatcher
  -> existing operation

existing operation/library diagnostic
  -> package/domain LogTape logger
  -> process-root configuration
       -> structured stderr
       -> separate LogTape OTEL provider -> existing collector

existing typed telemetry provider --------------------------> unchanged
protected CLI/protocol/raw output --------------------------> unchanged
```

The Optique state is the base of the LogTape state. The layers do not share a
new framework: they meet only at existing executable roots.

## CLI structure

### Ownership

Each of the five CLI-owning packages has four distinct responsibilities:

```text
executable root
  owns argv, terminal streams, version metadata, and process status

parser definition
  owns Optique command composition, descriptions, and Zod value parsers

dispatcher
  owns exhaustive command-variant-to-operation selection

operation module
  owns filesystem, network, controller, VM, server, secret, and subprocess effects
```

Parser definitions import Optique and exact domain schemas. They do not import
operation modules. Dispatchers may import parser output types and operations.
Operations do not import Optique.

Where current `cmd-ts` definition files contain handlers and effects, the
existing effectful bodies move behind named operation functions. This is an
ownership extraction, not an operation redesign. Existing dependency injection
and `CliIo` seams remain authoritative.

### Parser composition and types

Every leaf parser is an Optique `object()` containing its inputs and a
`constant()` literal discriminator. Nested `command()` and `or()` composition
build user-facing paths. The root output type is inferred from the root parser:

```typescript
const workerCommandParser = or(
	command(
		"serve",
		object({
			command: constant("serve"),
			port: option(
				"--port",
				zod(workerPortSchema, { placeholder: 0 }),
			),
		}),
	),
	command("health", object({ command: constant("health") })),
);

type WorkerCommand = InferValue<typeof workerCommandParser>;
```

The exact Optique inference helper follows the installed public API. The
important invariant is that the parser is the single source of the command
union. No parallel `WorkerCommand` variants or manual `Omit`/`Pick` structures
repeat it.

Zod is the single source for value domains. A schema output type is inferred
with `z.infer`. Optique owns presence, optionality, defaults, command nesting,
help, and suggestions. Zod owns coercion, transformation, enum/literal choice,
and value constraints. Defaults are Optique defaults; `zod()` placeholders are
only deferred-resolution stand-ins and never user defaults.

### Execution path

Each executable root imports `run()` from `@optique/run` and calls it directly
with its package parser, help mode, existing version value where applicable,
and the root's owned streams. The returned parser-inferred command goes straight
to the package dispatcher. Production code does not call `runParser()` and does
not provide a custom `onExit`; Optique retains its standard help, diagnostic,
and process-status behavior.

Parser units may use the official non-process APIs from `@optique/core` to
inspect successful values without executing operations. Help, error, stream,
and status behavior is proved through the real built binaries rather than a
repository wrapper. There is no `optique-cli-support`, runner class, custom
control-flow signal, parse-outcome union, compatibility error marker, or
monkey-patched `process.exit` layer.

The path for every command is:

```text
argv
  -> @optique/run run(parser)
       help/version -> direct owned output -> success, no dispatch
       parse error  -> direct diagnostic -> failure, no dispatch
       command      -> exhaustive switch -> await one operation
  -> executable root maps only the final product result to process status
```

Operation exceptions retain their current owners. The parser layer does not
catch and reformat an already reported operation error.

### Package-specific CLI boundaries

- `agent-vm`: the existing nested command inventory is rebuilt leaf-for-leaf;
  version metadata remains root-owned.
- `agent-vm-worker`: `serve` and `health` become separate variants; server
  construction and health IO remain operation-owned.
- `tool-portal`: the current invocation grammar becomes a package-local parser;
  canonical result JSON remains direct.
- `mcp-portal`: administration and `serve` grammar share one package root
  parser; server lifecycle remains outside parser construction.
- `agent-vm-gateway-runtime`: one `--config` input uses a Zod absolute-path
  schema; config loading and service lifecycle remain operations.

No parser is shared across packages merely to avoid small grammar repetition.
Each CLI-owning package directly declares the narrow runtime dependencies it
imports: `@optique/core`, `@optique/run`, `@optique/zod`, and Zod.

### Current-to-proposed root ledger

| Root | Current path | Proposed changed edges | Preservation-critical edges |
| --- | --- | --- | --- |
| `agent-vm` | entrypoint → `runSafely` → `cmd-ts` tree → effect-bearing handler/operation | entrypoint → `@optique/run` → inferred command → exhaustive dispatcher → operation; parser definitions stop importing effects | `CliIo`, operation errors, readiness/result writers, and all controller/VM/secret/filesystem owners remain |
| `agent-vm-worker` | `runSafely` → `cmd-ts` handler → health request or server creation; serve discards the server handle | `run()` → `health` operation or `runWorkerServeLifecycle`; lifecycle retains server/control-service handles | health JSON and listening text remain direct; coordinator/server behavior remains operation-owned |
| `tool-portal` | `parseCliArguments` → transport/client creation → portal invocation | `run()` → inferred portal command → dispatcher → the same transport/invocation operation | canonical result JSON, sanitized CLI error, cancellation, client close, and exit classes remain direct |
| `mcp-portal` | manual top-level branching plus `parsePortalServerCliArgs` → administration/call/server operations | one `run()` parser → exhaustive dispatcher; `serve` alone enters the existing server lifetime path | usage, credentials, client config, results, listening output, and injected `PortalServerLogger` contract remain |
| Gateway Runtime | `configPathFromArguments` → config load → service start → signal → retire | `run()` validates the absolute config path → dispatcher → the same config/service lifecycle | readiness/retirement JSON, fatal evidence, service retirement, and typed Tool Portal telemetry remain |

The removed edges are the `cmd-ts` handlers, manual command branching, and
post-parse value classification. The added edges are package parsers and
exhaustive dispatchers. Existing effect and direct-output edges are unchanged
except that the controller and worker serve operations expose their already
created close handles to the root lifecycles defined below.

Current-path anchors are
`packages/agent-vm/src/cli/agent-vm-entrypoint.ts` and
`cli/commands/*-definition.ts`, `packages/agent-vm-worker/src/main.ts`,
`packages/agent-portal-sdk/src/cli/tool-portal.ts`,
`packages/mcp-portal/src/bin/mcp-portal.ts` plus `src/cli/serve-command.ts`, and
`packages/gateway-runtime/src/bin/gateway-runtime.ts`.

## Logging structure

### Diagnostic classification

Each active production emission site receives one owner classification:

```text
general diagnostic
  -> package/domain getLogger() call

protected direct output
  -> existing CLI, protocol, prompt/progress, or raw-stream writer

typed domain telemetry
  -> existing typed provider and schema
```

Classification is semantic, not a bulk replacement of every
`process.stderr.write` or `console.*` occurrence. Test fixtures, generated
programs, and raw relays remain direct. The active OpenClaw plugin is a library
logger consumer. The deprecated MCP Portal plugin is untouched.

The material current-to-proposed diagnostic ownership is:

| Owner | Current general path | Proposed path | Protected/unchanged path |
| --- | --- | --- | --- |
| Agent VM controller domains | domain helper or callback → prefixed stderr | domain category → LogTape | CLI/results, readiness JSON, raw child/build streams, typed controller telemetry |
| Worker runtime | shared stderr helper → stderr | worker domain category → LogTape | CLI diagnostics, listening/health output, validation subprocess streams |
| Gateway Runtime | fixed/general failure diagnostics → stderr | gateway category → LogTape after config load | readiness/retirement JSON, fatal evidence, typed Tool Portal telemetry |
| MCP Portal server | `PortalServerLogger` default adapter → stderr JSON | same injected event seam → categorized LogTape adapter | usage, credentials, result/client-config JSON, listening output |
| active OpenClaw plugin | default warning adapter → direct stderr | default adapter → categorized library logger | host-injected warning callback remains host-owned |
| Tool Portal CLI | canonical result or bounded CLI failure only | no admitted general diagnostic and therefore no LogTape root/dependency | all current stdout/stderr bytes and client-close precedence |

Current diagnostic anchors include the Agent VM controller/lease/health/zone
runtime helpers, `agent-vm-worker/src/shared/stderr.ts`, Gateway Runtime's
executable and production service, MCP Portal's `PortalServerLogger`, and the
active plugin's `openclaw-plugin-registration.ts`. The preserved typed owners
are `agent-vm/src/observability/otel-controller-telemetry-driver.ts` and
`gateway-runtime/src/production/gateway-runtime-tool-portal-telemetry.ts`.

Logger categories are fixed source literals with package and domain segments,
for example `agent-vm.controller.lease` or `agent-vm.mcp-portal.server`.
Category creation and safe field conversion stay adjacent to the owning
domain; no shared logging utility package is introduced.

### Root configuration

Only roots that actually host admitted general diagnostics configure LogTape:

```text
agent-vm operation that admits diagnostics ─┐
agent-vm-worker serve              ──┤
agent-vm-gateway-runtime           ──┼─> root-local logging configuration
mcp-portal serve                   ──┘     stderr + optional OTEL sink

help/version/CLI-only commands ------> no logging configuration
tool-portal protocol-only CLI --------> no configuration unless classification admits a diagnostic
libraries/plugins --------------------> getLogger() only
```

Root-local configuration returns an owned async-disposable handle. It is a
small process adapter, not a general CLI or logging framework. Each root keeps
its own endpoint/resource mapping because the existing authorities differ:

- Agent VM uses the resolved controller observability setting. Explicit
  disabled state suppresses ambient OTEL discovery.
- Gateway Runtime uses its loaded discriminated observability configuration.
  Explicit disabled state suppresses ambient discovery.
- Worker and standalone MCP Portal use standard OTEL logs environment
  discovery because they have no repository endpoint authority.

When an endpoint is a collector base URL, the root derives its logs endpoint
once according to the current typed telemetry convention. The LogTape OTEL sink
creates and owns a separate provider. It never receives an existing typed
provider.

The meta-diagnostic category emitted by the OTEL sink routes only to stderr so
exporter failures cannot recursively export themselves.

### Lifecycle and result precedence

For long-running roots, configuration begins only after CLI parsing and any
configuration needed to choose the endpoint, but before the product runtime
starts emitting admitted diagnostics.

```text
parse CLI / load root config
  -> configure LogTape if this path hosts diagnostics
  -> start product runtime
  -> run product lifecycle
  -> stop/close product runtime
  -> stop existing typed telemetry in its current order
  -> flush/dispose LogTape once, last
  -> preserve authoritative product result
```

Logging is fail-open relative to product behavior:

- setup failure uses one fixed bounded root stderr fallback and product startup
  continues without claiming logging is configured;
- exporter failure is contained by the logging boundary;
- disposal failure uses the same bounded fallback;
- a fallback writer exception is caught and discarded;
- an existing product error always outranks a logging error;
- repeated cleanup calls reuse the product owner's single close result and
  cannot dispose or configure logging twice; a later operating-system signal
  may still take the abrupt-termination path defined below.

The fallback is allowed only at executable roots when LogTape cannot serve. It
is not a library dual path or compatibility logger.

### Root-specific lifetime completion

Gateway Runtime and MCP Portal already retain a product lifetime: Gateway
Runtime awaits a retirement signal and `service.retire()`, while MCP Portal
awaits server shutdown. Their root adapters dispose LogTape after those existing
paths complete; Gateway Runtime's typed telemetry remains inside service
retirement.

Agent VM and Worker need one minimal package-local ownership correction:

```text
agent-vm controller start
  -> parse and load config
  -> configure logging (fail-open)
  -> startControllerRuntime() and retain ControllerRuntime
  -> write existing readiness JSON
  -> await first SIGINT/SIGTERM
  -> await ControllerRuntime.close() exactly once
       (zones/server/health sinks/typed telemetry keep their existing order)
  -> dispose LogTape once in finally
  -> rethrow the ControllerRuntime.close() error, if any

agent-vm-worker serve
  -> parse and load config
  -> configure logging (fail-open)
  -> create coordinator, Worker Control Service, app, and HTTP server
  -> retain the HTTP server and optional Worker Control Service
  -> write existing listening line
  -> await first SIGINT/SIGTERM
  -> close HTTP server, then Worker Control Service, each at most once
  -> dispose LogTape once in finally
  -> preserve the first product startup/close error, if any
```

`runControllerStartLifecycle` and `runWorkerServeLifecycle` are package-local
operation functions, not a shared lifecycle abstraction. Each installs a
one-shot SIGINT/SIGTERM waiter and removes both listeners when the first signal
arrives. A later signal follows Node's native termination behavior and may skip
remaining best-effort telemetry flush, which is the already accepted abrupt-
termination boundary. It never starts a second close or disposal path.

If startup fails after a product handle exists, the same lifecycle owner closes
the handles it created before disposing logging; the startup error remains
authoritative. If multiple product closes fail, their existing package owner
selects or aggregates the product error before logging disposal. Logging setup,
disposal, and fixed fallback-write failures remain secondary and cannot replace
that result.

### Safe record boundary

Each diagnostic call constructs allowlisted properties. Conversion accepts
only the values needed for the event and returns bounded primitives:

- fixed event/failure classifications;
- non-secret identifiers or stable hashes;
- finite counts, attempts, and durations;
- sanitized error class and bounded summary when safe.

Raw `Error` values and arbitrary objects never cross the logger call. Unsafe
or unbounded context is omitted. If omission leaves no useful safe context, the
fixed message and failure class are sufficient.

## Preserved typed telemetry

The following owners remain structurally independent:

```text
controller runtime
  -> controller telemetry abstraction
  -> controller OTel log/metric/trace providers

Gateway Runtime
  -> Tool Portal telemetry runtime
  -> gateway OTel log/metric/trace providers
```

LogTape may export to the same collector, but it does not share providers,
schemas, shutdown handles, admission limits, or lifecycle authority. General
records do not write health state, task state, leases, readiness, or recovery
decisions.

## Failure and concurrency model

Parsing is synchronous and effect-free. One CLI invocation yields at most one
operation. Async/filesystem/network validation happens only after dispatch.

Each process has at most one LogTape configuration owner and one disposal
handle. Concurrent logger calls use LogTape's sink behavior; the program adds
no locks, queues, persistence, ordering promises, or retries. Abrupt process
termination may lose buffered OTLP records.

No parser or logging state is persisted, so each pull request rolls back as one
source changeset without data migration.

## Proof architecture

| Contract | Structural seam | Proof |
| --- | --- | --- |
| S1–S2 | package parser definitions and Zod schemas | residue/package scan; parser value units |
| S3 | parser import graph and exhaustive dispatcher | import/purity test; one-dispatch units; typecheck |
| S4 | real executable root and current operation seams | all-five built-binary host E2E and outside-suite smoke |
| S5 | classified emission inventory and category literals | static inventory plus captured logger records |
| S6 | root-local configuration; logger-only libraries | import/configuration isolation tests |
| S7 | separate LogTape provider and real receiver boundary | causal OTLP receiver proof; typed-provider regression tests |
| S8 | existing direct writers | byte/channel process transcripts including CLI-only failure injection |
| S9 | package-local property conversion | forbidden-field and bound tests at logger-call seam |
| S10 | product close and logging disposal handles | ordering, repeated signal, setup/export/disposal/fallback failure tests |
| S11 | two branch diffs | per-PR residue scan, build, package inspection, full quality and relevant E2E gates |

The production proof path must execute real built roots. A captured in-memory
sink proves record construction only; it does not substitute for stderr or OTLP
delivery. A fake parser does not substitute for built-binary CLI proof.

## Enforced exclusions

- no `cmd-ts`, manual argv parser, compatibility facade, dual parser, or custom
  repository-wide CLI runner;
- no manually duplicated command union or effectful parser-definition module;
- no library-owned LogTape configuration or disposal;
- no protected output through LogTape;
- no typed telemetry provider passed to LogTape;
- no content capture or arbitrary structured object logging;
- no new shared package, service, broker, persistence, queue, collector, or
  lifecycle authority;
- no changes to `packages/openclaw-mcp-portal-plugin`.

## Library references

- [Optique process runner](https://optique.dev/): `@optique/run` owns
  process-integrated argv, help/version, terminal output, and exit behavior.
- [Optique Zod integration](https://optique.dev/integrations/zod#zod-integration):
  Zod schemas provide value validation and output-safe placeholders.
- [LogTape](https://logtape.org/) and
  [`@logtape/otel`](https://github.com/dahlia/logtape): categorized library
  loggers feed root-configured structured and OpenTelemetry sinks.
