# CLI and Logging Modernization Program Design

Requirements: [requirements.md](requirements.md)
Specification: [specification.md](specification.md)

## Design summary

The program changes two boundaries and leaves business operations and typed
telemetry intact:

```text
argv
  -> package-owned Optique parser
  -> Zod v4 schema-owned value and absence contract
  -> @optique/zod provided-token parser
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
  owns Optique command composition/descriptions and named Zod v4 schemas

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

### Zod v4 schema authority

Each scalar or repeated value-bearing CLI field has one named Zod v4 schema.
Its output type is `z.infer<typeof schema>`. The schema owns the value domain,
coercion, transformation, optionality, fixed CLI default, collection shape,
and output type. Optique owns the field's command-line name and aliases, its
position in the command tree, help composition, suggestions, and token
collection.

`@optique/zod` validates a token only after Optique has matched that token; it
does not receive absent options. Each package that has optional, defaulted, or
repeated values therefore keeps two narrow package-local functions adjacent to
its parser definitions: `projectZodScalarPresence()` and, only where repetition
exists, `projectZodRepeatedOption()`. They translate the public Zod v4 shape
into official Optique parser modifiers while retaining the same schema as value
authority.

```text
named Zod v4 schema
  ├─ outer ZodOptional ──> optional(option/argument(..., zod(same schema)))
  ├─ outer ZodDefault  ──> withDefault(
  │                           option/argument(..., zod(same schema)),
  │                           schema.parse(undefined)
  │                         )
  └─ otherwise         ──> option/argument(..., zod(same schema))
```

The projection uses only public Zod v4 APIs: exported `ZodOptional` and
`ZodDefault` classes for wrapper identity, `unwrap()` where the public type
relationship must be inspected, and `parse(undefined)` to obtain the schema's
own default output. It never reads `_def`, `_zod`, or another private shape.
Outer-wrapper order remains meaningful exactly as it is in Zod: for example,
`.default(value).optional()` is optional, while `.optional().default(value)`
has a default.

CLI defaults are fixed and side-effect-free. Dynamic or async default factories
are excluded because parser construction and help must observe the same value.
`zod()` placeholders remain explicitly supplied, output-safe stand-ins for
deferred resolution; they do not participate in absence classification and
are never CLI defaults.

`projectZodScalarPresence()` is not a runner, command builder, handler facade,
or old parser compatibility layer. It accepts only a schema and an already
composed official Optique value parser; it does not accept command names,
aliases, descriptions, dispatchers, streams, or operations. Keeping it
package-local avoids a repository-wide CLI framework and leaves every package
visibly composed from official Optique primitives.

`projectZodRepeatedOption()` exists only because one CLI occurrence is an
element while the command field is a collection. The authoritative schema
has the public shape `ZodDefault<ZodArray<TElement>>` for the current
zero-or-more contracts. The projection unwraps the public default and array
wrappers, passes the public element schema to `zod()`, collects one-or-more
occurrences with Optique `multiple()`, preserves `undefined` when there were no
occurrences, then parses `undefined | readonly TElement[]` through the full
array schema. That final parse supplies the schema-owned empty default and the
`z.infer` collection output.

```text
z.array(elementSchema).default([])
  -> unwrap public default and array wrappers
  -> zod(elementSchema) validates each supplied token
  -> optional(multiple(element option, { min: 1 })) distinguishes absence
  -> fullArraySchema.parse(undefined | collectedElements)
  -> z.infer<typeof fullArraySchema>
```

The admitted repeated schemas have only element validation plus a fixed empty
default, so the final parse cannot introduce a new aggregate failure after
each element succeeds. A future length constraint, collection transform, or
non-empty default is not silently added to this mapper; it requires an official
parser-visible failure design first. This keeps the projection narrow instead
of growing it into a general Zod-to-Optique framework.

Configuration-, environment-, working-directory-, or runtime-dependent
fallback remains outside both projections. Its schema is outer-optional and
produces `undefined`; the existing operation resolves that value later. MCP
Portal's absent proxy port, for example, remains a configured-port fallback
rather than becoming a fixed CLI default.

Presence-only switches remain Optique `flag()` parsers because no value token
exists for `@optique/zod` to validate. They are not used as a substitute for a
value-bearing boolean option.

### Parser composition and command types

Every leaf parser is an Optique `object()` containing its inputs and a
`constant()` literal discriminator. Nested `command()` and `or()` composition
build user-facing paths. The root output type is inferred from the root parser:

```typescript
const workerPortSchema = z.coerce
	.number()
	.int()
	.min(0)
	.max(65_535)
	.default(18_789);

const workerCommandParser = or(
	command(
		"serve",
		object({
			command: constant("serve"),
			port: projectZodScalarPresence({
				schema: workerPortSchema,
				parser: option(
					"-p",
					"--port",
					zod(workerPortSchema, { placeholder: 18_789 }),
				),
			}),
		}),
	),
	command("health", object({ command: constant("health") })),
);

export type WorkerCommand = InferValue<typeof workerCommandParser>;
```

The exact Optique inference helper follows the installed public API. Every
exported command type is exactly `InferValue<typeof rootParser>`, and each
dispatcher accepts that alias directly. Its default arm assigns the remaining
value to `never`. A source/AST boundary test in each parser-owning package
rejects a second handwritten command-union declaration. The parser is therefore
the mechanically enforced single source of the command union; no parallel
variants or manual `Omit`/`Pick` structures repeat it.

Value schemas are never recreated as TypeScript unions or as independent
Optique optional/default declarations. Optique parser inference owns only the
assembled command shape and discriminated command union.

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

### Schema-owned absence and default ledger

Fixed CLI defaults move into the named schema and appear nowhere else. Values
that depend on configuration, environment, the working directory, another
argument, or runtime state remain optional schema outputs and are resolved only
by the existing operation.

| Surface | Zod-owned parser result | Operation-owned resolution |
| --- | --- | --- |
| Agent VM shared options | `--config` defaults to `config/system.json`; `--zone` is optional | commands that require a zone retain their existing post-parse requirement check |
| Agent VM init | zone id defaults to `default`; type is the narrow `openclaw \| worker` enum; preset name and comma-separated agent ids use named transforms; preset/secrets/architecture/paths/namespace/keychain values are optional | preset-dependent secrets, architecture, and path-mode selection; prompt/scaffold work |
| Agent VM manual/config | manual config defaults to `config/system.jsonc`; default zone defaults to `default`; reset phase defaults to `all` | target directory remains optional and resolves from injected/current working directory |
| Agent VM authentication | repeated profile ids use `z.array(profileIdSchema).default([])`; agent/token/zone values are optional | omitted token remains interactive; configured-profile selection remains operation-owned |
| Worker | port defaults to `18789` with integer range `0..65535`; config and state-dir are optional | `WORKER_CONFIG_PATH`, loaded state directory, and `WORK_DIR` remain runtime/config fallbacks |
| Tool Portal | approval-token environment name is optional only in the `call` variant; all other transport values are variant-required | credential lookup, file loading, transport creation, and request-schema validation remain operations |
| MCP Portal | call tool defaults to `mcp_portal_call`; repeated agent overrides use `z.array(agentOverrideSchema).default([])`; port and proxy URL are optional | absent serve port uses configured proxy port; known-agent lookup and secret/config resolution remain operations |
| Gateway Runtime | absolute NUL-free config path is required | protected-file and service-config validation remain operations |

Presence-only switches are the sole absence exception: Optique `flag()` owns
their grammar and produces `false` when absent because there is no value token
or separate value domain for Zod to parse. The exact fixed defaults
`config/system.json`, `config/system.jsonc`, `default`, `all`, `[]`,
`mcp_portal_call`, and `18789` are each declared only by their corresponding
named Zod schema.

The MCP fingerprint remains a required string because current behavior does
not validate the documented-looking `sha256:` shape. The hard cutover does not
silently tighten that domain. Disabled `mcp-proxy write-credential` adopts
Optique's strict grammar rather than retaining acceptance of ignored unknown
flags; the command remains disabled and returns its existing failure class.

### Current-to-proposed root ledger

| Root | Current path | Proposed changed edges | Preservation-critical edges |
| --- | --- | --- | --- |
| `agent-vm` | entrypoint → `runSafely` → `cmd-ts` tree → effect-bearing handler/operation | entrypoint → `@optique/run` → inferred command → exhaustive dispatcher → operation; parser definitions stop importing effects | `CliIo`, operation errors, readiness/result writers, and all controller/VM/secret/filesystem owners remain |
| `agent-vm-worker` | `runSafely` → `cmd-ts` handler → health request or server creation; serve discards the server handle | `run()` → `health` operation or `runWorkerServeLifecycle`; lifecycle retains server/control-service handles | health JSON and listening text remain direct; coordinator/server behavior remains operation-owned |
| `tool-portal` | `parseCliArguments` → transport/client creation → portal invocation | `run()` → inferred portal command → dispatcher → the same transport/invocation operation | canonical result JSON, sanitized CLI error, cancellation, client close, and exit classes remain direct |
| `mcp-portal` | manual top-level branching plus `parsePortalServerCliArgs` → administration/call/server operations | one `run()` parser → exhaustive dispatcher; `serve` alone enters the existing server lifetime path | usage, credentials, client config, results, listening output, and injected `PortalServerLogger` contract remain |
| Gateway Runtime | `configPathFromArguments` → config load → service start → signal → retire | `run()` validates the absolute config path → dispatcher → the same config/service lifecycle | readiness/retirement JSON, fatal evidence, service retirement, and typed managed common Tool Portal telemetry remain |

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
programs, and raw relays remain direct. The active OpenClaw plugin executes in
a foreign OpenClaw application process: it uses the host logger when supplied
and retains one bounded direct-stderr warning fallback for direct embedding.
It does not configure or assume a LogTape sink. The deprecated MCP Portal
plugin is untouched.

The material current-to-proposed diagnostic ownership is:

| Owner | Current general path | Proposed path | Protected/unchanged path |
| --- | --- | --- | --- |
| Agent VM controller domains | domain helper or callback → prefixed stderr | domain category → LogTape | CLI/results, readiness JSON, raw child/build streams, typed controller telemetry |
| Worker runtime | shared stderr helper → stderr | worker domain category → LogTape | CLI diagnostics, listening/health output, validation subprocess streams |
| Gateway Runtime | fixed/general failure diagnostics → stderr | gateway category → LogTape after config load | readiness/retirement JSON, fatal evidence, typed managed common Tool Portal telemetry |
| MCP Portal server | `PortalServerLogger` default adapter → stderr JSON | same injected event seam → categorized LogTape adapter | usage, credentials, result/client-config JSON, listening output |
| active OpenClaw plugin | default warning adapter → direct stderr | OpenClaw host logger when available | bounded direct-stderr fallback remains only when direct embedding supplies no host logger; OpenClaw owns process logging and OTEL policy |
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
small process adapter, not a general CLI or logging framework. Each root passes
an explicit service identity and keeps its own endpoint/toggle mapping because
the existing authorities differ:

| Root | LogTape `service.name` | OTLP authority |
| --- | --- | --- |
| Agent VM | `agent-vm-controller` | resolved controller observability; explicit disabled state suppresses ambient discovery |
| Worker | `agent-vm-worker` | standard OTEL logs environment only for standalone/non-managed hosting; managed Worker has structured stderr only |
| Gateway Runtime | `agent-vm-tool-portal` | loaded `otlp-http` configuration only when `logs: true`; `disabled` or `logs: false` suppresses the sink but not structured stderr |
| MCP Portal | `agent-vm-mcp-portal` | standard OTEL logs environment because no repository endpoint authority exists |

Gateway Runtime is the managed common Tool Portal service process, so its
general records deliberately use `agent-vm-tool-portal`; they never inherit
`agent-vm-openclaw` or `agent-vm-hermes` from ambient environment.

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
  -> managed common Tool Portal telemetry runtime
  -> gateway OTel log/metric/trace providers
```

LogTape may export to the same collector, but it does not share providers,
schemas, shutdown handles, admission limits, or lifecycle authority. General
records do not write health state, task state, leases, readiness, or recovery
decisions.

### Managed application telemetry boundary

Agent VM remains the authority that resolves zone observability and constructs
the mediated collector route. It passes separate, fixed producer contracts to
the managed application and managed common Tool Portal service:

```text
Agent VM zone observability
  -> mediated OTLP HTTP collector route
       -> OpenClaw framework       service.name=agent-vm-openclaw
       -> or Hermes framework      service.name=agent-vm-hermes
       -> common Tool Portal       service.name=agent-vm-tool-portal
```

For Hermes, `hermes-lifecycle.ts` continues to write the reserved `OTEL_*` and
`AGENT_VM_HERMES_OTEL_*` environment contract. The Python Hermes adapter alone
loads and fail-closed validates it. TypeScript LogTape setup neither writes nor
interprets those variables, and no LogTape runtime is configured in the Python
framework process. OpenClaw's framework telemetry likewise stays owned by its
existing diagnostics runtime; the plugin's host logger integration does not
create a second telemetry owner.

Worker zones continue to reject enabled zone observability. The managed Worker
path therefore ends at structured stderr and gains no controller mediation or
zone schema. A standalone Worker may use standard OTEL logs environment through
its own root adapter, but that is a separate hosting mode.

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
| S1–S2 | package parser definitions, Zod v4 schemas, and package-local scalar/array projections | residue/package scan; scalar and repeated parser units; source/AST rejection of private Zod introspection or duplicated optional/default/array declarations |
| S3 | parser import graph, inferred alias, and exhaustive dispatcher | import/purity test; one-dispatch units; typecheck; source/AST rejection of handwritten command unions |
| S4 | real executable root and current operation seams | all-five built-binary host E2E and outside-suite smoke |
| S5 | classified emission inventory and category literals | static inventory plus captured logger records |
| S6 | root-local configuration; logger-only libraries | import/configuration isolation tests |
| S7 | separate LogTape provider, explicit service identity, and real receiver boundary | causal OTLP receiver proof for configured roots; disabled/signal-toggle tests; typed-provider regression tests |
| S8 | existing direct writers | byte/channel process transcripts including CLI-only failure injection |
| S9 | package-local property conversion | forbidden-field and bound tests at logger-call seam |
| S10 | product close and logging disposal handles | ordering, repeated signal, setup/export/disposal/fallback failure tests |
| S11 | controller mediation plus existing OpenClaw and Hermes framework owners | real managed OpenClaw and Hermes VM E2E observes framework and common Tool Portal identities, signal toggles, and safe-content policy |
| S12 | two branch diffs | per-PR residue scan, build, package inspection, full quality and relevant E2E gates |

The production proof path must execute real built roots. A captured in-memory
sink proves record construction only; it does not substitute for stderr or OTLP
delivery. A fake parser does not substitute for built-binary CLI proof.

## Enforced exclusions

- no `cmd-ts`, manual argv parser, compatibility facade, dual parser, or custom
  repository-wide CLI runner;
- no independent Optique optional/default declaration for a value-bearing
  field; missing-token behavior is projected from its Zod v4 schema;
- no independently typed or defaulted repeated-value collection; the Zod array
  schema supplies its element domain, collection output, and fixed default;
- no private Zod `_def`/`_zod` introspection or dynamic CLI default factory;
- no manually duplicated command union or effectful parser-definition module;
- no library-owned LogTape configuration or disposal;
- no LogTape runtime inside the foreign OpenClaw application or Python Hermes
  framework process;
- no protected output through LogTape;
- no typed telemetry provider passed to LogTape;
- no content capture or arbitrary structured object logging;
- no new shared package, service, broker, persistence, queue, collector, or
  lifecycle authority;
- no managed Worker-zone observability path or schema;
- no changes to `packages/openclaw-mcp-portal-plugin`.

## Library references

- [Optique process runner](https://optique.dev/): `@optique/run` owns
  process-integrated argv, help/version, terminal output, and exit behavior.
- [Optique Zod integration](https://optique.dev/integrations/zod#zod-integration):
  Zod schemas provide value validation and output-safe placeholders.
- [Optique `zod()` source at `325fa7e6`](https://github.com/dahlia/optique/blob/325fa7e6b66df8dc0fe901a4b71055c75a38c139/packages/zod/src/index.ts#L686-L715):
  the integration calls the supplied schema for one provided input token.
- [Optique modifier source at `325fa7e6`](https://github.com/dahlia/optique/blob/325fa7e6b66df8dc0fe901a4b71055c75a38c139/packages/core/src/modifiers.ts#L671-L730):
  `optional()` owns unmatched-parser absence;
  [`withDefault()`](https://github.com/dahlia/optique/blob/325fa7e6b66df8dc0fe901a4b71055c75a38c139/packages/core/src/modifiers.ts#L1038-L1087)
  and
  [`multiple()`](https://github.com/dahlia/optique/blob/325fa7e6b66df8dc0fe901a4b71055c75a38c139/packages/core/src/modifiers.ts#L2095-L2118)
  own the official parser mechanics projected from the schema.
- [Zod v4.4.3 public wrapper APIs](https://github.com/colinhacks/zod/blob/1fb56a5c18c27102dbc92260a4007c7732a0ccca/packages/zod/src/v4/classic/schemas.ts#L2057-L2165):
  `ZodOptional`, `ZodDefault`, and public `unwrap()` behavior are available
  without repository code inspecting private representation; the
  [public `ZodArray.element` field](https://github.com/colinhacks/zod/blob/1fb56a5c18c27102dbc92260a4007c7732a0ccca/packages/zod/src/v4/classic/schemas.ts#L1317-L1349)
  exposes the repeated element schema.
- [LogTape](https://logtape.org/) and
  [`@logtape/otel`](https://github.com/dahlia/logtape): categorized library
  loggers feed root-configured structured and OpenTelemetry sinks.
