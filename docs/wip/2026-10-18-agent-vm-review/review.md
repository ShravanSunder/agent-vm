# Agent VM: what you can review now

**Start with the corrected React review prototype.** The owner selected React, Base UI, current shadcn components, `cn` and `@shadcn/lint`, using AgentStudio Bridge's theme. The prototype makes workspace tools, named agents, team-account confirmation and audit presentation concrete. Production registration, distributed identity and authorization remain design work.

| Open | What it lets you review | Evidence boundary |
| --- | --- | --- |
| [React workspace prototype](http://127.0.0.1:61691/) | Workspace availability, agent tool selection, account confirmation, validation, failed saves and audit presentation | New review-only React UI with a fixture backend. No real identity, credentials, provider consent, grants or tool execution. |
| [Current React screenshots](review.html#react-evidence) | Corrected tables, forms, dialogs and phone Sidebar | Captured from the actual prototype. Advisor consistency recheck passed 7/7 from captures and source; this is not production or accessibility acceptance. [Source and reproduction](react-prototype/README.md). |
| [Current UI preview](http://127.0.0.1:62901/) | Accounts, Google consent, account confirmation, policy editing/preview and status pages | Real current renderers and browser asset with fixture data. No live account, authenticated session, policy store or execution backend. |
| [System walkthrough](../../specs/2026-10-14-portable-tool-portal-hosts/index.html) | Why routing, identity, credentials and approvals need separate owners; proposed package changes | Proposed design, with unresolved choices labelled. |
| [Fleet Framework draft](../../specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md) | Shared vocabulary, owner decisions and product ownership | Parent overview and questions exist; shared Requirements and Specification still follow. |
| [Annotated UI captures](review.html#ui-evidence) | The two clearest current interaction/presentation problems | Browser observations of fixture pages, with original screenshots retained. |

The survey source is this design worktree at `8535fdd4`. Local `master` is `33914cbe` (Gondolin 0.13 qualification); the relevant config, Tool Portal, MCP, OAuth UI/broker, Gateway Runtime, OAuth controller and approval directories have no source delta between those revisions. This is local-source comparison, not a deployment/version claim.

## The selected UI direction

The first React iteration was rejected by the owner. This revision replaces its page composition with the official Base UI shadcn `base-mira` Sidebar, Card, Table, Sheet, Switch, RadioGroup, AlertDialog, Item, Badge, Tooltip and Sonner components, alongside the form controls. The footer slogan, decorative shields, repeated architecture descriptions and link-blue metadata are removed. Product text names a resource, choice, constraint or outcome; the architecture belongs in these documents.

The frontend uses React and the official Base UI shadcn `base-mira` controls. Bridge provides its dark palette, semantic tokens, system typography and compact density. The native app, RPC, viewer providers and global viewer clipping are not copied.

| Concern | Where it belongs |
| --- | --- |
| Control appearance, focus, disabled and invalid states | Official shadcn components over Base UI, themed through semantic tokens |
| Page layout, draft state and field feedback | React feature components |
| Class joining and Tailwind conflict resolution | Official [`cn`](https://github.com/shadcn-ui/cn) package |
| Design-system constraints | Official [`@shadcn/lint`](https://github.com/shadcn-ui/lint) plugin in Oxlint |
| Input validation | Shared input schemas in the review fixture; independent server validation remains required in production |
| Identity, membership, grants, credentials and approval decisions | Their protected backend owners; a browser component cannot authorize them |

**The earlier recommendation to retain Hono JSX is superseded.** Hono may remain an HTTP host; its JSX renderer is not the selected frontend. A product cutover will replace the rendered pages and small browser enhancement with the React frontend, while preserving the existing authenticated route, Origin, CSRF, revision and final-admission obligations. Program Design proposes a browser-only `@agent-vm/tool-control-ui` home; production command contracts and integration still need completion and review. This review prototype does not make that cutover.

The inspected fixture uses `React 19.3.1`, `@base-ui/react 1.9.0`, `shadcn 4.22.0`, `cn 0.5.0`, `@shadcn/lint 0.2.1`, `Oxlint 1.88.0` and `Tailwind 4.3.3`. At the research cutoff, npm listed `shadcn 4.22.1`; the resolver selected `4.22.0` under its release-age policy. A newly published PostCSS dependency failed that policy, so the fixture pins compatible `postcss 8.5.30`. The release-age protection stays enabled and dependency build scripts stay denied. These are fixture pins, not a product dependency update.

## What exists today

The managed path currently has these owners:

```text
Hermes / SDK client
  → Gateway Runtime composes Tool Portal
      → MCP provider backend
      → controller execution backend
      → Tool VM runner backend

Host controller
  → managed approval ledger and final admission
  → OAuth broker, protected credential use and runtime containment
  → VM/lease orchestration

Human browser
  → authenticated controller OAuth routes
      → server-rendered account/consent/policy pages
      → broker or policy editor owns the actual change
```

The browser does not own tool permissions or approval records. Its current script only updates the permission-selection summary. The controller routes enforce browser identity, request binding, CSRF, revisions and service readiness. The fixture preview substitutes the controller/backend side, so it demonstrates presentation and native form behaviour only.

| Existing package/home | Its current job | Inspect |
| --- | --- | --- |
| `config-contracts` | Complete agent profiles, tool/backend bindings, call policy and provider configuration schemas | [Tool Portal profiles](../../../packages/config-contracts/src/tool-portal-config.ts#L307) |
| `tool-portal` | Plan and dispatch a capability through one of three backend ports | [Dispatch](../../../packages/tool-portal/src/tool-portal-service.ts#L611) |
| `mcp-portal` | Upstream MCP runtime, MCP projection/listener and standalone admission | [Package surfaces](../../../packages/mcp-portal/package.json#L16) |
| `gateway-runtime` | Compose the managed Tool Portal, provider clients and private controller connection | [Production composition](../../../packages/gateway-runtime/src/production/gateway-runtime-production-service.ts#L541) |
| `agent-vm` | CLI, controller, managed approval ledger, runtime and execution ownership | [Controller composition](../../../packages/agent-vm/src/controller/controller-runtime.ts#L684) |
| `oauth-broker` | Account grants/catalog, provider policy and controlled credential use | [Runtime credential policy](../../../packages/oauth-broker/src/google/google-runtime-credential-policy.ts#L28) |
| `oauth-approval-ui` | Google consent, account connection/policy and waiting pages | [Public renderers](../../../packages/oauth-approval-ui/src/server/index.ts) |
| `secret-management` | Environment/1Password secret-reference and resolution boundary | [Contracts](../../../packages/secret-management/src/contracts.ts#L6) |
| SDK and control-contract packages | Wire shapes, client calls, artifacts and private control contracts | [SDK exports](../../../packages/agent-portal-sdk/src/index.ts), [control exports](../../../packages/gateway-control-contracts/src/index.ts#L57) |

The proposed shared `tool-access`, `credential-broker`, renamed `mcp-gateway`, `mcp-connectors`, `tool-host-node`, `tool-host-cloudflare` and `tool-control-ui` homes are **not implemented packages**. Their responsibilities are proposed in [Program Design](../../specs/2026-10-14-portable-tool-portal-hosts/program-design.md#the-packages-and-why-each-exists).

## Registration: the useful starting point

Today's authoring is spread across three concerns:

| Configuration | What the operator supplies |
| --- | --- |
| `system.json` | Zones, agent declarations and Tool VM resource-profile selection |
| `tool-portal.config.jsonc` | Agent-to-profile assignment, complete tool policy and explicit backend binding |
| `mcp.config.jsonc` | Downstream MCP provider connections |

The inspected schema uses `agents.<agentId>.profile` and `profiles.<profile>.namespaces`; each namespace names `mcp_provider`, `controller_execution` or `tool_vm_runner`. The [effective-config builder](../../../packages/agent-vm/src/gateway/mcp-portal-effective-config.ts#L401) projects the managed policy into provider inputs. Tool VM resource profiles are separately selected in [system configuration](../../../packages/agent-vm/src/config/system-config.ts#L766).

**What needs building:** an easy registration path that binds an agent/persona's selected tools to its workspace allowance and produces a complete effective assignment. The new prototype demonstrates the screen; current product schemas still have no workspace/persona registration field. The shared entity, membership and verified revision contracts remain prerequisites for production.

The [Fleet Framework owner decisions](../../specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md#owner-decisions-in-this-design-verbatim) now provide these constraints:

- F-23/F-24: register an agent in a harness; workspace availability bounds its agent/persona selections. Resource categories are separate from execution backend kinds. The owner has not identified the fourth category, so the prototype shows only the three named ones.
- F-27/F-29/F-35: managers are per workspace and may grant its agents use of connected **team accounts**. They cannot give a shared agent a person's personal account. This prospectively widens today's owner-and-allowed-agent admission for team accounts; it is not implemented by this UI. How an account is classified remains open.
- F-28/F-30/F-35: record security and permission changes; attribute actions to the agent, with requester attribution when known. “On behalf of” is a log label: the agent uses its own access, never the requester's accounts. Audit ownership/storage/retention and requester pass-through remain open.
- F-32: a multi-workspace bot discovers the union of tools, but each call names a workspace and must fit that workspace's allowance for the agent. Other memberships do not widen that call. This catches mistakes and attributes use; it does not isolate mutually distrusting workspaces from a bot that can deliberately select either. Credential/header/connection carriage and verification are still design work.

The prototype illustrates one workspace's administration. It does not implement union discovery, verified call context, per-workspace credentials, agent attestation or collaboration defaults.

Execution placement stays separate. F-10/F-11 permit a workspace-registered external bot to use MCP while running in a VM we do not control. Registration does not require hosting that agent's loop or turning its VM into an Agent VM-managed machine.

F-34 treats each host or VM as its own boundary; identity must not be inferred from physical hardware. F-36 narrows this framework work to Tool Portal, MCP gateway/portal and related access components. This survey is not a redesign of the entire VM controller.

## Three different permission experiences

| Experience | What the person decides | Current position |
| --- | --- | --- |
| Google consent | Which provider scopes an account grants | Existing browser pages and broker |
| Account tool policy | Whether permitted account operations are denied, ask each time or allowed | Existing account-policy editor |
| Exact action approval | Whether one particular protected operation may dispatch | Managed controller authority exists; generic Router/IDE presentation and distributed continuation remain design work |

The name `oauth-approval-ui` makes these easy to conflate. The current pages explicitly distinguish consent from per-call policy. Preserve that distinction when making presentation components reusable.

## Current Hono JSX baseline: findings to preserve in the React cutover

The current product implementation is server-rendered Hono JSX plus native forms and a **24-line browser entry**. These are baseline findings, not the selected frontend architecture. The new React fixture addresses account cancellation and field/error feedback; the full provider-consent and policy-editor migration is still unbuilt.

### UI1 — Cancel depends on an unrelated required field

**Browser reproduced.** On account confirmation, clearing the account name and pressing Cancel displays “Please fill out this field.” No POST reaches the fixture listener. With a nonempty name, Cancel produces one POST to the cancel endpoint.

The [required alias](../../../packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx#L350) and [Cancel submit button](../../../packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx#L367) share a form. Cancel has no validation bypass. The smallest repair is a cancellation control that submits without validating the alias, while retaining server-side identity, Origin and CSRF checks. Confirm must still require a valid name.

### UI2 — Off looks as though permissions are selected

**Browser observed; usability judgment.** The Workspace application is Off while Read Calendar is rendered as a blue checked choice. Its summary correctly excludes the application, and switching Off preserves Custom edits. That is intentional selection retention, but active access and retained draft choices look alike.

Show retained Custom selections as inactive until Custom is selected, or disclose that section only when relevant. Preserve edits when modes change. The [renderer](../../../packages/oauth-approval-ui/src/server/oauth-approval-renderer.tsx#L112) and [CSS](../../../packages/oauth-approval-ui/src/styles/oauth.css#L112) need one consistent presentation model; `.permission-options` defines a grid but is not used by the inspected JSX.

### UI3 — Policy preview has no draft-revision path

**Source-backed; full browser/server recovery unverified.** The rendered preview removes editable controls and offers Confirm, but no Edit choices action. The [editor](../../../packages/agent-vm/src/controller/oauth/google-account-policy-editor.ts#L271) has already rotated CSRF and moved to `preview`; resubmitting the old edit page cannot revise that context.

A usable revision path must preserve the draft and current authority checks. This needs an explicit editor transition and route, not a browser-only Back button. Existing identity/revision/maximum checks remain required.

### UI4 — Presentation and asset loading share a module

**Source observed.** The approval renderer is 593 lines and owns the filesystem asset loader, render validation, page selection, several page components and document shell. The policy renderer is 391 lines; document/head/stylesheet markup repeats in all three renderer files.

The selected separation is:

```text
React frontend
  shared shadcn components + Bridge theme
  workspace-tools / agent-registration
  account-consent / account-policy / account-status

Protected host routes
  browser authentication + request/CSRF binding
  parsed commands + revision checks
  calls into policy, credential and approval owners

Backend authorities
  identity and membership / tool policy / credentials / approvals / audit
```

These are responsibilities. Program Design proposes the browser package `@agent-vm/tool-control-ui`; this does not settle its public HTTP contracts. The React bundle can be static assets; Node-only file loading belongs with a host adapter. Portable permission and credential contracts must remain independent of the browser and of a particular host runtime. The separate portable-portal design still owns that split.

### UI5 — Existing tests miss the browser boundary

The inspected renderer tests check strings, escaping and native-control markup. Controller HTTP tests parse forms with [a regex helper](../../../packages/agent-vm/src/controller/oauth/oauth-access-http.integration.test.ts#L80) and submit requests directly. Those checks do not execute browser constraint validation, focus, CSS or change events.

Keep those tests. Add a small real-browser journey for Cancel, Off/Recommended/Custom, retained edits, disabled groups, error focus, preview revision and narrow layouts when implementing the cleanup. These new journeys have not been built here.

## Suggested review order

1. Open the React prototype: Workspace tools → Agents → Accounts → Audit log.
2. Inspect its desktop/narrow and error-state captures below.
3. Compare the current UI baseline to identify the consent/policy behaviours that the replacement must retain or repair.
4. Review workspace authority against F-23–F-32, then inspect package boundaries in the system walkthrough.

The next production design needs an explicit React cutover, verified workspace/agent commands, and the migration/proof plan for consent and policy editing. Avoid shipping a second Hono presentation path beside it. Account policy transitions, registration authority and durable audit remain backend work; fixture success does not settle them.

## Proof and limits

### Corrected React review prototype

| Check | Observed result | Limit |
| --- | --- | --- |
| `pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run typecheck` | Exit 0 | Scratch frontend and fixture types only. |
| `pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run lint` | Exit 0; 35 TS/TSX files, 102 active rules, zero diagnostics. The earlier wrong-Button control failed with three intended shadcn errors. | Generated components use the documented implementation overrides. Sonner's `toaster` is the sole named structural-class allowance. |
| `pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run format:check` | Exit 0; 39 matched files | Formatter proof only. |
| `pnpm --dir /private/tmp/2026-10-agent-vm-react-workspace run build` | Exit 0; JavaScript and Tailwind assets built | No product build or deployed host. |
| Retained source | 46 non-README files byte-identical to the active prototype | No dependencies or generated bundles copied into the checkout. |
| Advisor's seven-point UI bar | 7/7 from corrected captures and source; original placeholder finding withdrawn | Advice based on captures/source, not an independent browser run or full design acceptance. |

The current captures were refreshed after restoring Bridge's shared border/focus reset. The same theme supplies a visible active navigation token and quieter border token; no component-specific paint or override stylesheet was added. Table columns share the same widths across resource buckets. Tools and Accounts use one `AccountStatusBadge`; cancelled, pending and connected remain distinct.

**Actual browser observations:**

- Desktop and `430 × 900` phone: blank agent name shows `Enter a name.` and focuses the name input. The phone registration Sheet and footer fit the inspected viewport. Escape closes it. A separate actual `430 × 900` run registered Mobile helper with no resource tools, closed the Sheet, showed the success toast and retained that row after reload. Fixture readback confirmed its empty resource-tool subset; this proves same-process save/reload only. The phone Sidebar opens as the registry Sheet, with the active item visible, and closes with Escape. The viewport override was reset afterwards.
- Pending account: the Sheet labels Google’s grants; empty-name Confirm shows a field error. Cancel still opens an AlertDialog naming the account and consequence. Confirming cancellation closes the Sheet, shows `Cancelled` and emits the cancellation toast.
- Removing an assigned tool opens an AlertDialog naming the affected agents and tool. This final observation used Keep access and Discard, leaving the main fixture’s saved state unchanged.
- Hash navigation between Tools, Agents, Accounts and Audit updates the corresponding page. Mouse/CDP controls were unreliable in this browser session; accessibility expansion and keyboard Return/Space/Escape provided the observed interactions.
- Earlier runs of these React view components saved a workspace change, narrowed the affected agent, registered a named Hermes agent with no resource tools and read back the corresponding example events. The final corrections changed tokens, composition and labels, not backend authority.

The unchanged fixture backend's earlier negative controls rejected blank names, outside-workspace tools, stale revisions and unavailable writes with `400`, `403`, `409` and `503`, with no state change. The earlier failed-save observation retained the typed draft. Those observations are fixture evidence; they do not establish the protected production route.

**Unverified:** screen-reader/keyboard coverage beyond the named actions, held pending/loading states, the new full provider-consent/policy-editor frontend, protected identity/membership commands, real account grants, durable audit, approvals and deployed authorization. No automated product suite ran. Same-process readback and the fixture JSONL journal do not prove restart durability.

Advisor optional notes remain: align the account Sheet's Item inset with its title, explain non-connected account availability in a Tooltip, and use a neutral cancellation toast. They do not change the shared authority design.

The earlier React screenshots remain below as an explicitly rejected baseline. Their v1 visual claims are not current UI acceptance.

### Existing UI baseline

The fixture uses 22 byte-identical non-test source copies from the UI/contracts packages and the repository's exact Hono, Zod, esbuild, Tailwind and TSX pins. Its request log contains one positive-control cancel POST after zero requests for the invalid-field case. Permission summary changes from one group/one application to three groups/two applications, then back to one when Workspace is Off; the blocked write control remains disabled. The narrow consent page has no page-width overflow in the inspected viewport.

No product files, credentials, provider grants, controller state or VMs changed. No product test suite or deployed authorization path was run. The standalone preview replaces authenticated routes and all state/effect services; it is **presentation evidence, not approval or security integration proof**. The system walkthrough also retains its recorded active-tour/outline duplicate-control limitation.
