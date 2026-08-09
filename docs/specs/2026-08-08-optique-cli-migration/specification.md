# Optique CLI Migration Specification

Requirements: [requirements.md](requirements.md)

## Observable change

Today, the controller and worker CLIs use Optique, while Tool Portal, MCP Portal,
and Gateway Runtime still parse arguments manually or with `node:util.parseArgs`.
Several CLI values are then validated a second time by hand or through existing
Zod schemas. After this change, Optique parses every active command tree and
`@optique/zod` validates every value whose accepted domain is described by Zod.

```text
operator argv
    |
    +--> agent-vm ---------> existing controller/deployment operations
    |
    +--> agent-vm-worker --> existing serve/health operations
    +--> tool-portal -----> existing portal invocation operations
    +--> mcp-portal ------> existing portal administration/server operations
    `--> gateway-runtime -> existing managed runtime startup

Every active CLI surface uses Optique + @optique/zod at its input boundary.
```

## Normative obligations

### S1 — Complete dependency cutover

The workspace MUST use mutually compatible current releases of `@optique/core`
and `@optique/zod` that support Zod 4 and the required
`zod(schema, { placeholder })` API. `cmd-ts` MUST be absent from every active
parser-owning package manifest, the lockfile package graph, active TypeScript
imports, active tests, and current operational documentation describing the CLI
implementation.

The permanent cutover checker has exactly two kinds of named exceptions: its
own checker implementation may contain the forbidden name so it can detect it,
and these eight documentation paths may retain historical subject references:
the current migration's `requirements.md`, `specification.md`,
`program-design.md`, and plan, plus the four historical plans under
`docs/superpowers/plans/` that already document unrelated completed work. No
other `docs/**` path, including other `docs/specs/**` files, is exempt.

Traces to: U1, U4.

### S2 — Full command-surface preservation

The `agent-vm` CLI MUST retain every currently supported top-level command,
nested command path, long option, short option, positional argument, default,
and required-versus-optional rule represented by its current command
definitions. The `agent-vm-worker` CLI MUST retain the `serve` and `health`
paths and their current options and defaults.

`tool-portal`, `mcp-portal`, and `agent-vm-gateway-runtime` MUST retain every
current operation, nested path, option, positional value, transport constraint,
canonical stdout payload, and process status. Gateway Runtime MUST continue to
require exactly `--config <absolute-path>`.

For the same valid invocation and injected dependencies, the selected business
operation MUST receive equivalent typed values and execute once. This includes
flags, optional values, enum-like choices, transformed values, numeric values,
and positional values.

Exact help prose layout, ordering where no semantic order is promised, terminal
styling, legacy parser wording, and legacy parser-specific tokenization quirks
are intentionally unspecified. Optique's standard grammar is authoritative,
including equivalent attached long-option values such as `--config=/path`.

Traces to: U3, U4.

### S3 — Zod-backed value validation

Every CLI value parser MUST be created through `@optique/zod` when the value has
a Zod-expressible domain. Existing authoritative Zod schemas MUST be reused when
they describe the exact CLI domain, including agent id, secrets provider, and
image architecture. A deliberately narrower CLI contract MUST use a named
CLI-owned subset schema adjacent to its command definition. In particular,
`init --type` MUST continue to accept only `openclaw | worker` and reject
`hermes`, even though the repository-wide gateway domain also contains
`hermes`. Other CLI-only domains MUST likewise use named Zod schemas rather
than manual `Type.from`, `oneOf`, or post-parse string classification.

Non-string CLI outputs MUST use an explicit coercing or transforming Zod schema.
Every `zod()` invocation MUST provide an output-type-safe placeholder. Boolean
switches whose presence alone selects `true` MAY use Optique's flag primitive;
boolean values supplied as strings MUST use the Zod integration's CLI boolean
conversion.

Argument validation MUST remain synchronous. Remote, filesystem, secret, and
other asynchronous checks MUST remain in the invoked operation after parsing.

Traces to: U2, U4.

### S4 — Dispatch and effect isolation

Parsing MUST produce a discriminated command value before business execution.
Each leaf command MUST have a stable discriminator. One dispatcher per shipped
CLI MUST exhaustively select the corresponding existing asynchronous operation.
Parser construction MUST NOT perform business effects.

`CliIo` and existing dependency injection boundaries MUST continue to determine
business output and replaceable dependencies. The process entrypoint alone MAY
map an unhandled command failure to `process.exitCode`.

Traces to: U4, U5.

### S5 — Help, version, diagnostic, and status behavior

For every active binary:

- top-level help and leaf/nested-command help MUST describe the reachable
  command path and its options, write to standard output, and complete with
  success;
- the existing `agent-vm` version surface MUST report the resolved CLI version
  and complete with success;
- unknown commands, unknown options, missing required values, and Zod-invalid
  values MUST produce one useful diagnostic on standard error and result in a
  failing process status;
- an operation error MUST not be printed twice;
- calling the exported in-process CLI runner MUST not terminate the test or host
  process.

The migration MAY adopt Optique's wording, usage layout, suggestions, and color
behavior. It MUST NOT expose a stack trace for ordinary parse failures.

For the proof obligation above, a boundary invocation exercises an existing
edge of a CLI value domain, such as an accepted numeric limit or an
optional-versus-required transition. Boundary coverage does not add a command,
option, or validation domain.

Traces to: U3, U5.

### S6 — Public and package compatibility

No runtime API, configuration schema, generated deployment file, controller
route, worker route, or package export outside the CLI runner/definition surface
MAY change as part of this migration. Published packages that own CLI parsers
MUST contain the narrow Optique runtime dependencies needed by their binaries
and MUST contain neither a parallel manual parser nor a runtime dependency on
`cmd-ts`. Packages without a CLI parser MUST NOT gain ceremonial Optique
dependencies. The deprecated `openclaw-mcp-portal-plugin` is outside this
obligation.

Traces to: U3, U4.

## Failure and boundary examples

```text
agent-vm init zone --type worker --arch aarch64
  -> parses to the init command variant and invokes scaffold once

agent-vm init zone --type invalid
  -> Zod-backed parse rejection, stderr diagnostic, failing status, no scaffold

agent-vm controller --help
  -> controller command help on stdout, successful status, no controller action

agent-vm-worker serve --port 18789
  -> coerces the port to an integer and starts the server once

agent-vm-worker serve --port nope
  -> Zod-backed parse rejection, stderr diagnostic, failing status, no server
```

Behavior after an operation has begun is governed by the existing operation,
not by the CLI parser. The parser provides no retry, rollback, or partial-success
policy.

## Proof obligations

| Obligation | Required observation |
| --- | --- |
| S1 | Static searches and package/lockfile inspection show the Optique set and no active `cmd-ts` residue. |
| S2 | Command-contract tests cover every leaf path and compare names, aliases, defaults, optionality, and representative parsed values; existing command behavior tests remain green. |
| S3 | Unit tests exercise enum, numeric coercion, transformed/reused schemas, invalid inputs, and placeholder-safe parser construction. |
| S4 | Unit tests prove parsing has no effect and exhaustive dispatch invokes one operation; type checking rejects an unhandled variant. |
| S5 | Automated built-binary host E2E tests observe stdout, stderr, and exit status for top-level help, nested or leaf help where that path exists, version where that surface exists, representative valid input, existing-domain boundary input, unknown input, missing input, and Zod-invalid input on every active binary. A separate outside-suite manual smoke invokes every active built binary and records representative argv, stream, status, and one safe effect. |
| S6 | Workspace build, package inspection, targeted unit/integration/host-E2E suites, and the repository quality gate pass without unrelated contract changes. |

Built-binary tests are automated host-E2E evidence; they do not replace the
outside-suite manual smoke. VM boot and live gateway E2E are not required
because parsing does not alter either runtime path.
