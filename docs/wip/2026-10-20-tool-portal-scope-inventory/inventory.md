# Tool Portal scope inventory (independent, 2026-10-20)

Evidence, not design. Written by the 🦉 Advisor (codex-local/01a13a63), read-only, at the owner's request after the scope correction on 2026-10-20. Stored here unchanged. The design documents decide; this records what the owner asked and what existed and was built.

# Independent inventory — 1 of 3: what was asked, and what exists

🦉 Advisor → 🦁 Lead and owner. Read-only, conducted personally, without helpers. Design snapshot: `ef141e87`. Existing implementation baseline: `8535fdd4`; the old portal/configuration paths inspected are unchanged at current `master`, `33914cbe`. New Node host checked at `51c98139`, after capacity removal. This is a source and history analysis, not implementation acceptance or a fresh runtime proof.

**My conclusion: the decomposition is real and useful, but the delivery became several jobs.** It combines moving existing behavior, building a distributed service, and building an access-management product. Their origins and readiness differ. The mistake was making them one required delivery, then treating our own requirements as permission to add work.

There is also a correction to the commission: **the record does contain owner requests for workspace scopes, React/shadcn, audit, chat-driven changes and people sign-in.** Calling them all “never asked for” would rewrite the history. They are not, however, automatically prerequisites for the present job. The owner subsequently said “two projects” and “core ... and ... split” first, and has now explicitly stopped the added hardening and reopened the design.

I contributed to the drift. At board post 9056 I correctly identified that the store did not meet our R14 text. I then recommended a bounded implementation/proof direction without first establishing that R14's new capacity work belonged in the owner's current scope. Saying “no extra gate” in that same post did not undo that recommendation. The right advisory conclusion was: “source differs from this agent-authored requirement; first decide whether the requirement belongs.”

## 1. The owner's asks, in time order

Dates below are UTC when the primary session provides a timestamp. The F ledger and exported trace sometimes give only an approximate date or a relayed quotation; I label those separately. A request to explore a possibility is not silently converted into a selected mechanism.

| Evidence | Owner's words | What it establishes |
| --- | --- | --- |
| O1 — Oct 14, 12:29Z | “i want to talk aobut tool portal and how it works in general, and mcp portal ... there are 2 lbiraries right?” | Start with understanding the current two libraries. [Primary session](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:9). |
| O2 — Oct 14, 13:11Z | “I wanted the gateway runtime to be usable by anything”; “is the approval system in which package or crate? Is it in a common crate or package?” | Reuse and ownership of approval/security logic, independent of a particular harness. [Primary session](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:185). |
| O3 — same message | “we have have optional wayp of doing mcp serach. eitehr built in or takeing hte lcietns abiltiy to ahve code mode and serach toosl into accoutn. so on conenciton we can choose how to expeose all down stream services.” | Positive code-mode/search ask: choose how downstream tools are exposed, considering the client's own abilities. This does not select where new submitted code runs. [Primary session](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:185). |
| O4 — same message | “im nto that isntrested in stdio skuport, but sockets”; “separating the logical session from the physical WebSocket connection” | Network-facing use and resilient interaction across connections. The stable session requirement is explicit; an all-call durable operation database is our stronger proposed realization. [Primary session](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:185). |
| O5 — Oct 14, 19:37–19:39Z | “diffrent tyles of toolvm execution environment not just gondolin. later codex exec server”; “i ... went a bit execcive on the exection cli stuff” | Execution is replaceable; downstream MCPs and controlled CLI execution are both relevant. Neither “new VM provider” nor “CLI-only everything” follows. [Execution](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:1265), [CLI/MCP discussion](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:1292). |
| O6 — Oct 14, 20:27–21:11Z | “i want a central mcp portal endpoint for all agents”; “agent-coordnation doesnt ahv eto be parrt”; “my clodu mcp server can be in cloduflare worker?” | Central cloud access, local/computer services and cloud hosting are wanted; coordination is separate. Worker hosting began as a question and developed into the portable-host design. [Central entry](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:1972), [local/cloud fleet](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:2036), [Worker/library](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:2664). |
| O7 — Oct 16, 23:44–23:49Z | “Generic MCP gateway; Hermes is one possible client”; old portals “combined together” on one machine; cloud gateway connects remote MCPs and a computer MCP | Two-level, compositional architecture, not the managed Hermes Gateway renamed. Separate coordination service. [Gateway meaning](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:7436), [two levels](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:7499), [coordination](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:7541). |
| O8 — Oct 17, 17:53Z | approval can go to “Hermes ... or ... elsewhere”; “Make it like a webhook or something like that” appears again in O10 | Generalized approval presentation/integration. A webhook is a proposed delivery shape, not permission for the receiver to authorize itself. [Authentication and approvals question](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:10653). |
| O9 — Oct 17, 19:30–19:56Z | security/credentials/approval need sharing independently; “Our @agent-vm/mcp-portal package”; “we need agent/machien identity shoe how” | Separate reusable components; the disliked name/package is ours, not automatically Cloudflare's managed product. Identity is a real design ask. [Sharing/name](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:11263), [clarification](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:11334), [identity](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:11735). |
| O10 — Oct 18, 10:48Z | “I don't want to pay beyond what I need”; “It's not that I want you to design all the other features; we're focusing on this one. Other services—I mean, I want you to design it with that in mind.” | Consider distributed Router/fleet identity and Router/IDE approvals, with narrow contracts and cost restraint. It does not authorize designing those other products here. [Primary session](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:12236). |
| O11 — Oct 19, 00:48–00:58Z | “we shoudl ahve built it with react. and standard desgin system”; “we will do scopes per workspace”; “react/base ui/ ... shadn cn” | Workspace scopes and the UI stack were actually requested. [Workspace/UI](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:16224), [tooling](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:16402). |
| O12 — Oct 19, 10:25–11:02Z | launch with mock data; “yes its two problems”; “in essense this is 2 projects ... implement and experiment ... but w eene dto make progres in agent-vm” | Product-organization/UI experiments and core agent-vm progress are distinct tracks. Mock testing does not accept a production control service. [Mock](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:18707), [two problems](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:18888), [two projects](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:19127). |
| O13 — recorded Oct 18–19, F-27/28/32/35 | “and ahve some event log trace always for all security and perm cahgnes for audit”; “it sees union of tool aqnd we can add workspace id? … it snot seckurity but attriution” | Audit and multi-workspace attribution are genuine owner outcomes. Team-account delegation is a new choice; personal accounts and acting with requester credentials remain restricted. [Recorded quotations](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:70). |
| O14 — recorded Oct 19, F-41–49 | “edit should be through chat not through some screen”; “only gerative ui to acept deny”; “we need with mock ... generative ui option”; “c is fine if the ui is sperate package ... reuse” | A requested UI/product track, with a mock experiment, replaceable model and a reusable UI package. The exact generalized proposal protocol is a design realization. [Recorded quotations](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:84). |
| O15 — recorded Oct 19, F-50–54 | “build this again as new packages from current and proted ... inventory”; “the split for tool-portal that agent-vm uses needs to be extracted”; “exeukciton is an interface or ineject”; “seperate runtime from core logic”; “for now we use configs” | Best explicit meaning of decompose/recompose: inventory current behavior, port it to new packages, keep execution outside, inject it, and use configuration until fleet contracts exist. Daemon explicitly out of scope. [Recorded quotations](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:93). |
| O16 — recorded Oct 19, F-56/57/60 | “lets gvmoe to the core fucktionalyt and desing and slpit”; “most likeky a service that talks to both tool portal and fleet will own the ui”; “copy form old leave old untoched” | Core/split first. UI location provisional. Old packages left untouched until cutover. [Priority](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:99), [copying](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:103). |
| O17 — Oct 20, 01:09Z; F-64–68 | “we can use this as login system”; “cloduflare works for vm vpn access ... not admin/members login”; “we have signin that needs planning”; “only ... google, github, passkey” | People sign-in was requested separately from machine/network access. F-64 records Workers/D1 as adopted; its displayed owner quotation still asks about the backend, so that quote alone does not prove the whole deployment choice. No sign-in production implementation is established. [Primary](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:20903), [machine distinction](/Users/shravansunder/.codex/sessions/2026/10/14/rollout-2026-10-14T08-28-53-01a13a63-0fbf-7f31-9e98-f0fec712b1c1.jsonl:20914), [recorded design direction](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:107). |
| O18 — Oct 20, latest correction, relayed by Lead | “we want to enable code mode not this”; “I don't want unrequired random stuff in the MCP”; “decompose and rethink composition and system ground up not add more features” | Current scope correction. Remove 9b, cancel S3c, stop adding implementation, independently inventory before rewriting the design. [Exported trace](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:630), [design correction](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:648), plus the current user commission. |

Temporary grants/revocation are a separate example: the owner said they **liked the idea**, and F-61 correctly records interest rather than a selected implementation. Do not add it to the extraction. [F-61](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:104).

### What “ground up” means on this evidence

It means re-examine responsibilities from existing code and intended consumers: rules, MCP-facing gateway, outbound connections, privileged credential use, execution backends and platform hosting. Rebuild their composition so any harness can use the system and Node/desktop/Gondolin details do not leak into portable imports.

It does **not** mean erase existing safeguards. Nor does it mean invent every capability a future fleet product might need. The evidence supports both a distributed destination and a narrower current extraction; they must have separate delivery boundaries.

### What “code mode” means on this evidence

There are at least three different things, which the design blurred:

1. **Client-native tool search/code:** the harness already searches or runs code; our server exposes usable tools through MCP.
2. **Generated TypeScript helpers:** our catalog compiler emits typed functions; code running in the client's execution environment calls them, and each function calls MCP.
3. **A portal-hosted submitted-code executor:** a new tool accepts code and runs it on the portal side.

O3 clearly requests accommodating the first, and today's code already supplies substantial parts of the second. It does not choose the third. Conversely, our R8 prohibition on a second runtime is our design restriction, not a complete positive design for “enable code mode.”

## 2. Existing system, from the ground up

There are two overlapping server/library compositions, not two names for the same package:

```text
MCP client
  |
  +-- standalone MCP proxy / Tool Portal host
  |     authenticates caller, selects configured policy
  |     -> discovery / search / describe / call
  |     -> permitted upstream MCP
  |
  +-- managed Gateway projection
        trusted managed caller and current generation
        -> cross-backend Tool Portal policy
        -> controller approval authority when required
        -> injected MCP / controller-execution / Tool-VM backend
```

The second path is composed by agent-vm; it is not required for every use of the first.

| Existing part | Its actual job | Coupling that matters |
| --- | --- | --- |
| `@agent-vm/mcp-portal` | Upstream MCP discovery and connections; catalog/session filtering; list/search/describe/call handlers; compact or full MCP presentation; standalone hosting/CLI/auth; catalog TypeScript generation. | Portable decisions, Node transports, configuration loading, secrets, cryptography and compiler code share a package/export graph. A standalone proxy already exists. |
| `@agent-vm/tool-portal` | Policy and dispatch over three configured backend kinds: MCP provider, controller execution and Tool VM runner; CLI/Google constraints; approval admission; managed and standalone projections. | Its backend and approval interfaces carry `GatewayRuntime…` types, so even an injected backend is described in managed terms. It also exports Node standalone auth/hosting. |
| Tool parts of `config-contracts` | Shared upstream configuration; selectors, complete profiles, approval rules; managed and standalone policy schemas; configured CLI/Google contracts; JSON-file loaders. | Pure rules/schema and Node filesystem/configuration loading are mixed. Some schemas also include concrete execution bindings. Split by responsibility, not by deleting the whole package. |
| `gateway-runtime` + agent-vm | Instantiates the managed core, supplies backend factories and controller-owned approval/OAuth ports, manages artifact authority, prepared catalogs, private sockets and epoch retirement. | This is the managed integration and authority boundary that extraction must preserve; it belongs outside the portable engine. |
| `oauth-broker` / `secret-management` / controller account service | Credential custody/resolution, consent and concrete account-use authority. | Extracting a contract does not move raw credentials, transfer consent ownership, or require a new credential database. |
| `agent-portal-sdk` | Client protocol/result/artifact contracts, MCP client and generated-tool runtime. | The client is not the portal host or the agent harness. Generated functions take an already supplied client. |

Decisive sources: [old Tool Portal backend and approval ports](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/tool-portal/src/tool-portal-service.ts:104), [MCP core composition](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/mcp-portal/src/core/portal-core.ts:782), [mixed configuration exports](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/config-contracts/src/index.ts:1), [Node loader](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/config-contracts/src/json-config-file.ts:1), [actual managed composition](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/gateway-runtime/src/managed-tool-portal-composition.ts:107).

**The “must have full desktop/Gondolin” assumption is too broad.** The old package has Node and managed-type coupling, but its package manifest has no direct desktop/Gondolin dependency, and standalone MCP hosting already exists. The actual extraction problem is dependency direction and runtime effects, not absence of a standalone server. [Manifest](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/tool-portal/package.json:56).

### Authorization and approval are already spread across owners

- Pure allow/ask/block decisions exist in `config-contracts`, Tool Portal selectors/CLI rules and MCP filtering.
- Managed Tool Portal asks the injected controller port to reserve and arm an exact intent. The controller retains its approval ledger and final authority; Hermes is a presentation/integration consumer.
- The old standalone Tool Portal has a separate HMAC batch coordinator, with process-local reservation/arm tombstones and a service-generation binding.
- The old MCP proxy exposes another HMAC approval path; its verifier's default replay bookkeeping is not a generic durable effect ledger.
- Provider/account consent is another authority. A tool approval does not create account consent.

Sources: [pure MCP rule](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/config-contracts/src/mcp-portal-approval-policy.ts:1), [managed port](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/tool-portal/src/tool-portal-service.ts:182), [managed approval use](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/tool-portal/src/tool-portal-service.ts:791), [standalone HMAC contract](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.ts:31), [source comparison of both old standalone protocols](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/program-design.md:673).

Therefore the answer to “which package owns all authorization?” is **no single package today**. Shared rules can be portable; the authority that owns a grant, record or credential remains explicit. A new UI or webhook receiver is not that authority by virtue of displaying a request.

### Existing code mode: the exact through-line

```text
authorized upstream catalog
  -> schema-derived TypeScript modules, built on Node
  -> bind generated functions to a supplied MCP client
  -> agent's code calls a generated function
  -> SDK sends an MCP call
  -> server policy / approval / backend
```

Two different generated outputs exist:

- `describe(...includeTypescriptHelper)` in the old MCP handler produces a catalog/input-validation helper through `generateTypescriptCatalogArtifact`. Do not describe that lightweight artifact as the whole callable SDK.
- `compileCatalogTypescriptModules` builds namespace modules with typed input declarations and `bind…Tools(client)` factories. Those factories use the SDK's `createGeneratedToolFunction`.
- The SDK validates input where supported and calls the supplied client's `call`, generating a fresh call-item ID for each invocation. It does not own the client connection or execute arbitrary code.
- Managed runtime also has a prepared-source/cache/artifact path. Neither that source nor copying the compiler proves every named harness can load/use it.
- Full/compact exposure exists. Today it is explicitly configured; the inspected implementation does not establish automatic negotiation based on a client's native code/search capabilities.

Sources: [old describe helper](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/mcp-portal/src/core/portal-tools.ts:596), [lightweight artifact](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/mcp-portal/src/portal-config/typescript-artifact.ts:1), [callable-module compiler](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/mcp-portal/src/catalog-typescript/catalog-typescript-compiler.ts:297), [SDK function runtime](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/agent-portal-sdk/src/generated-tools/generated-tool-runtime.ts:109), [prepared managed source](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/gateway-runtime/src/catalog/prepared-catalog-source-cache.ts:1), [full/compact server](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/mcp-portal/src/mcp-proxy/portal-mcp-server.ts:190).

Re-invoking a generated helper creates a fresh item; it is a new action, not automatic recovery of a previous uncertain action. Any recovery design must account for that client behavior.

The missing positive outcome is a named, real agent journey: **which client discovers what, where its code runs, how it obtains/binds the helpers, and a successful permitted tool call through the selected server**. Generating TypeScript, loading on a Worker, and exposing a search tool are three different claims. The present design's U7/R8/J1 treatment does not close that journey.


# Independent inventory — 2 of 3: every requirement and significant obligation

This part uses three classifications, as requested:

- **A — decomposition/recomposition:** existing behavior, relocated or adapted without adding a user-visible guarantee.
- **B — new architecture:** a new host, remote trust relationship, service boundary or integration.
- **C — new feature:** a new observable capability, guarantee or management product.

A row can contain more than one. “Requested historically,” “selected mechanism,” “current delivery scope” and “implemented” are separate facts. **B and C do not mean inherently unwanted. A does not mean automatically safe.**

Owner evidence keys O1–O18 refer to the dated quotations and primary links in part 1. F references are recorded owner decisions, with their original words in the [F ledger](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-18-fleet-framework/2026-10-18-fleet-framework.md:44). These are not independent evidence that every inferred mechanism or priority was approved.

## 3. U1–U22, item by item

Source: [the complete current U table](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/requirements.md:29).

| Need | Classification | Origin and scope judgment |
| --- | --- | --- |
| U1 portable Node/Worker hosting | **A + B** | Runtime separation is O15/F-52; a real Worker host/parity is new architecture from O6. Keeping portable imports is core extraction. Hosted parity is a separate delivery from moving files. |
| U2 any harness through MCP | **A + B** | Existing MCP server/SDK plus O2/O7. New client adapters/integration proof are B. Naming Hermes/Codex/etc is not evidence each already works. |
| U3 isolation, complete profiles, revocation, exact approvals | **A + B** | Existing policy/managed safeguards are A. O2/O8/O9 request reuse/security; extending exact semantics across remote authorities is B. No blanket authorization for every additional hardening category follows. |
| U4 compose local and remote services | **A + B** | Remote MCP providers already exist; cloud/computer federation is O5–O7. Retain connector composition; distinguish it from new delegation/recovery contracts. |
| U5 keep credentials outside agents | **A + B** | Existing broker/secret/account boundaries; explicit O5/O9. New remote credential-use adapters are B. A new secret-entry UI/store is not necessary for preserving custody. |
| U6 resilient sessions/operation recovery | **A + B + C** | O4 expressly asks connection-independent sessions; existing managed approval history is A. New remote recovery is B. Durable records and idempotency for **every public call**, including unapproved reads, are a stronger C realization, not a quoted owner requirement at that granularity. |
| U7 full/compact and code mode | **A; possibly B/C** | Existing full/compact/compiler/helpers are A. O3 asks adapting exposure to client search/code ability. Automatic selection or a submitted-code executor would be new. “No second runtime” is our restriction, not the owner's complete answer. Keep and rewrite as a positive journey. |
| U8 replaceable execution | **A + B** | Existing injected backend port and neutral VM composition are A. O5/O15 explicitly require Gondolin independence and injection. New executor implementations are B and must be individually scoped. |
| U9 preserve managed controls | **A** | Repository invariants and existing behavior. F-59 permits temporary breakage during rebuilding, not loss of final safeguards. This remains a cutover obligation. |
| U10 cloud gateway and computer services | **B**, using A pieces | O6/O7 explicitly describe this destination. It is not an invented goal; actual two-hop deployment is more than extraction. Caller-group routing need not mean four public URLs. |
| U11 collaboration separate | **A/B boundary** | Explicit O6/O7. Keep separation and narrow shared contracts; don't implement collaboration here. |
| U12 independently reusable security | **A + B** | O2/O9/O15. Pure reusable rules and host effects separated: core extraction. A new identity issuer/approval service is not implied merely by exporting contracts. |
| U13 distinct agent/machine/service identity | **B**, with C lifecycle mechanisms | Explicit O9/O10. F-53 selects configuration for now. Designing/operating a fleet-wide issuer, enrollment and propagation is additional work, not completed by identity-shaped fields. |
| U14 presenter-neutral approvals | **A + B** | Explicit O8/O10. Extract contracts/adapt existing authority; remote delivery and authenticated return are B. A webhook notification alone is not consumption/decision. |
| U15 Router/fleet integration, standards, cost | **B + constraint** | O10 expressly says use other projects **with this in mind**, not design all of them. Preserve integration boundaries; no new central fleet product in this delivery. |
| U16 workspaces, personas, union discovery, managers/team grants | **C + B** | O11 and F-10–12/23/24/27/29/32/35. Genuine later feature asks. F-27 explicitly changes today's account-owner-only model. Their complete product implementation is not necessary to relocate today's rules. |
| U17 React/Base UI/shadcn | **C** | Explicit O11/O14 and UI rejection. Accepted stack, not accepted layout. Later F-56 puts core/split first; F-57 makes the console home provisional. |
| U18 security-change audit | **C**, reusing existing logs | Explicit F-28 (“event log ... all security and perm ... audit”), F-30/35 attribution. General authoritative audit/event persistence and transaction coupling are new realizations. Not fabricated, but a separate product/service obligation. |
| U19 unified access view/search | **C** | O12/F-42 (“... like a filter ... associated”). A real comprehension need. The comprehensive assessment projection and complete “first unmet” schema are our design choices to satisfy it. |
| U20 generated changes + Accept/Deny | **C** | F-41/43/45/46/48; mock experimentation explicitly requested. A generic durable proposal/application protocol is our production design, not an existing feature being moved. |
| U21 integration needs, secret entry, OAuth/options | **A + C** | Existing OAuth/editor/consent behavior is A; F-47 explicitly asks the UI capabilities. Generic write-only secret setup and routing every option through proposals are C. Secret writer was still unselected. |
| U22 approval configuration/pending UI | **A + C/B** | Existing modes and presenters are A; F-47 requests configuration UI. A new pending-approval place and its placement remain D7, explicitly the Lead's reading rather than a confirmed selection. |

**The consequential unsupported promotion is Requirements line 31:** “All rows are authorized, required outcomes ... no relative delivery order selected.” That compresses historical asks, experiments, provisional placements and current delivery into one authority level. It also misses O12/F-56's explicit split/priority. The inventory should preserve those histories, while the current plan names only the subset being delivered. [Exact line](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/requirements.md:31).

## 4. R1–R35, with origin of the added obligations

Source: [all normative R rows](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md:145). “Design inference” below identifies a realization not independently authorized by the normative text itself.

| Rule | Classification | Existing/requested basis versus addition |
| --- | --- | --- |
| R1 Node/Worker equivalence | **A + B** | F-52/O6 request portability. Unsupported-host refusal/parity are design choices that make that architecture honest. Real Worker hosting is new. |
| R2 authenticate current caller/assignment | **A + B** | Existing bearer/managed admission; O9/O10 identity. Universal remote audience/issuance/status treatment extends it. Configuration is F-53's current source. |
| R3 policy on all surfaces | **A + B/C** | Existing list/search/describe/call filtering is A. Applying it to new operation lookup and nested federation depends on new contracts. |
| R4 registered bindings and secret custody | **A + B** | Existing controlled backends/broker; O5/O9. Remote binding/credential adapters extend the architecture; arbitrary caller-chosen endpoints remain outside existing behavior. |
| R5 one consumption across handlers/restart | **A + B/C** | Existing controller ledger gives a managed baseline. Restart-safe public approval/operation consumption is a new guarantee over old process-local standalone behavior; motivated by O4/O8, realized by the design. |
| R6 separately authenticated approver | **A + B** | Existing managed protected decision path; O8/O10 generalize surfaces. It does not choose a new login service or approval authority automatically. |
| R7 stable records for every public call | **B + C** | O4 motivates resilience, but this universal operation contract is a design inference. The explicit managed-unapproved-call exception correctly admits today's limitation. Not merely renamed managed behavior. |
| R8 mode parity/no second code runtime | **A + design constraint** | Mode parity preserves existing presentations. The negative code-runtime rule is inferred from O3's client-native option; it is not a positive implementation of the current code-mode ask. |
| R9 public lookup independent of session | **B + C** | New API/contract realizing O4. A session's stable name alone does not force this particular all-call record model. |
| R10 remote transport guards/routing safety | **A + B** | Existing local HTTP restrictions plus remote destination O6/O7. New remote confidential transport/host binding is B; this is not general permission for unrelated networking work. |
| R11 preserve managed/admin/custody boundaries | **A** | Repository invariants and U9. Keep during recomposition. F-59 changes intermediate sequencing only. |
| R12 TS/Python/versioned client recovery | **A + B/C** | Existing SDK/result/artifact contracts are A. New operation identity/version/recovery adoption in both SDKs is additional. “Any MCP client” does not independently require a new SDK feature in both languages now. |
| R13 explicit config/stores/bounds | **A + B/C** | Complete profiles/trusted configuration already exist; F-53. New public stores and mandatory bound fields are design additions tied to the expanded architecture/R14. |
| R14 finite every resource category/capacity | **A + C** | Preserve copied request/result bounds, store-error refusal and redaction. Universal state/artifact/concurrency capacity admission is added hardening; no specific owner ask found for 9b/S3c. O18 explicitly withdraws it now. |
| R15 qualified cloud/computer routing | **A + B** | Existing names/providers plus O7/O9 group routing. New two-tier binding checks are architectural. Endpoint count never supplies the missing caller identity. |
| R16 delegated original caller + durable inner key | **B + C** | O7/O9 require safe remote use. Exact outer/inner persistence, original item propagation and lost-reference recovery are our distributed protocol design. Not present merely because an MCP connector exists. |
| R17 independent collaboration authority | **A/B constraint** | Explicit O6/O7/O10. No collaboration implementation is authorized here. |
| R18 independent rules/credential/approval imports | **A**; owner boundary constraint | O2/O9/F-50–52. One record writer preserves ownership; doesn't require new services or stores. |
| R19 enrollment and identity relationships | **B + C** | O9/O10 ask identity. Enrollment/issuance lifecycle is a new mechanism; D2 unresolved, configuration selected provisionally by F-53. |
| R20 issuance revocation/freshness everywhere | **B + C** | Builds on existing generation/credential checks and identity ask. Global freshness guarantees, required source-machine proof and independent issuance lifecycle are design elaborations awaiting owner contracts. |
| R21 webhook/events versus decisions | **A + B** | Explicit presenter reuse O8/O10. Neutral event contract and remote authenticated return are new; retry/delivery state is not a tool grant. |
| R22 Router/IDE verified adapters | **B** | O10 explicitly wants integrations without coupling. Which external service is an authority versus presenter is still a decision, not established by Router session labels. |
| R23 per-workspace calls/union catalog | **C + B** | Explicit F-32/O11; new to this tool system. Stable operation conflict behavior extends R7, not the quotation alone. |
| R24 manager grants/team classification/Accept | **C** | F-27/29/35/43. New team-account and manager authority, plus our typed Accept protocol. Personal consent remains an existing boundary. |
| R25 UI stack/states/server enforcement | **C + A preservation** | Stack and validation explicitly requested O11. New screens/proposal states are product design; existing editor enforcement must survive any later rewrite. |
| R26 authoritative atomic audit/change | **C + B** | F-28 asks every security change logged. “Do not admit a change if audit cannot commit” and cross-owner atomic recovery are stronger design choices; D6 unselected. This made new writes depend on another system. |
| R27 registration through accepted proposal | **C + B** | Workspace agent registration is requested F-23/24; F-41/43 motivate Accept. Forcing registration through the generalized proposal service is a design choice, not a prerequisite for porting configured principals. |
| R28 comprehensive access explanation equals admission | **C + A reuse** | F-42/U19 motivate it. New E21/`assessAccess` projection/order came from design/Advisor work (board 8752, 8785–8790). It reuses evaluators but is not itself a copied existing API. |
| R29 exactly four places/search | **C; partly unsettled** | F-42 allows audit and “accounts maybe”; exactly Access/Connections/Audit/optional Approvals is the design's interpretation, explicitly admitted in the rule. D7 still open. |
| R30 model request → exact proposal/impact | **C** | F-41/43/46/55 request the interaction. Closed function registry, system-computed impact and detailed proposal results are design realizations. No required model SDK belongs in the portable core. |
| R31 authenticated Accept bound to revision | **C + B** | F-43 wants Accept/Deny. Exact-revision decision and separation from per-call approval are our necessary contract if that product is built, not existing tool-call behavior. |
| R32 durable apply-once proposal recovery | **C + B** | Production realization of U20 plus resilience. New transactional application store, partial states and audit coupling; not decomposition. |
| R33 model privacy/failure semantics | **C constraint** | Applies to the requested model UI experiment/product. Console owns the model under provisional F-57. It is not a core MCP delivery prerequisite. |
| R34 credential setup/OAuth via proposals | **A + C** | Preserve broker/editor/containment and provider consent. Secret-entry API and mandatory proposal-driven option changes are new F-47/F-41 product work; writer still unspecified. |
| R35 approval modes via proposal/new approvals place | **A + C/B** | Existing approval modes and authority remain. New proposal configuration and pending-approval UI are separate product/integration work; D7 not confirmed. |

### Other significant obligations, beyond the R table

The entity names, worked contracts and proof chapters also add scope. A rule hidden in a data definition or verification journey is still a requirement if it forces code.

| Artifact | What is existing versus new |
| --- | --- |
| E1–E5, E8, E14 | Re-express existing authorities/callers/capabilities/profiles/providers/credentials/assignments (**A**), extended to remote identity and workspace facts (**B/C**). E5's integration-needs display is later UI scope. |
| E6–E7 | Existing managed operation/approval concepts (**A**) become a new universal public operation identity/lifecycle and approval contract (**B/C**). Public and managed histories are not one migrated record family. |
| E9 | Correlation versus authentication reflects O4 and existing session ownership (**A/B boundary**). It does not require building an agent conversation database. |
| E10–E13, E15 | New explicit delegation, service/machine/issuance and approval-delivery model (**B**), with lifecycle capabilities (**C**). Directly motivated by O7–O10, mechanisms still design choices. |
| E16–E20 | Workspace, registration, team grants, security-change events and persona references (**C/B**), from the F decisions. Persona/registry lifecycle stays with fleet; no second membership truth belongs here. |
| E21–E23 | Complete access assessment, generalized change proposal and change decision (**C**), built to support the later management UI. The design itself says no existing file implements `assessAccess` or the control API. |
| C1–C5 | Mix existing MCP/result/approval/custody behavior with new all-call history, public versioning, finite-capacity and legacy retirement (**A/B/C**). “Contract example” does not make those additions owner-approved. |
| C6–C9 | New two-hop delegation, independent collaboration, identity and surface-neutral approval integration (**B**). Keep as separately scoped distributed architecture, not a hidden extraction prerequisite. |
| C10–C12 | Workspace calls, management screens and generalized chat/proposal/application product (**C/B**). Owner-requested destination at various times; not the current split/code-mode deliverable by default. |
| Program Design legacy retirement | Keeping one managed ledger/custody owner is **A**. Retiring both standalone HMAC protocols, removing exporters and requiring new public receipts is a deliberate trust/contract change (**B/C**), not just package deletion. |
| J1–J10 | Necessary proof **if** the corresponding core/distributed contracts are retained. J3 combines durable approval and new capacity; J6 requires real two-hop effects; J10 requires real cutover/accounting. Scope must be decided before these become mandatory work. |
| J11–J18 | Proof for workspace, audited writes, access views, proposal processing, model boundary, credential setup and UI (**C/B**). They prove that separate product; they do not establish code mode. |

Sources: [entities](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md:43), [contracts](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md:185), [explicitly new functions](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/program-design.md:96), [legacy trust cutover](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/program-design.md:658), [journeys](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-14-portable-tool-portal-hosts/verification-design.md:178).

The Program Design's proof labels `S1…S24` are **not** the implementation plan's slices `S1…S6`. Reusing the same notation for different things makes the human walkthrough harder. In this report, “slice S1” means the implementation plan.

### How these additions entered the record

- Main root **8177** started as shared security, generic gateway/connectors, runtime/resource hosts and caller-scoped groups; it explicitly said design, not accepted implementation. It did not start as the full management product. Root (main-thread message `01a14e9e-ba87-7605-bc7b-7e6eff6ec101`).
- Board **8752** expressly adds U21/U22 from F-47 and adopts the generalized proposal lifecycle and access-path breakdown. This is an identifiable production-design expansion, not merely source extraction. Post (main-thread message `01a153dc-212d-7ddd-9665-8e7320f263ba`).
- Board **8785**, despite acknowledging F-56's core/split refocus, retains the control API and expands `assessAccess`; **8790** carries workspace branches into milestone 1. The UI rendering was deferred, but its domain/contracts were still inserted beneath core dispatch. 8785 (main-thread message `01a153fd-0000-7000-8000-2febb4490001`), 8790 (main-thread message `01a15406-0000-7000-8000-2febb4490003`).
- The trace records a design “decision-needed,” while still declaring five packages, neutral dispatch, `assessAccess` and the control API with proposals **ungated**. That is where future product design was admitted as current executable scope. [Trace](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:416).
- **8897** correctly leaves `tool-access-ui` out of the build, but explicitly keeps proposal/control work in S5. That is a partial separation, not completion of the owner's “two projects” boundary. Post (main-thread message `01a15729-6fc4-7f4f-816c-ba61ea856c2a`).
- **9056 → 9060** converts an R14/source mismatch into 9b and S3c. The owner's latest intervention reverses it. Advisor source check (main-thread message `01a158c7-aa1c-78bf-aea1-9901ae8e5bdb`), Lead expansion (main-thread message `01a158cc-5031-70f2-abfc-98a1de5a0033`), [withdrawal](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:630).

These board posts are agent-authored dispositions, not substitutes for the owner's quotations. They establish where we promoted or elaborated the asks, not independent permission for that promotion.


# Independent inventory — 3 of 3: built code, drift, and the scope to keep

## 5. Plan slices versus what is actually built

These are source snapshots, not fresh green/accepted delivery claims:

| Slice | Snapshot and actual work | Classification and origin |
| --- | --- | --- |
| S1 | `3031ad24`: new `tool-access`; copied policy/schema helpers **plus** new `assessAccess`, workspace/account/revision facts and explanation states. | **A + B/C**, not pure extraction. F-50–52 authorize the split; U19/F-42 motivated the extra explanation model. |
| S2 | `c03aa031`: new `tool-engine/dispatch` and new managed adapter/projections in `gateway-runtime`. Production composition still uses the old core. | **A/B** neutral interfaces and managed recomposition; **C/B** generic operation/approval/result contract and mandatory assessment path. Adaptation was needed; this exact combined protocol was our realization. |
| S3a | `377ae627`: portable MCP gateway/catalog/session/search and HTTP connector modules; WebCrypto argument digest; prepared catalog/compiler interface. | Predominantly **A/B** extraction. It also routes discovery/calls through new assessment/dispatch/operation contracts, inheriting their additions. |
| S3b | Baseline `4927917b`, corrections `1ea3c33c`, current `51c98139`: new Node host, HTTP/stdio binding, configuration, bearer mapping, compiler, injected secrets, durable public operation store. 9b removed. | **A/B** runtime separation; **B/C** new public operation storage, lookup and native-call metadata requirement. Removal of capacity work does not make the rest a behavior-preserving copy. |
| 9b / S3c | 9b removed in `51c98139`; S3c cancelled. The trace records an unpushed parked S3c WIP commit `66425d0d` and unused expanded engine grant. | **C hardening**, originated from agent-authored R14 and 9056/9060, explicitly withdrawn. Do not restart from an old wake or “MUST” line. |
| S4 | Planned cutover/deletion; source-only pre-build challenge exists. No production cutover is established. Current plan splits S4a/S4b. | Consumer moves/schema/compiler ownership are **A**. Legacy approval trust retirement/new receipt adoption is **B/C**, not implied by moving packages. |
| S5 | Planned explain/propose/decide/read, workspace configuration, manager verification, proposal store/account-editor binding; test issuer and audit stand-ins. No built production control API established in these slices. | **C/B product**, from U16/U18–22. Later owner asks exist; present extraction does not need to deliver it. |
| S6 | Planned Worker binding, Access verifier, Durable Object operation/proposal stores and hosted proof. No built/deployed Worker host established in these snapshots. | Worker runtime/remote host **B**, explicitly wanted. Proposal stores and UI/control proofs inside it are inherited **C** scope and removable independently. |
| People sign-in | Separate four-document design; F-64–68. `@agent-collaboration/auth`; no production implementation established here. | **C/B**, genuinely requested later. It is not an agent identity issuer and is not required for importing pure tool rules or using configured agent credentials. |
| UI / generative mock | React/shadcn prototypes and localhost/model experiments exist; the plan explicitly excludes `tool-access-ui` from this build. Existing Hono/OAuth server consumers still remain. | **C experiment/product**, directly requested. Stack requested; visual design not accepted; synthetic model evaluation is not a production access-management system. |

Sources: [S1 plan](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:97), [S2](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:203), [S3](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:296), [withdrawn capacity](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:427), [S4](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:464), [S5](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:503), [S6](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:541), [sign-in design](/Users/shravansunder/code/projects/agent-vm.docs-tool-portal-design/docs/specs/2026-10-20-people-sign-in/requirements.md:31), [current correction trace](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:630).

I directly checked the S3b worktree at `51c9813938a9f6e5a9bf4494696c5c847aa58f92`; it was clean. Its revert commit removes the added capacity mechanism/tests. I did **not** rerun the reported 5,345 unit / 988 integration / 241 host checks. The trace retains the failed first integration run and passing repeat; those are delivery-agent observations, not my new proof. [Receipt history](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md:662).

**The plan is internally stale even after the strikeout:** its S4 revision still says both cutover slices base on S3c, while S3c is cancelled. That is a plan correction to make after scope is settled, not a reason to resurrect S3c. [Contradicting lines](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/tmp/plan-workflows/2026-10-19-tool-engine-core-extraction.md:486).

### Built-code inventory by responsibility

This is the useful cut line through the branches; package names alone hide the mixture.

| Built component | What it does | Keep/cut judgment for the narrowed job |
| --- | --- | --- |
| S1 copied selectors, MCP approval policy, CLI validators, compiled-command resolution and JSON/profile schemas | Moves existing decisions into portable imports. | **Keep (A)**, with old behavior/bytes where they are contracts. |
| S1 `access-assessment.ts` | Defines revision-rich workspace/registration/account/upstream facts, explanation results, unmet conditions, and policy/profile projection. | **Mixed B/C**. The neutral facts actually needed for existing admission may stay. The full future workspace/view vocabulary is not required merely to move a policy function. |
| S1 `access-assessor.ts` | Recombines existing MCP/CLI/Google decisions; supports exact-call admission **and** no-call explanation over command/account breakdowns. | **A recomposition + C explanation feature**. Keep a single correct admission path; defer the comprehensive no-call UI projection unless independently selected. Removing it is a contract change for its new consumers, so Lead must replan, not silently delete it. |
| S2 `dispatch-contracts.ts` | New invocation, operation key/record, approval receipt/challenge, result unions and operation/approval ports. | **A/B** decoupling need, **B/C** exact public protocol. Keep neutral injection; separately decide whether the universal durable operation contract belongs now. |
| S2 `capability-dispatcher.ts` | Assessment → create/read operation → approval → arm → backend → persist completion; lookup is separate and never invokes. Allows managed untracked unapproved work. | **A/B** managed flow re-expression, **B/C** generalized public lifecycle. Do not call the all-call path a copied existing guarantee. |
| S2 managed adapter/projections | Maps trusted managed context/config/Google facts/backend calls and old controller approvals to neutral dispatch; preserves old authority checks. | **Keep the purpose (A/B)**. It is still dependent on old managed types and helpers until cutover; moving those ownership-bound types into `gateway-runtime` is legitimate extraction work. |
| S3a gateway/catalog/search/session | Reuses qualified tool references, filtering, schema validation and compact/full presentation. All calls use the new dispatcher, including direct tool calls. | **Keep (A/B)** for MCP composition; scrutinize inherited new public requirements separately. |
| S3a HTTP connectors | Outbound MCP runtime/protocol/errors/middleware; transport creation is injected, Node stdio moved out. | **Keep (A/B)**. This is central runtime separation, not a new end-user management feature. |
| S3a WebCrypto argument digest | Makes a shared digest portable without importing old HMAC/Node implementation; literal parity matters. | **Keep (A/B)** where the existing contract needs the digest. New fingerprint families remain explicitly distinct. |
| S3b catalog compiler/config files | Moves Node compiler/schema loaders/TypeScript generation and trusted provider configuration to the host. Node composition prepares generated namespace sources for the gateway. | **Keep (A)** for code mode. A portable engine accepting prepared source is useful; it doesn't require moving the TypeScript compiler into a Worker. |
| S3b secret resolution | Injected resolver; privileged headers or child environment receive provider credentials; CLI supplies environment resolver. No direct `secret-management` dependency in the new host. | **Keep (A/B)**. It is not an encrypted credential database or generic secret-entry service. An embedding app can supply the existing secret owner. |
| S3b HTTP/stdio/Node transport/logging | Platform hosting, configured bearer mapping, Host/Origin checks, existing size checks/redaction; ordered stdio/SSE progress correction. Unix-socket listener deferred. | **Mostly A/B**. Preserve existing support while extracting; don't invent a new stdio expansion. Socket support is a stated owner priority still not delivered by this new Node slice. Source correctness of a fix is separate from fresh proof. |
| S3b generation-bound credential context | Authenticated credential identity includes service generation; current-context checks fence calls and history access. | **A/B preservation/adaptation** of existing generation binding. The concrete new issuance/context schema is still a new host contract. |
| S3b public operation store + crash persistence + SQLite ownership fence | New per-call record create/read/transition/lookup and single-writer storage; public host records usable calls regardless of approval need. | **B/C**, realizing R7/R9. The crash-durable storage primitive is copied, but applying it as a public operation database is new functionality. Needs the scope decision below. |
| S3b native-call operation metadata | Catalog-mode calls must send `_meta['tool-portal/operation-item']`; without it, the tool call refuses before dispatch. Compact mode instead uses `calls[].id`. | **B/C public protocol addition**, motivated by stable items. This directly affects “any harness” and client-native code mode. Do not claim native client compatibility from raw MCP SDK tests. |
| Package closure/export guards and tests | Check that portable published imports do not pull Node/controller/VM/compiler effects; preserve selected schema/generator bytes and real boundaries. | **Supporting proof for A/B**, not automatically feature creep. Keep checks that establish the chosen boundary; don't use them to silently expand the promised behavior. |

Decisive built sources:
- [S1 facts/results](/Users/shravansunder/code/projects/agent-vm.tool-access-s1-rules-and-access-check/packages/tool-access/src/contracts/access-assessment.ts:24), [new explanation/admission function](/Users/shravansunder/code/projects/agent-vm.tool-access-s1-rules-and-access-check/packages/tool-access/src/authorization/access-assessor.ts:427).
- [S2 neutral and public contracts](/Users/shravansunder/code/projects/agent-vm.tool-engine-s2-dispatch-seam/packages/tool-engine/src/dispatch/dispatch-contracts.ts:15), [actual dispatch](/Users/shravansunder/code/projects/agent-vm.tool-engine-s2-dispatch-seam/packages/tool-engine/src/dispatch/capability-dispatcher.ts:125), [managed adapter still importing old owned types](/Users/shravansunder/code/projects/agent-vm.tool-engine-s2-dispatch-seam/packages/gateway-runtime/src/managed-tool-engine/managed-dispatch-adapter.ts:23).
- [S3a gateway dispatch composition](/Users/shravansunder/code/projects/agent-vm.tool-engine-s3a-mcp-gateway/packages/tool-engine/src/mcp-gateway/mcp-gateway.ts:125), [prepared helper use/direct calls](/Users/shravansunder/code/projects/agent-vm.tool-engine-s3a-mcp-gateway/packages/tool-engine/src/mcp-gateway/mcp-gateway.ts:311).
- [S3b composition/secret resolution](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/node-host-composition.ts:69), [compiler hookup](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/node-host-composition.ts:191), [only MCP backend/no configured workspaces yet](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/node-host-composition.ts:237).
- [new host's actual limits and contract](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/README.md:13), [metadata refusal](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/ingress/node-mcp-server.ts:40), [all-call store](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/operations/node-operation-store.ts:52).

**Lookup is not yet an advertised MCP feature in this Node host.** The store and dispatcher have lookup functions, but the inspected Node MCP server advertises/routes the four compact tools or native calls; the HTTP handler accepts only its configured MCP route. Those ports do not by themselves give an ordinary remote client the R9 recovery API. [MCP routing](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/ingress/node-mcp-server.ts:59), [HTTP route](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/ingress/node-http-server.ts:260).

**Important present-state limit:** the new standalone Node host currently admits only `mcp_provider` bindings and `workspaceLayer: 'not-configured'`; it is not yet the general native-Mac/VM resource host imagined by the destination diagram. It defaults protected work to unavailable when no approval implementation is injected. Production managed composition still instantiates the old Tool Portal core. [Node config](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/configuration/node-host-config.ts:14), [approval fallback](/Users/shravansunder/code/projects/agent-vm.tool-host-node-s3b/packages/tool-host-node/src/node-host-composition.ts:270), [production managed composition](/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts/packages/gateway-runtime/src/managed-tool-portal-composition.ts:121).

## 6. Where the drift happened

**First: a correct destination became one delivery.** The owner wanted distributed, reusable tools, and separately explored workspaces, UI, sign-in and fleet integration. We treated everything discovered as required to finish the same core rewrite. Requirements line 31 removed the difference between a requested outcome, a selected mechanism, an experiment and a delivery priority.

**Second: the UI moved out, but its domain moved into the core first.** `assessAccess` was designed to answer the new access view. We then made it the mandatory dispatch foundation and added workspace/explanation facts to S1. That is a defensible reuse architecture if the management product is in scope, but it is not a mechanical extraction. “The UI is deferred” was therefore incomplete.

**Third: a standards/security statement generated unbounded work.** R14 said every request/result/artifact/state/concurrency category must be finite. Each new store or transport generated another required mechanism/test. The argument was self-referential: spec → plan gap → more code → more categories. We never demonstrated that the owner had selected this hardening job. My 9056 recommendation fed that loop; the Lead's 9060 promotion made it an implementation grant.

**Fourth: review answered the wrong authorization question.** Reviews can establish whether implementation follows a supplied contract and whether proof can falsify a wrong build. They cannot independently turn that supplied contract into owner intent. Passing import/byte-parity checks and resolving review findings do not authorize adding a public record API, a proposal service or capacity admission.

**Fifth: the actual code-mode journey was lost.** U7/R8 mostly constrain presentation/runtime placement. The plan spends substantial effort on storage/assessment/control while there is no named real harness journey proving the user's positive outcome. The custom native-call metadata requirement may obstruct that very path; its compatibility is not established by the current SDK fixtures.

The A/B/C split is useful as a first map but insufficient as a scope test. A single built file can contain A and C, and B can be explicitly owner-requested. The right inventory records, for each behavior: **existing or new; source of intent; selected or exploratory; deliver now or later; actual implementation/proof**.

## 7. What “decompose + recompose + enable code mode” should retain

My recommendation is a small core delivery with two explicit boundaries: **which existing behavior is preserved**, and **one positive code-mode path to make usable**.

### Keep in the core job

- The existing policy/filtering/CLI/account decisions, complete profile semantics, credential custody and managed safety boundaries.
- Portable rules/contracts in `tool-access`; protocol, discovery and dispatch logic in `tool-engine`; Node effects/compiler/config loading in `tool-host-node`.
- Injected execution, secrets, identity facts and approval authority. Keep real existing authority implementations in their owning composition; do not invent a replacement fleet/approval/credential service to complete the move.
- Existing remote MCP connectors and qualified tool routing. Keep collaboration as an independent service.
- The generated TypeScript compiler/client path, with an explicit way for the selected agent to obtain and use it; full/compact exposure suited to that client.
- The managed adapter and eventual actual consumer cutover, with real existing boundaries tested. New copies passing tests while production still imports old code is not the completed extraction.
- Import-closure, schema/encoding/generator parity and relevant existing behavior checks. Preserve copied request/result limits and secret redaction; do not reinterpret the owner's rejection as approval to weaken existing protection.

This retains the four core/runtime package responsibilities already named, while leaving `tool-access-ui` as a separate future package, not a prerequisite.

### Separate from this delivery

- Workspace/persona registration, manager/team-account workflows, union catalogs with per-call workspace attribution.
- Comprehensive access explanation/view models, search over management entities and new screens.
- Chat/model routing, generalized proposals, Accept/application records and audit transaction coupling.
- New secret-entry APIs, approval-setting screens and people sign-in service.
- Temporary grants/revocation ideas.
- 9b/S3c and additional all-category hardening.
- Broad fleet enrollment/issuer/replication implementations, daemon work, extra VM providers, new networking infrastructure.

“Separate” means preserve their owner evidence in a later product/design lane. It does not mean pretend they were invented or erase existing OAuth/account controls.

### Built code requiring a deliberate decision, rather than automatic keep/delete

1. **`assessAccess`:** the existing decision logic is useful. Its complete no-call explanation/workspace model serves the later product. Either retain the already-built abstraction as a bounded implementation choice without claiming the product is delivered, or simplify before new consumers depend on it. Do not keep expanding it to finish the deferred UI.
2. **Public operation store/lookup/receipt contract:** this is a real resilience feature with a real client cost. Keep only if the owner wants that new guarantee in this delivery. If not, preserve existing managed approval/history semantics and scope the extraction to those; changing already-built interfaces must be planned explicitly.
3. **Native-call metadata:** do not make every harness require our private field without selecting and proving that client contract. Compact calls already have an item field; native clients may not expose arbitrary metadata. Current tests do not settle it.
4. **Legacy HMAC retirement:** package renaming and extracting reusable approval contracts do not by themselves select a new standalone trust protocol. Decide the replacement/consumer cutover before deleting the old path. No silent proof upgrade, duplicated authority or weakened managed checks.
5. **Worker delivery:** portable imports can be delivered/proven before a deployed Worker, but that does not fulfill hosted portability. If Worker serving is part of the immediate outcome, keep the runtime host and its real hosted proof, without importing the proposal/UI product into it.

These are scope recommendations, not edits or new governing decisions.

## 8. Questions only the owner can settle

I would bring them **one at a time**, starting with the first. They are not blockers to this inventory, which is complete.

1. **Where should the first working code-mode experience run?** In an existing harness's code environment, using generated MCP functions; or in an executor we host and expose as an MCP tool? I recommend using the harness's environment for the first proof because that follows O3 and reuses the compiler/SDK. It avoids operating another executor, but only works for a selected client that can use that path. A hosted executor is a different new feature, with broader compatibility and a runtime to operate. The owner chooses the experience and first harness; the Lead can discover its exact mechanics.
2. **Is a deployed Cloudflare Worker part of this delivery, or does the first delivery end at extracted packages plus the existing managed/Node composition?** Both follow the long-term destination. Delivering packages first reduces the current proof surface; it leaves actual hosted use unfulfilled until the next slice. If “I can use it from anywhere now” is required, the Worker/remote path cannot be deferred merely for convenience.
3. **Do all public tool calls need restart-safe history/retry identity now?** The owner asked resilient sessions; we proposed a stronger all-call record contract. It buys recoverable results and non-replay behavior, but costs storage, protocol fields, client adoption and new authority semantics. If not selected now, preserve today's approval behavior and avoid claiming the stronger guarantee.
4. **Does this phase replace the standalone approval protocol, or extract/adapt existing approval owners first?** I recommend preserving/adapting the actual managed owner first, then selecting a public remote authority contract separately. A unified protocol may be worthwhile, but it is a security/consumer change, not package housekeeping.

The latest stop already settles capacity work: **do not ask the owner to choose D5 values to restart it.** The later UI/login/product requests should return only in their separate delivery discussion, not as a new list of prerequisites to the core split.

## Evidence limits and completion

- I inspected owner messages in **this session's** requested primary history, the named exported trace, F decisions, main-thread messages, all U/R obligations and the decisive existing/new code paths. F-only and Lead-relayed quotes remain labeled; I have not treated them as primary utterances with invented exact timestamps.
- I checked code at the pinned snapshots above; the old targeted paths match current master. Source observations establish structure and added contracts, not live service behavior.
- I ran no new application/test/CI/browser/Worker/VM/model/credential actions. Reported earlier green runs are not newly verified here. I did not inspect or expose provider credentials.
- I made no edits to docs or code, no commits, no new helper commissions, and no decisions on the owner's behalf.
- Vendor/platform claims are not re-verified in this audit; this report does not rely on a fresh Cloudflare/Better Auth/client compatibility promise.
- The report's classification and keep/cut advice are my independent conclusions. Delivery acceptance and the next design belong to the owner and Lead.

