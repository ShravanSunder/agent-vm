# Configured CLI Invocation Permissions Requirements

## Purpose

Agent VM currently admits configured CLI command paths and can deny flags or
restrict their values, but Tool Portal assigns approval posture to the entire
named operation. Operators cannot express that one command-and-flag combination
is denied, another requires approval, and the remaining admitted invocations
run without approval.

The required improvement classifies each admitted `configured_cli` invocation
from its exact command path and present flags while preserving the existing
controller-owned exact-intent approval and execution boundaries.

## Decision authority and source

The deployment owner authorized this requirement on 2026-08-22 and confirmed
the governing rule:

```text
DENY > REQUIRES_APPROVAL > WITHOUT_APPROVAL
```

The owner also confirmed the discriminating example:

```text
complete item --project  -> DENY
complete item --task     -> WITHOUT_APPROVAL
```

Current source and the 2026-08-20 controller-execution specification are
observational and prior normative sources for the foundation being revised.
This requirements set supersedes that specification's operation-wide approval
limitation and relocates explicit path-scoped flag denial into the unified
invocation-call policy. All unrelated controller-execution and presenter
obligations remain in force.

## Consumers

- Deployment operators need one configured CLI operation whose different
  command-and-flag invocations can carry different permission outcomes.
- Managed agents need ordinary admitted invocations to remain directly usable
  while sensitive invocations receive the existing native approval flow.
- Human approvers need prompts only for the exact invocations the operator
  classified as approval-required.
- Controller and backend owners need Gateway advice to remain non-authoritative;
  the controller must recompute the disposition before dispatch.

## Authorized needs

| ID | Affected class | Priority | Authorized need | Evidence and authority |
| --- | --- | --- | --- | --- |
| U1 | Deployment operator | Must | Classify one configured CLI invocation from its matched command path plus present flags instead of classifying the entire operation uniformly. | Owner-authorized, 2026-08-22 |
| U2 | Deployment operator | Must | Deny `complete <item> --project` while allowing `complete <item> --task` without creating separate executable bindings or operation aliases. | Owner-authorized discriminating example, 2026-08-22 |
| U3 | Deployment operator | Must | Mark selected command paths or command-and-flag combinations as approval-required while the remaining admitted invocations run without approval. | Owner-authorized, 2026-08-22 |
| U4 | Managed agent and approver | Must | Resolve multiple matching rules deterministically using `DENY > REQUIRES_APPROVAL > WITHOUT_APPROVAL`. | Owner-authorized precedence, 2026-08-22 |
| U5 | Deployment operator | Must | Preserve exact tokenized command-path matching, ordinary positional tails, flag aliases/value normalization, explicit deny/value restrictions, and admission of unmentioned ordinary flags. | Existing configured-CLI foundation retained by owner boundary |
| U6 | Controller owner | Must | Bind approval to the complete exact invocation and have the controller recompute disposition from current trusted policy before process creation. | Existing controller authority retained by owner boundary |
| U7 | Gateway operator | Must | Apply the same invocation policy to `controller_host` and `ephemeral_managed_vm` without changing target selection, timeout, output, or containment semantics. | Existing two-target contract retained by owner boundary |
| U8 | Hermes user | Must | Reuse the existing Hermes-native approve/deny presenter for approval-required invocations; do not add OpenClaw or Worker presenters. | Existing presenter boundary retained by owner direction |
| U9 | Tool VM caller | Must | Leave `tool_vm_runner` on its existing Gateway-to-leased-Tool-VM strict-SSH path. | Existing backend separation retained by owner boundary |

All priorities are assigned by the deployment owner.

## Desired observable journey

```text
operator (U1-U5) configures one configured_cli operation
  -> admits exact command paths and ordinary argv grammar
  -> classifies selected command/flag matches

agent (U3-U5) calls the operation with tokenized argv
  -> admission validation runs
  -> all matching disposition rules are evaluated
  -> strongest disposition wins

DENY
  -> bounded rejection and zero process creation

REQUIRES_APPROVAL
  -> human approver (U4, U8) receives the existing exact Hermes decision flow

WITHOUT_APPROVAL
  -> existing direct-dispatch flow
```

## Goal boundary

The change may extend the configured-CLI authored/effective/Gateway projection
contracts, portable call-policy decision behavior, controller revalidation,
semantic revisions, diagnostics, generated schemas, and corresponding manuals.

The change must preserve:

- `registered_action | configured_cli` as the controller-execution union;
- exact `controller_host | ephemeral_managed_vm` target selection;
- array argv with no shell evaluation;
- quick/open timeout, stdin, output, environment, and containment contracts;
- current exact approval challenge, native presentation, decision, reservation,
  retry, and at-most-one dispatch lifecycle;
- Hermes as the only implemented managed-Gateway presenter;
- unchanged `tool_vm_runner` lease, SSH, and execution behavior.

## Acceptable complexity

One bounded command-and-flag matcher shape, one three-disposition evaluation,
one Gateway advisory classification, and one controller-authoritative
recomputation are acceptable. A general expression language, CLI parser plugin,
policy service, new ledger, new approval authority, compatibility alias, or
framework-specific capability policy is not.

## Non-goals

- Matching arbitrary positional values after the configured command path.
- Reconstructing a CLI's complete grammar, aliases, subcommands, or response
  files.
- Denying every unmentioned ordinary flag.
- Downgrading an operation already selected by namespace policy as
  approval-required.
- Session-wide, standing, always, or YOLO approval.
- New secrets, credentials, environment authority, filesystem/network policy,
  or runner lifecycle systems.
- OpenClaw or Worker approval presentation.
- Changing standalone MCP Portal or leased Tool VM call policy.

## Success evidence

Evidence must cover the full pyramid: pure matcher and precedence behavior;
config/effective projection and controller/Gateway agreement; host and real
Managed VM dispatch counts; Hermes-native approval and denial; and explicit
Tool VM regression. Schema-only evidence cannot prove invocation-level approval
or zero/one effects.

## Unresolved decisions

None. Matching uses exact configured command paths plus present flags and
optional exact allowed values; positional tails remain data. Existing admission
failures deny, selected matches may require approval, remaining admitted
invocations inherit the operation's existing call-policy baseline, and the
strongest disposition wins.
