# Optique CLI Migration Requirements

## Authority and boundary

The repository owner requested a complete replacement of `cmd-ts` with
[Optique](https://github.com/dahlia/optique), using `@optique/zod` and the
repository's existing Zod schemas for command-line value validation. This
document is the Requirements identity for that request.

The affected developer users and operators invoke the two shipped command-line
programs:

- `agent-vm`, the controller and deployment-management CLI;
- `agent-vm-worker`, the in-VM worker process CLI.

The change is limited to CLI definition, parsing, validation, dispatch, help,
version, error reporting, package dependencies, and proof for those two
programs. Command business operations, controller behavior, worker HTTP
behavior, deployment formats, and runtime protocols remain outside the change.

## Authorized needs

### U1 — One maintained CLI parsing foundation

The two shipped CLIs need one current parsing foundation based on Optique. The
repository must not retain `cmd-ts` as a direct, transitive-by-choice, source,
test, or documentation dependency for active code.

Priority: required.

### U2 — Zod remains the validation language

CLI value constraints need to use `@optique/zod` so command parsing shares the
repository's Zod vocabulary and can reuse existing authoritative schemas rather
than maintaining parallel `cmd-ts` value parsers and manual validators.

Priority: required.

### U3 — Existing operator workflows continue to work

Users must retain the existing command and nested-command paths, option names
and aliases, positional inputs, defaults, successful side effects, and
action-level failure behavior. Help and version requests must remain successful
operator actions, while malformed invocations must remain failures with useful
diagnostics.

Exact legacy help layout, punctuation, wrapping, color, and `cmd-ts`-specific
error wording are not compatibility requirements.

Priority: required.

### U4 — The cutover is complete and comprehensible

The migration must be a hard cutover. It must not introduce a compatibility
adapter that recreates the `cmd-ts` API, retain dual parser trees, or place CLI
business operations inside Optique parser declarations. The resulting ownership
must remain legible: parser definitions describe inputs, application dispatch
selects an operation, and existing operation modules perform effects.

Priority: required.

### U5 — The shipped binaries are proven, not only type-correct

Maintainers need automated and black-box evidence that both built binaries
parse representative valid, boundary, invalid, help, and version invocations;
dispatch the intended operation once; write diagnostics to the intended stream;
and return the intended success or failure status.

Priority: required.

## Desired outcome

Both published CLIs are wholly implemented on Optique and `@optique/zod`, use
Zod schemas at CLI value boundaries, preserve the supported operator contract,
and contain no active or packaged `cmd-ts` residue.

## Non-goals

- Redesigning command names, option names, defaults, or business behavior.
- Introducing async or remote validation during argument parsing.
- Sharing one parser tree between `agent-vm` and `agent-vm-worker` merely to
  remove textual duplication.
- Refactoring command operation modules unrelated to separating parsing from
  dispatch.
- Adding shell completion as a new supported product surface.
- Preserving undocumented `cmd-ts` formatting quirks.

## Accepted requirements set

`U1` through `U5` are the complete accepted set for this design. Expansion into
new commands, new parser features, operation refactors, or runtime behavior
requires a separate owner decision.
