# Configurable Controller Execution and Managed Gateway Approval Requirements

## Purpose

Tool Portal was designed to expose two controller-owned operation forms through one managed capability plane: promoted typed registered actions and reviewed broad CLI allowances. Broad CLI allowance is a generic policy and public-input form, not an execution target. It lets deployment operators fix an executable, trusted prefix, admitted command paths, timeout class, and execution target while callers provide only tokenized arguments, a reason, optional bounded stdin, and—only for open operations—an optional bounded command timeout.

Controller-owned configured CLI execution may target the trusted controller host or a new operation-scoped ephemeral ManagedVm runner. The shipping `tool_vm_runner` backend remains a third, distinct concept: it operates on the caller's current leased Tool VM through Gateway-owned strict SSH and is neither renamed nor reused as the ephemeral runner.

Tool Portal policy already classifies individual capability calls as `withoutApproval` or `requiresApproval`. The controller already owns durable exact-intent challenges and at-most-one dispatch admission, but managed Gateways do not yet present those challenges through their active human surface.

The required product outcome is the complete generic system: managed configuration can expose reviewed broad CLIs against an explicit controller-owned target without defining every command schema, registered actions retain their reviewed executor, and either operation form can use the same controller-owned approval lifecycle through a native managed-Gateway interaction.

This document owns why that capability exists, who needs it, and its boundary. The observable contract is defined separately in the [Specification](./2026-08-20-managed-gateway-approval-presenter-specification.md).

## Governing sources

- Owner-confirmed decisions in the 2026-08-20 design conversation authorize the configuration altitude, command-path and flag semantics, direct-argv behavior, intentional-upgrade boundary, controller approval ownership, and native managed-Gateway interaction.
- The existing [Tool Portal CLI Allowance Contract](../2026-06-25-tool-portal-composition-contract.md#cli-allowance-contract), [Gateway Runtime broad CLI contract](../2026-07-12-agent-vm-gateway-runtime/agent-vm-gateway-runtime.md#broad-cli-and-promoted-capability-contract), and controller-owned execution vocabulary remain normative where this Requirements document does not explicitly refine their older mandatory flag-grammar, credential, and target-coupled designs.
- Current production configuration and controller-host-action source are observational evidence of the missing composition; they do not narrow the authorized broad-CLI outcome.

## Authorized needs

| ID | Affected class | Authorized need and outcome | Priority | Authority state and source |
| --- | --- | --- | --- | --- |
| U1 | Deployment operator | Configure protected Tool Portal calls through the existing generic `requiresApproval` policy without naming a framework in capability policy. | Must | Authorized — owner-confirmed conversation, 2026-08-20 |
| U2 | Human using a managed Gateway | Receive one native approval interaction in the active framework surface and, when admitted by that framework's existing actor-authorization rule for the originating session, have an approved call continue without a CLI, manual HTTP request, or second human approval. | Must | Authorized — owner-confirmed native actor boundary, 2026-08-20 |
| U3 | Security operator | Preserve controller ownership of exact call intent, decision state, expiry, replay protection, and single-dispatch admission. | Must | Authorized — owner-confirmed conversation plus current controller approval contract |
| U4 | Gateway integrator | Implement one framework-neutral presentation and decision contract while keeping rendering, native human identity, and authenticated actor admission framework-owned and bound to the originating surface/session and request. | Must | Authorized — owner-confirmed generic-system and native actor boundary, 2026-08-20 |
| U5 | Maintainer | Deliver the smallest extension to existing config, portable schemas, Gateway Runtime, controller approval, and one managed Gateway adapter without a second approval system. | Must | Authorized — owner-confirmed lean-scope direction, 2026-08-20 |
| U6 | Deployment operator | Configure a reviewed broad CLI once by fixing its executable, trusted prefix, admitted command paths, timeout class, execution target, and enforceable target policy instead of defining a bespoke input schema for every CLI command. | Must | Authorized — owner-confirmed target-neutral configuration altitude, 2026-08-20; prior Tool Portal broad-CLI contract |
| U7 | Managed agent | Discover and call each broad CLI allowance through one automatically derived generic input containing tokenized `argv`, a reason, optional bounded stdin, and an optional bounded command timeout only for open operations, while ordinary positional values and flags remain usable. | Must | Authorized — owner-confirmed caller and timeout contract, 2026-08-20 |
| U8 | Security operator | Ensure caller input cannot select or override the executable, trusted prefix, execution target, fixed cwd, inherited environment allowlist, runner binding, output bounds, or raw RPC deadline; ensure the controller independently revalidates direct array-argv execution and resolved command timeout; and expose the different host-authority and ManagedVm-containment guarantees honestly. | Must | Authorized — owner-confirmed controller-execution trust boundary, 2026-08-20; current host and ManagedVm runner evidence |
| U9 | Deployment operator | Grant narrow command paths such as `remove one` without granting siblings such as `remove all`, reject overlapping aliases that could cross approval posture, apply explicit flag/value carve-outs only where needed, and review the authority surface when intentionally upgrading the CLI. | Must | Authorized — owner-confirmed command and flag semantics, 2026-08-20 |
| U10 | Maintainer | Preserve promoted typed registered actions as reviewed operations whose definition owns target and executor, while broad CLI operations carry generic input plus a trusted target binding; both share catalog, policy, approval, controller-execution, and result boundaries. | Must | Authorized — owner-confirmed generic-system boundary, 2026-08-20; prior Tool Portal promotion contract |
| U11 | Security operator | Keep operation-scoped ephemeral ManagedVm execution separate from the caller's leased Tool VM: one fresh controller-owned VM per operation, no SSH, lease, reuse, or adoption, durable identity/lifecycle records, and positive containment before a safe terminal claim. | Must | Authorized — owner-confirmed target model, 2026-08-20; current ManagedVm runner and Gateway Runtime contracts |

## Desired outcomes

- O1: Capability policy remains backend-neutral and framework-neutral.
- O2: A configured managed Gateway can present each protected call through its native human surface, and only an actor admitted by the framework's existing authorization rule for that originating session may resolve it.
- O3: The controller remains the only authority that changes approval state and admits dispatch.
- O4: Approval, denial, unauthorized actor interaction, timeout, cancellation, duplicate interaction, and stale intent have deterministic non-ambiguous outcomes before backend dispatch.
- O5: The system ships without new services, new durable stores, or a second operator workflow.
- O6: Managed configuration can define registered typed operations and broad CLI operations through a `controller_execution` backend; every broad operation binds exactly one `controller_host` or `ephemeral_managed_vm` execution target.
- O7: An allowed command path grants the CLI's ordinary tokenized grammar after that exact path; config authors need only add explicit deny or allowed-value rules for exceptional flags.
- O8: Every invocation resolves to one configured operation and one effective command path; duplicate or proper-prefix-overlapping `[...mandatoryArgvPrefix, ...commandPath]` sequences are rejected across every configured operation sharing an executable in one effective profile.
- O9: The controller executes only a trusted recomputed uncredentialed invocation with target-appropriate cwd/environment, bounded stdin/stdout/stderr, and a resolved command runtime; no shell command string, caller-selected target, or caller-authored RPC expiry crosses the boundary.
- O10: CLI upgrades are deliberate authority-surface reviews: new ordinary flags beneath an admitted path become usable unless the reviewed configuration denies them.
- O11: Typed registered actions remain available when a narrower domain schema, credential authority, or reviewed executor is worth the additional contract and maintenance cost.
- O12: `ephemeral_managed_vm` creates and positively contains one operation-scoped runner, while `tool_vm_runner` continues to mean the caller's current leased Tool VM over strict SSH.

## Existing foundation to preserve

- Tool Portal profiles, complete namespace policies, and per-tool `withoutApproval` / `requiresApproval` selectors.
- The designed broad CLI allowance and tokenized-argv validator, existing controller host-action RPC path, current operation-scoped ManagedVm runner scaffold and lifecycle ledger, and generic registered-action registry.
- The shipping `tool_vm_runner` backend, `sandbox_ssh` profile, current leased Tool VM binding, and direct strict-SSH data path remain distinct and unchanged.
- Controller approval challenge, ledger, fingerprint, expiry, decision, reservation, and dispatch-arm behavior.
- Private authenticated Gateway Runtime attachment and Gateway Control session.
- Portable Portal catalog, call, and item-result contracts, including item-level `approval_required` outcomes.
- Existing bearer-authenticated controller approval routes for external operators.
- Promoted typed controller-owned actions and their domain-specific input schemas.

## Boundary

The work may change managed Tool Portal configuration contracts and generated JSON Schema, controller-execution catalog composition, portable broad-CLI call contracts, CLI allowance validation, controller host and operation-scoped ManagedVm dispatch integration, Gateway Runtime and Gateway Control contracts, approval authority integration, managed Gateway lifecycle capability declarations, and the first framework adapter/presenter implementation. The generic contracts remain framework-neutral, but Hermes is the only framework presenter implemented in this release; OpenClaw and Worker receive no presenter implementation.

The work remains generic above a framework presenter and above a configured executable. A concrete CLI, deployment, agent, zone, or human-data policy is an example or consumer of this system, not design authority for it.

## Non-goals

- No CLI-specific compiled action set as the required path for broad access.
- No per-command public input schema, argv template, or mandatory per-flag allowlist for a broad CLI allowance.
- No caller-authored shell command string and no shell evaluation of caller tokens.
- No arbitrary caller-selected executable, prefix, cwd, environment, credential, egress policy, target, or output policy.
- No generic credential profile/reference, authored environment values, secret references, or credential-bearing environment materialization for `configured_cli`. The reviewed `empty | inherit_allowlist` policy may copy only named existing non-secret controller-process values; credentialed operations require promotion to a reviewed `registered_action` until a separate credential authority is authorized.
- No configurable stderr redaction profile. `configured_cli` may expose no stderr or one code-owned fixed safe summary.
- No generic controller-host filesystem sandbox, network/egress sandbox, artifact capture, custody mode, or Managed VM containment guarantee in this release. The reviewed executable and admitted command paths run with the controller process's host OS authority.
- No renaming, replacement, or reuse of shipping `tool_vm_runner` for operation-scoped ephemeral execution.
- No SSH, persistent lease, reuse, adoption, or agent-selected VM for `ephemeral_managed_vm`.
- No operation-authored numeric timeout or caller-authored RPC deadline. Operators select only `quick` or `open`; callers may supply `timeoutMs` only for open operations.
- No configuration fields that imply unavailable host containment. Adding filesystem/network containment or artifact custody reopens scope.
- No promise that an allowed command path remains semantically unchanged across an operator-initiated executable upgrade.
- No removal of promoted typed actions; promotion remains the stricter option for repeated stable operations.
- No standalone Tool Portal access to `controller_execution` in this release.
- No per-command controller execution RPC added to `tool_vm_runner`; its Gateway-owned strict-SSH path remains direct to the caller's current leased Tool VM.
- No new per-human Tool Portal visibility or capability authorization model.
- No capability-specific or deployment-specific approval configuration.
- No replacement for controller approval authority.
- No model-visible approval credential, proof token, or decision field.
- No `session`, `always`, YOLO, blanket, or standing approval for managed Tool Portal calls.
- No new CLI approval workflow or requirement that humans call controller HTTP routes.
- No new external relay service, queue, database, or approval ledger.
- No automatic dispatch after a Gateway process crash unless the exact call is submitted again and the controller independently admits it.
- No simultaneous implementation of every managed framework presenter; one presenter proves the generic contract.
- No OpenClaw or Worker approval presenter, framework UI, or adapter implementation in this release.
- No upstream Hermes change, fork, release, or private monkeypatch. The Hermes presenter integrates through the pinned runtime surface already supplied to the in-repo adapter.

## Accepted complexity

The accepted complexity is one `controller_execution` operation union, one strict configured-CLI target union, two automatically derived quick/open generic caller schemas, uniquely resolvable command paths and optional flag rules, one lean host policy, the existing operation-scoped ManagedVm lifecycle/containment contract, one approval-authority variant, one portable presentation contract, one private decision operation, one controller authorization path, and one first presenter.

New services, durable coordination state outside the existing controller ledger, a second command registry, per-CLI grammar mirrors, broad framework forks, or standing grants reopen scope and require owner approval.

## Outcome-level evidence

Completion evidence must separately demonstrate:

- typed configuration and generated JSON Schema accept each valid operation variant and reject mixed, unknown, colliding, standalone, selector-invalid, unsupported-containment, and cross-prefix effective-command overlap definitions;
- quick operations omit and reject `timeoutMs`; open operations resolve omission to 120,000 ms, accept positive values through 28,800,000 ms, and reject caller-authored RPC deadlines;
- command-path uniqueness, positional, punctuation-as-data, flag, allowed-value, deny-pattern, stdin, timeout, and target-appropriate output behavior across a table of allowed and rejected calls;
- effective configuration produces the expected catalog and automatically derived quick/open generic public schema without a per-command schema;
- model-visible catalogs and private Gateway projections omit executable, prefix, cwd, environment, credential identifiers, output policy, and every other controller-trusted execution field, and forged replacements are rejected;
- a private managed Gateway call reaches its configured controller-owned execution target only after controller revalidation;
- a real host fixture process receives the exact trusted executable, prefix, caller tail, and bounded stdin without a shell;
- a real operation-scoped ManagedVm runner proves one-shot creation, array argv, no SSH/lease/reuse/adoption, lifecycle identity recording, command timeout after process start, cleanup, and positive containment;
- shipping `tool_vm_runner` still resolves the caller's current leased Tool VM and never routes to the operation-scoped runner;
- approval-free calls dispatch directly, while managed-Gateway approval and denial produce respectively one and zero backend effects;
- an unauthorized native-surface actor cannot resolve a prompt, causes no controller decision RPC and zero backend effects, leaves the challenge unchanged, and receives bounded framework feedback;
- missing requested inherited environment values and fixed-safe-summary sanitization failures fail closed without exposing raw host output;
- mutating any trusted CLI policy field invalidates a challenge created under the prior policy and produces zero backend effects;
- promoted typed registered actions retain their existing behavior.

Schema-only or validator-only evidence cannot prove controller execution. A fake runner cannot prove process argument fidelity. A native prompt alone cannot prove exact controller dispatch admission.

## Unresolved hypotheses

None. The owner has settled the target-neutral broad CLI form, `controller_execution` hard cutover, exact two-target union, immutable `imageReference` binding, code-owned one-shot runner construction, quick/open timeout semantics, leased Tool VM separation, approval owner, and managed-only boundary for this design cycle.
