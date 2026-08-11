# CLI and Logging Modernization Specification

Requirements: [requirements.md](requirements.md)

## Observable result

The program produces two independently reviewable states:

1. every active CLI uses Optique plus `@optique/zod`, with no `cmd-ts` or
   package-owned manual argv parser; and
2. general operational diagnostics use LogTape and can reach structured stderr
   plus the existing OTLP logs path without altering product behavior.

The active CLI inventory is exactly:

- `agent-vm`;
- `agent-vm-worker`;
- `tool-portal`;
- `mcp-portal`;
- `agent-vm-gateway-runtime`.

The deprecated `openclaw-mcp-portal-plugin` is outside both cutovers.

## CLI obligations

### S1 — Complete Optique cutover

Every active CLI MUST compose commands, arguments, options, defaults, and help
with official Optique APIs. Each executable root MUST execute its parser
directly with `run()` from `@optique/run`; parser-only tests MAY call the
official non-process parser APIs from `@optique/core`. `cmd-ts` MUST be absent
from active manifests, lockfile resolution, imports, tests, and implementation
documentation. Existing manual `process.argv` branching and
`node:util.parseArgs` command parsing MUST also be absent from those binaries.

No compatibility facade MAY expose old `cmd-ts` concepts under new names. No
shared helper MAY reproduce the old runner/handler abstraction. A production
root MUST NOT wrap `runParser()` with thrown control-flow signals, custom exit
outcome unions, or replacement error markers to imitate `runSafely()`.

Traces to: U1, U3.

### S2 — Zod-backed values and schema-derived types

Every scalar value-bearing option or argument MUST use one named Zod v4 schema
and pass that exact schema object to `zod(schema, options)` from
`@optique/zod` for provided-token validation. Numeric and other non-string
inputs MUST use Zod coercion or transformation. Boolean-valued arguments MUST
use the integration's CLI boolean behavior.

The schema's outermost Zod v4 wrapper MUST be the sole declaration of
missing-token behavior:

- a schema without an outer `ZodOptional` or `ZodDefault` is required;
- an outer `ZodOptional` makes the CLI value optional;
- an outer `ZodDefault` supplies the CLI default, and that default value MUST
  appear only in the schema's `.default(...)` declaration.

Parser composition MUST mechanically project those three states onto official
Optique required, `optional()`, or `withDefault()` behavior. Call sites MUST NOT
repeat an independent optional marker, default literal, default constant, or
handwritten value type. The projection MUST use Zod v4's public exported schema
classes and public parsing/unwrap behavior; it MUST NOT inspect `_def`, `_zod`,
or other private Zod representation. CLI defaults MUST be synchronous,
deterministic values so help output and runtime parsing observe the same value.

A repeated value MUST use one named Zod array schema as the authoritative
collection contract. Its public element schema MUST be the value parser passed
to `@optique/zod`; Optique's official repetition modifier MAY only collect the
validated elements. Absence versus one-or-more occurrences MUST remain
distinguishable until the full array schema parses the collected value, so the
array schema itself supplies an empty or other fixed default and its
`z.infer` output becomes the command field type. A handwritten item union,
independent empty-array default, or array type MUST NOT duplicate that schema.
The current repeated options have element constraints plus fixed empty-array
defaults; new aggregate constraints or collection transforms require an
official parser-visible Zod failure path rather than a throwing mapper.

Each `zod()` options object MUST contain a placeholder that is safe for the
schema's output type. A placeholder is only Optique's deferred-resolution
stand-in: it MUST NOT determine requiredness, optionality, or a user-visible
default.

An existing Zod schema MUST be reused when it describes the exact CLI domain.
A narrower CLI domain MUST use a named adjacent schema. In particular,
`agent-vm init --type` remains `openclaw | worker`, not the wider gateway type
domain. Command option/value types MUST use `z.infer` or Optique parser
inference and MUST NOT repeat a schema-owned union manually. Presence-only
switches MAY use Optique's flag primitive because they have no supplied value
token; this exception MUST NOT be used for an option that accepts a value.

`zodAsync()` and async parsing MUST NOT be introduced unless a current command
already has an accepted async validation contract. Filesystem, network,
credential, and runtime checks remain operation-owned.

An absent value whose effective value is selected later from configuration,
environment, current working directory, or runtime state MUST remain a
Zod-optional parser output. The post-parse operation retains that contextual
fallback; it MUST NOT be copied into a Zod `.default()` or Optique
`withDefault()` declaration. This applies, for example, to MCP Portal's
configured proxy-port fallback and Worker's configuration-path fallback.

Traces to: U2, U3, U4.

### S3 — Parser-inferred discriminated command values

Every leaf parser MUST add a literal discriminator with Optique composition.
The root parser's inferred output type is the CLI's command union. A separate
handwritten union that duplicates the parser output MUST NOT exist.

Parsing a valid invocation MUST yield exactly one command variant. An
exhaustive dispatcher MUST select exactly one existing effect-owning operation.
Parser modules MUST remain safe to import and construct without loading or
executing filesystem, controller, VM, secret, SSH, subprocess, server, or
network effects.

Traces to: U3, U4.

### S4 — Supported CLI behavior

For equivalent valid input, each binary MUST preserve its current command
paths, long and short option names, positional values, defaults,
required/optional rules, typed operation input, output channel, safe effect,
and process status. Gateway Runtime MUST still require exactly one absolute
`--config` path.

Top-level and reachable leaf help MUST write to stdout and succeed. The
existing `agent-vm` version surface MUST remain successful; no new version
surface is required for the other four binaries. Unknown commands/options,
missing values, and Zod-invalid values MUST write one useful diagnostic to
stderr, fail, expose no ordinary stack trace, and execute no operation.

Exact `cmd-ts` wording, layout, wrapping, color, and parser-specific token
quirks are not preserved. Optique's standard grammar and diagnostics are
authoritative.

Traces to: U4, U9.

## Logging obligations

### S5 — General diagnostic classification and categories

Every direct console/stderr/callback emission in active production source MUST
be classified as either:

- a general operational diagnostic, which MUST become a LogTape record; or
- protected direct output under S8.

General records MUST use stable hierarchical categories beginning with the
owning package and domain, a fixed bounded message, an appropriate level, and
allowlisted structured fields. Human-readable prefix strings such as
`[agent-vm]` MUST NOT be the category mechanism.

The Tool Portal CLI and MCP Portal MUST follow the same classification. The
Tool Portal CLI MAY remain dependency-free only if its production surface has
no admitted general diagnostic after classification. Code embedded in the
foreign OpenClaw application process MUST use OpenClaw's host logger when
available and MAY retain one bounded direct-stderr warning fallback when the
host supplies no logger; it MUST NOT configure LogTape in that process.

Traces to: U5, U8.

### S6 — Root configuration and library isolation

An executable root that hosts admitted general diagnostics MUST configure
LogTape once. Its configuration MUST route admitted categories to newline-
delimited structured stderr and MUST add an `@logtape/otel` sink when the
root's existing configuration or standard OTEL environment supplies an
endpoint. Explicitly disabled repository observability MUST NOT be overridden
by ambient OTEL variables.

Each configured OTLP sink MUST receive an explicit root-owned `service.name`;
it MUST NOT inherit a managed framework identity from ambient environment.
Agent VM uses `agent-vm-controller`, Worker uses `agent-vm-worker`, Gateway
Runtime uses `agent-vm-tool-portal`, and MCP Portal uses
`agent-vm-mcp-portal`. Gateway Runtime MUST enable its LogTape OTLP sink only
when its loaded observability configuration is `otlp-http` with `logs: true`;
structured stderr remains enabled when OTLP logging is disabled.

Reusable libraries and plugins MAY call `getLogger()` but MUST NOT configure
LogTape, construct sinks, select global levels, reset configuration, or own
flush/disposal. No shared logging package or cross-process logging owner MAY be
introduced.

Traces to: U5, U6.

### S7 — OTLP and typed telemetry separation

The LogTape OTEL sink MUST own a provider/exporter distinct from existing typed
controller and Gateway Runtime telemetry providers. Existing typed record
schemas, metrics, traces, resource identity, admission controls, correlation,
shutdown, and lifecycle decisions MUST remain unchanged.

When a configured collector is absent or unavailable, stderr logging and the
product MUST continue. OTLP retry/buffering behavior MUST remain library-owned;
the program MUST add no queue, persistence, retry coordinator, or collector.

Traces to: U6, U7.

### S8 — Protected outputs

The following MUST remain direct and MUST NOT pass through LogTape:

- CLI help, version, parse diagnostics, command results, and credential output;
- readiness, retirement, health, and other machine-readable stdout payloads;
- MCP Portal and Tool Portal CLI protocol results and listening/readiness
  contracts;
- interactive prompts and progress;
- raw stdout/stderr relays from child processes;
- generated scripts and test-fixture protocols.

Logging configuration MUST NOT run for a help/version or other CLI-only path
that emits no general diagnostics. Logging setup or disposal MUST therefore be
unable to suppress, alter, or append output to those paths.

Traces to: U7, U8.

### S9 — Safe structured fields

Structured properties MUST be selected field-by-field. They MUST NOT contain
secrets, tokens, authorization headers, credential references, prompts,
responses, reasoning, tool inputs/results, command or file content, raw
streams, raw error objects, stacks, cookies, private keys, or URLs containing
credentials or query data.

Errors MUST be converted to bounded classifications and safe summaries. A
source that cannot safely classify context MUST emit only a fixed event and
failure class. Collector scrubbing is defense in depth, not permission to emit
prohibited data.

Traces to: U8.

### S10 — Failure and shutdown behavior

Logging setup, record export, flush, or disposal failure MUST be secondary to
the product result. It MUST NOT change exit status, replace an operation error,
alter a protocol response, or prevent product shutdown. A process root MAY use
one fixed direct-stderr fallback when LogTape itself is unavailable; failure of
that fallback write MUST also be contained.

For long-running roots, product runtime/server shutdown MUST complete before
the root flushes and disposes LogTape. Disposal MUST occur at most once. A
second shutdown signal or repeated cleanup path MUST NOT create another global
configuration or replace the authoritative product close result.

Traces to: U7, U8.

### S11 — Managed OpenClaw and Hermes observability continuity

For an observability-enabled managed OpenClaw or Hermes zone, Agent VM MUST
preserve the existing controller-authored mediated OTLP HTTP path for both the
framework producer and the managed common Tool Portal service. The fixed
producer identities remain `agent-vm-openclaw`, `agent-vm-hermes`, and
`agent-vm-tool-portal`; framework and Tool Portal signal toggles, source
policies, admission limits, and resource attributes remain independently
owned by the existing managed observability configuration.

The TypeScript LogTape roots MUST NOT write, reinterpret, or derive behavior
from the reserved managed Hermes `OTEL_*` and `AGENT_VM_HERMES_OTEL_*`
environment contract. The controller-authored environment remains
authoritative, the Python Hermes adapter continues to validate and operate that
contract, and no LogTape configuration runs inside the Hermes framework
process. The OpenClaw framework's existing telemetry owner likewise remains
separate from LogTape.

Worker zones MUST continue to reject enabled zone observability. Managed Worker
proof therefore covers structured stderr only; standard OTEL logs environment
support for a standalone Worker process is not evidence of a managed Worker
OTLP path.

Traces to: U6, U7, U10.

## Compatibility and cutover obligations

### S12 — Two stacked hard cutovers

The Optique pull request MUST contain the complete CLI cutover and no LogTape
behavior. The LogTape pull request MUST be based on the accepted Optique state
and contain the complete general-diagnostic cutover. Neither state MAY contain
a feature flag, dual parser/logger path, compatibility layer, or deprecated-
plugin work.

Configuration schemas, controller/worker routes, runtime protocols, operation
semantics, and package exports outside the owned CLI/logging surfaces MUST NOT
change.

Traces to: U1, U3, U5, U7, U10.

## Required proof

| Obligation | Required evidence |
| --- | --- |
| S1 | Manifest, lockfile, source, test, and active-doc scans prove Optique presence and zero active `cmd-ts` or manual-parser residue. |
| S2 | Parser units cover reused and narrowed Zod v4 schemas, scalar required/optional/default projection, repeated-array projection and empty default, contextual fallback remaining operation-owned, coercion/transformation, safe placeholders, help requiredness/default rendering, boundary values, and invalid values. A source/AST boundary test rejects private Zod introspection and independently declared option defaults/optionality/array types. |
| S3 | Import/purity tests prove parser construction does not load effect owners; dispatcher tests prove one operation and exhaustive typing; a source/AST boundary test proves each exported command union is exactly `InferValue<typeof rootParser>` and rejects a second handwritten command-union declaration. |
| S4 | Built-binary host E2E covers all five binaries: help, valid, existing boundary, missing/invalid, streams, status, and safe effect; `agent-vm` version is covered. |
| S5–S6 | Static classification plus logger-capture units prove categories, levels, fields, root-only configuration, and library isolation. |
| S7 | A production-shaped OTLP receiver observes a causal record from every root actually configured for OTLP; explicit service identities and disabled, absent, unavailable, and signal-disabled endpoint paths preserve product behavior. Managed Worker is excluded from collector proof because it has no managed OTLP path. |
| S8 | Built-process transcripts prove protected stdout/stderr bytes and show help/version paths are independent of logging setup/disposal. |
| S9 | Misuse tests reject/omit secrets, content, raw errors/stacks, and unsafe URLs while retaining bounded diagnostic context. |
| S10 | Lifecycle tests prove product-close-before-logging-dispose, one disposal, original-result precedence, and containment when both disposal and fallback writing fail. |
| S11 | Real managed OpenClaw and Hermes zone E2E observes the fixed framework and `agent-vm-tool-portal` identities through mediation, exercises signal toggles, and proves prohibited content remains absent; Hermes proof also exercises the Python-owned fail-closed environment contract. |
| S12 | Each PR passes targeted units/integration/host E2E, workspace build, formatting, lint, typecheck, taxonomy, and `pnpm check`; outside-suite smoke invokes every affected built root. |

VM boot is required for the managed OpenClaw and Hermes observability continuity
proof and only otherwise when a changed logging root cannot be reached through
a production-shaped process proof. Parser-only behavior does not require a VM
boot.
