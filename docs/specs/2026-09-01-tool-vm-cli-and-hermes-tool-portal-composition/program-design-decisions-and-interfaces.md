# Tool VM CLI and Hermes Tool Portal Composition — Design Decisions and Interfaces

This is a normative companion to the
[Program Design](program-design.md). It keeps the alternative analysis and
behavioral interface contracts inspectable without obscuring the Program
Design's integrated architecture, call, state, failure, trust, and proof views.

## Alternatives

| Alternative | Gain | Cost or failure | Disposition |
| --- | --- | --- | --- |
| Reuse unprefixed configured-CLI restrictions in the Tool VM | Small schema reuse | Fake safety; bypassable through terminal/Python | Rejected |
| Reuse matcher/classifier internals behind hint-prefixed Tool Portal behavior | Familiar operator guidance and existing approval UX without claiming containment | Requires target-specific names, diagnostics, and documentation | Selected |
| Add tool_vm to controller_execution configured_cli | Similar authored target union | Misroutes direct Tool VM work through controller ownership or creates target-dependent hidden routing in a controller backend | Rejected |
| Add unrestricted command.cli to tool_vm_runner | Honest backend ownership; direct strict SSH; no fake policy | Requires a shared public CLI input/result projection | Selected |
| Expose a full arbitrary shell command instead of a configured executable | Maximum symmetry with terminal | Loses per-CLI discovery identity and duplicates terminal exactly | Rejected by owner decision: config names executable |
| Give execute_code a direct Gateway Runtime UDS client | Simple child API | Leaks privileged transport and duplicates profile/session authority | Rejected |
| Patch each deployment or fork Hermes | Immediate local control | Deployment coupling, pin drift, duplicated behavior | Rejected |
| Install an exact-pin Agent VM adapter bridge | Ships inside Agent VM, reuses current registry/RPC and pin | Must fail closed when pinned private seams change | Selected |

Revisit the adapter bridge only when upstream Hermes provides a stable
programmatic-tool extension point carrying full session context. At that point,
replace the exact-pin bridge rather than keeping dual paths.

## Behavioral interfaces

### Tool VM CLI authored definition

Owner: Config contracts.

Consumers: config loader, effective projection, Gateway Runtime catalog
compiler.

Preconditions:

- absolute executable path;
- safeHelp and metadata within bounds;
- valid Tool-VM-relative working directory;
- no admitted grammar, unprefixed semantic policy, or privileged runtime fields.

Postcondition: one target-specific protected operation and one public
capability contract.

Failure: configuration is rejected atomically; no Gateway generation starts.

### Tool VM CLI call

Owner: Gateway Runtime Tool VM CLI executor.

Input: ToolVmCliInput plus trusted context and Tool Portal dispatch authority.

Output: common ConfiguredCliResult plus ordinary Tool Portal item outcome.

Side effect: exactly one strict-SSH process attempt in the current Tool VM after
successful acquisition.

Ordering: argv and stdin are passed exactly; no shell layer is added.

Cancellation: caller cancellation or resolved timeout cancels the exact SSH
operation. Possible post-dispatch effects remain ambiguous.

Negative space: no controller RPC, no target fallback, no command semantics.

Hint behavior: ToolPortalService may stop or pause this call before acquisition
according to hintDeny or hintRequiresApproval. That route-local outcome makes no
claim about terminal/Python authority in the same Tool VM.

### Programmatic Tool Portal helper

Owner: Execute-code Tool Portal bridge for helper availability; existing
managed Tool Portal handler for invocation semantics.

Input/output: the same portable request/result dictionaries as the direct
registered Hermes tool.

Ordering: each awaited helper call completes or returns an error before Python
continues; Python may initiate concurrent calls explicitly, subject to existing
Tool Portal and execute_code limits.

Authority: current parent Hermes session context only.

Negative space: no direct UDS, backend selector, lease, SSH, credential, or
approval API in the child.

Cancellation: the invocation-scoped coordinator binds every nested call and
approval presentation to the outer execute_code lifecycle. Outer teardown
completes only after the nested dispatch is terminal and the RPC polling thread
has stopped.

## Deliberate simplifications and revisit signals

- No Tool VM CLI admitted grammar or containment policy. Optional route-local
  hints remain explicitly advisory. Revisit authoritative restriction only if
  terminal and execute_code authority are removed and the Tool Portal route
  becomes the sole executable authority.
- No full arbitrary-shell Tool Portal operation. Configuration retains one
  executable identity for discovery.
- No direct child Portal client. Revisit only if Hermes provides an isolated,
  authenticated, session-scoped official client contract.
- No new composition transaction, state store, queue, retry engine, or
  compensation system.
- No deployment CLI catalog in Agent VM.
- No Hermes fork. Replace the exact-pin adapter bridge when an upstream public
  extension seam becomes available.
