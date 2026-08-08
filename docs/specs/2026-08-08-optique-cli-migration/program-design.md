# Optique CLI Migration Program Design

Requirements: [requirements.md](requirements.md)
Specification: [specification.md](specification.md)

## Structural crux

`cmd-ts` currently combines parser construction, inferred handler arguments,
asynchronous handlers, generated help, and a non-terminating `runSafely()`
result. Optique's clean boundary is different: a parser returns a typed value,
then application code dispatches that value. The migration should adopt that
boundary directly instead of recreating the `cmd-ts` handler API.

The chosen design is a hard, leaf-by-leaf parser conversion with discriminated
command values and explicit asynchronous dispatch. This costs an explicit
dispatcher in each binary, but it makes parsing pure, action ownership visible,
and in-process testing independent of process termination.

Rejected alternatives:

- A local `cmd-ts` compatibility facade would minimize edits but preserve the
  old mental model and a second CLI abstraction indefinitely.
- Parser callbacks that immediately run operations would reduce dispatcher
  code but mix pure parsing with effects and make help/error paths harder to
  prove.
- A shared cross-package CLI framework would add ownership and coupling not
  required by the two small, independently shipped command roots.

## Target composition and ownership

```text
agent-vm process entrypoint
  owns: process argv, terminal capability, final process status
  calls: agent-vm in-process runner
    owns: parse result/error normalization and async dispatch
    uses: agent-vm command parser tree
      owns: command grammar, descriptions, Zod value parsers
    dispatches to: existing command operation modules
      own: filesystem, controller, secret, subprocess, and network effects

agent-vm-worker process entrypoint
  owns: process argv, terminal capability, final process status
  calls: worker in-process runner
    owns: parse result/error normalization and async dispatch
    uses: worker command parser tree
      owns: serve/health grammar and Zod value parsers
    dispatches to: worker serve and health operations
      own: server startup and health request effects
```

The two parser roots depend on `@optique/core` constructs/primitives and
`@optique/zod`. The runner boundary uses `runParser()` from Optique's core
facade with explicit `onShow` and `onError` callbacks; it does not use
`@optique/run`'s process-owning `run()`/`runAsync()` path. Operation modules do
not depend on Optique.

Some current `cmd-ts` handlers already delegate to focused operation modules;
others contain orchestration and effects inline in their parser-definition
files. Inline handler bodies are existing operation logic, not parser logic.
During cutover they move behind leaf operation functions owned outside parser
construction. That extraction is limited to separating parse, dispatch, and
effect ownership: it preserves the existing dependency injection, `CliIo`,
environment reads, effects, result formatting, and error behavior.

## Command value contract

Every leaf parser returns a discriminated object:

```typescript
type AgentVmCommand =
	| { readonly command: "init"; readonly options: InitOptions }
	| { readonly command: "controller.start"; readonly options: ControllerStartOptions }
	| { readonly command: "controller.credentials.check"; readonly options: CredentialsCheckOptions }
	| /* one variant for every remaining leaf */ never;
```

The exact discriminator names are internal, but they must be unique, stable
within the parser/dispatcher boundary, and exhaustive. Nested Optique
`command()` parsers and `or()` composition establish the user-facing path;
`constant()` or an equivalent pure mapping establishes the discriminator.

Shared option constructors are permitted only where they own a real repeated
CLI contract, such as the common config option or controller operation options.
They return Optique parsers and never hide dispatch or business behavior.

## Zod value ownership

The CLI layer has three value categories:

1. Existing domain schema: import the authoritative Zod schema and wrap it with
   `zod(schema, { placeholder })`.
2. CLI-only constrained value: define a named adjacent Zod schema, then wrap it.
3. Unconstrained string or presence flag: use a Zod string parser or Optique's
   presence-only flag primitive, respectively.

Numbers use `z.coerce.number()` plus the applicable integer/range constraints.
Transformed schemas receive placeholders of the output type. Optionality and
defaults are composed at the Optique parser level so a placeholder is never
mistaken for a user default. No async Zod path is needed; existing async checks
remain operation-owned.

Manual functions that encode only CLI-domain validation, such as gateway-type
or enum classification, disappear when the authoritative Zod schema owns the
same rule. Functions that perform additional business normalization remain in
their owning operation module.

## Parse, dispatch, and error flow

```text
CURRENT
argv
  -> cmd-ts subcommands/command                     [removed]
  -> cmd-ts value Type / oneOf / optional           [removed]
  -> async handler                                  [changed owner]
  -> operation effect                               [intentionally unchanged]
  -> runSafely Exit/error normalization             [removed]
  -> CliIo + process exitCode                       [changed]

PROPOSED
argv
  -> Optique command/or/object parser               [added]
  -> @optique/zod value validation                  [added]
  -> discriminated command value                    [added]
  -> exhaustive async dispatcher                    [added]
  -> operation effect                               [intentionally unchanged]
  -> runner-owned help/parse/error result           [added]
  -> CliIo + process-entrypoint exitCode            [changed]
```

The in-process runner receives `argv`, `CliIo`, and injected dependencies. It
calls the core-facade `runParser()` with the parser, argv, and callbacks that
write rendered help/version to `CliIo.stdout` and parse diagnostics to
`CliIo.stderr`. These callbacks return typed internal outcomes to the runner;
they never call or monkey-patch `process.exit`. The runner therefore has one
non-terminating execution path for production composition and in-process tests.

Outcomes are normalized into three classes:

- parsed command: dispatch asynchronously and return;
- help/version: write once to stdout and return successfully without dispatch;
- parse failure: write once to stderr and throw `ReportedCliError` (or return an
  equivalent internal failure consumed by the process entrypoint).

Unexpected operation errors propagate unchanged to the existing main error
handler. The reported-error marker continues to prevent duplicate output.

## Failure containment

Parsing is side-effect free, so any parse, help, or version outcome occurs
before an operation starts. Invalid Zod input cannot partially execute a
command. Dispatcher exhaustiveness prevents a parsed command from silently
having no owner.

Once dispatch begins, timeout, cancellation, retry, partial success, and cleanup
remain entirely owned by the existing operation logic, whether it was already
in a focused module or was mechanically extracted from an inline handler. The
CLI migration adds no retry, persistence, lock, or recovery lifecycle.

No new concurrency is introduced. Each invocation parses once and dispatches at
most one leaf operation. Server commands may remain long-running after their
existing startup operation succeeds.

## Cutover

There is one source-tree and package cutover:

1. Both parser trees and runners change together.
2. All active tests change to assert Optique-owned behavior rather than
   `cmd-ts` wording.
3. Both package manifests and the lockfile replace `cmd-ts` with the Optique
   package set.
4. No compatibility phase, feature flag, or dual parser is permitted.

Until all four conditions hold, the branch is not a valid cutover. Rollback is
the changeset as a whole; there is no runtime state to reconcile.

## Requirement realization and proof seams

| Requirement | Structural realization | Observation seam |
| --- | --- | --- |
| S1 | Package manifests plus direct Optique imports in both CLI packages | dependency graph and source/static scan |
| S2 | Leaf Optique parsers preserve the command grammar; discriminated values preserve typed inputs | parser contract units plus existing operation tests |
| S3 | Existing or adjacent Zod schemas wrapped only by `@optique/zod` | focused parser validation units |
| S4 | Pure parser tree followed by one exhaustive async dispatcher per binary | no-effect parse tests and one-dispatch tests |
| S5 | `runParser()` callback normalization and process-entrypoint-only status mapping | in-process runner tests, automated built-binary host E2E, and a separate outside-suite manual smoke of both binaries |
| S6 | Optique confined to CLI definitions/runners; operation dependencies remain unchanged | typecheck, integration/host-E2E suites, package inspection, full quality gate |

Real operation dependencies may be injected/replaced in unit tests. The built
CLI, Node process, argv parsing, terminal streams, and exit status must be real
in automated host-E2E proof and independently observed in the outside-suite
manual smoke. VM and gateway processes are outside this design's observation
boundary.

## Enforced boundaries

- Type-level exhaustive dispatch enforces that every command variant has an
  owner.
- Zod schemas enforce value domains and transformations.
- Static dependency/source checks enforce complete `cmd-ts` removal.
- Unit tests enforce parser purity and one-operation dispatch.
- Built-binary tests enforce user-visible help, diagnostics, and process status.

No new state, persistence, secrets, trust boundary, public API, or runtime
protocol is introduced.
