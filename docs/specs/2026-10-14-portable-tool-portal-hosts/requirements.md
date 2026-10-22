# Requirements: take Tool Portal apart and put it back together

[Specification](2026-10-14-portable-tool-portal-hosts.md) · [Program Design](program-design.md) · [Verification Design](verification-design.md)

## What this work is

agent-vm has two libraries for tools today: `@agent-vm/tool-portal` and `@agent-vm/mcp-portal`. They grew up together and each one mixes several jobs:
- the rules for who may call what;
- serving MCP to agents;
- calling other MCP servers;
- running agent-vm's own tools;
- Node-only code.

This work has two parts:
1. **Take them apart** into pieces with one job each, and put agent-vm back together on those pieces. **Behaviour stays the same.** No new features.
2. **Run the MCP proxy on a deployed, secured Cloudflare Worker.** The owner added this on 2026-10-20, and it's the one new thing. It brings organizations, three kinds of tools and analytics with it, described under "What changes".

**Why take them apart:**
- each piece can be understood, tested and changed on its own;
- the rules can be used without pulling in the server;
- the same engine can run on a machine and on a Worker;
- code mode can be added later, in one place.

## What must stay the same

1. **The three ways in keep working unchanged.** Callers reach tools three ways today, and each keeps its tool names, inputs, results and artifact reads. The MCP routes move to MCP 2026-07-28 (owner, 2026-10-21; below):
   - **agent-vm's private connection** between its gateway and its portal (portal, artifact and catalog operations). It isn't MCP.
   - **the standalone Tool Portal:** its MCP tools (`tool_portal_*`, plus reading artifacts as MCP resources), which the Portal SDK uses, and its JSON-over-HTTP endpoint.
   - **the MCP proxy's tools** (`mcp_portal_*`, or one MCP tool per configured tool).
2. Agents see the same tools, under the same permissions, as today.
3. A call that needs approval still needs it, and approvals work as they do today:
   - in agent-vm, through its controller;
   - in each standalone server, through its own signed approval token, as today. Both of today's paths are kept.
4. Provider credentials never reach agents.
5. agent-vm's controller keeps its authority over its own tools, VMs and credentials.
6. Clients that speak MCP 2026-07-28 work, including the Portal SDK once it moves to the new client. A client that speaks only 2025-era MCP is refused (owner, 2026-10-21). agent-vm's private connection isn't MCP and doesn't change.
7. Today's limits stay as they are, at the entry point where each applies. They're listed in the [Program Design](program-design.md#limits-today). The Worker has its own limits, listed there too.

## What changes

1. **The pieces.** The two libraries become these:

   | New piece | Its one job |
   | --- | --- |
   | `@agent-collaboration/tool-access` | The rules: may this agent call this tool, and does the call need approval? It has no server code. |
   | `@agent-collaboration/tool-engine` | The core: shows tools to agents, routes every call through one dispatcher, and talks to other MCP servers. |
   | `@agent-collaboration/tool-host-node` | Runs the engine on a machine: takes connections, checks who's calling, and loads config. It replaces both of today's standalone servers and keeps each one's tools and results. |
   | `@agent-collaboration/tool-host-cloudflare` | Runs the engine as a deployed, secured Cloudflare Worker that serves the MCP proxy's way in. |
   | agent-vm's managed adapter | Plugs agent-vm's own tools and approvals into the engine. It stays inside agent-vm. |

   When agent-vm runs on the new pieces, the old `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` are deleted. Deleting the packages doesn't change any of the three ways in.

2. **The proxy shows tools one of two ways, chosen for each client.** Each organization's portal connects to its tool servers when it starts. What it shows depends on whether the connecting client loads tool definitions lazily itself, which the client's address says (`?tools=direct`):
   - **The client defers (`client-deferred`), so it gets `direct`:** every tool the agent may use is listed as its own MCP tool, and the search tools are offered as well and work. This was "catalog", which listed only the tools; offering the search tools too is a deliberate change.
   - **The portal defers (`portal-deferred`), so it gets `indirect`:** only the search tools are offered (list, search, describe, call), and the agent reaches every tool through them. This was "compact".
   - **Exactly these two cases.** A client not known to defer gets `portal-deferred`. Either way the agent reaches the same tools, under the same permissions and approvals.
   - **A big tool list still has to fit the client.** The full list has been measured at about 4.56 MB across 170 tools (Router PR #153), so in `client-deferred` it's sent in pages the client can take.

3. **A deployed, secured Cloudflare Worker** serves the MCP proxy's way in, with the same tools, results and approval token as the proxy on a machine.
   - **It refuses every caller it can't identify,** and it tells agents apart. Agents sign in with our own login, Better Auth, not Cloudflare Access.
   - **Sign-in comes into this work.** The sign-in service (`@agent-collaboration/auth`, [people sign-in](../2026-10-20-people-sign-in/requirements.md)) runs Better Auth in its own Worker and gives people and agents tokens for the tool Worker. Its design now adds agents signing in as themselves (its `U8` and `R15` to `R17`), awaiting independent review.
   - **Cloudflare is for machines only.** The Worker reaches registered computers through Cloudflare (Tunnel and Access), like Tailscale.
   - **Its limits fit Workers and Durable Objects,** within the paid Workers plan the owner pays for.
   - **When one Worker or one Durable Object isn't enough,** the work can be split across several (sharding), once measurement shows it's needed.
   - Things a Worker can't run (stdio servers, configured CLIs, Tool VMs) stay on the Node host and agent-vm.

4. **Organizations, for sign-in only.** You belong to an organization to reach anything inside it. It has two roles:
   - the **owner**, who decides who may sign in and handles auth settings, nothing more;
   - **members**.

   Each organization has its own Durable Object, which holds who belongs to it and its sign-in settings; the logins themselves are kept by the sign-in service. Being the owner grants no tool access and no access to anyone's personal accounts.

5. **Four kinds of tools, by whose credentials they use and what they're for:**

   | Kind | What it is | When it can be built |
   | --- | --- | --- |
   | **Organization tools** | remote MCP servers set up for the organization, called with the organization's credentials. Today's proxy already does this with its configured servers and secret headers. | in this work |
   | **Per-user tools** | a person's own account, such as their Google account, that its owner has consented to a specific agent. It uses today's permission model: the owner's consent, Deny/Ask/Allow for reads and writes, and one-call approvals. An agent always acts with its own access; "on behalf of" is only a label in the log (fleet F-35). | next, after the first version; the design must not block it |
   | **Computer tools** | an MCP server on a registered computer or VM, which the Worker reaches through Cloudflare (Tunnel and Access), like Tailscale. The Worker never runs them. | next, after the first version; the design must not block it |
   | **Collaboration tools** (owner, 2026-10-22) | the fleet's own agent-collaboration MCP, which facilitates collaboration between agents and people: boards, threads, messages and sessions. It acts as the calling agent itself, so the agent's own identity has to reach the fleet. Neither an organization credential nor a person's account can stand in for it | not yet scoped; the design must not block it. How the agent's identity reaches the fleet is open, and is shared with the fleet's agent-identity question (fleet Q-C11) |

6. **Analytics and observability.**
   - Each call sends one data point to Cloudflare Workers Analytics Engine: who called, which tool, the outcome and the timing. Analytics Engine samples data, which the owner accepted, so it's a view of usage, not a complete history.
   - It never holds arguments, results or secrets.
   - The data point has the same shape on every host.
   - Logs, traces and errors on the Worker use Cloudflare's built-in Workers observability.

## Not in this work

Pruned by the owner on 2026-10-20. Several of these **were** asked for at different times, as separate tracks: workspace scopes, a React UI, audit, changing access by chat, people sign-in, and a central cloud entry. The owner also said "in essence this is 2 projects" and "lets move to the core functionality and design and split". So they belong in their own later projects, not in this core split. The owner's words for each are kept in the [independent inventory](../../wip/2026-10-20-tool-portal-scope-inventory/inventory.md). The owner's later Worker decisions (above) replace the earlier lines that excluded the Worker and computer tools.
- Fleet and Router integration, including fleet-issued agent tokens.
- Routing calls between machines in the fleet. The Worker reaching a computer's own MCP server is a computer tool, above.
- A stored record of every call, and recovery of calls after a restart. Today's servers keep no such record.
- ~~Workspaces and per-workspace allowances. They're a separate layer inside an organization, for later.~~ **Superseded on 2026-10-22:** the workspace is now the portal's unit (see below).
- A full audit trail of permission and security changes.
- An agent acting with someone else's accounts. "On behalf of" stays a label in the log (fleet F-30, F-35).
- A control API for proposing and deciding changes.
- New limits or hardening beyond today's limits, except the Worker's own limits.

## Later, if wanted

- **Code mode in both `direct` and `indirect`:** code calls tools through a typed API. It's wanted eventually, not in this work. **Nothing here may block it:** `describe`'s per-tool helper keeps working on every host, including the Worker, and the full catalog compiler keeps working where it runs today.

## Owner decisions on 2026-10-20

- **Scope:** take apart and recompose, with no new features: "decompose and rethink composition and system ground up not add more features."
- **Mode names:** `direct` and `indirect`.
- **Deferred tool loading** (09:52 and 09:54 ET, relayed by Sun): it's per MCP portal, meaning per organization, and "each MCP portal instance connects to its downstream MCPs at startup". What it exposes is "DYNAMIC, decided per connecting client": "if the client supports deferred MCP/tool loading → give it everything (full tool list) and let the client defer. If the client doesn't → the portal does the deferred loading itself." It's modelled as a union, `client-deferred | portal-deferred`, chosen from the client's capabilities. Proof: real runs of both paths, checked by an independent Verifier.
- **Code mode:** in both modes eventually, "should be possible later, just don't block us".
- **Pruning:** everything listed under "Not in this work".
- **Cloudflare Worker:** "yes deployed secured cf worker is part of the delivery".
- **Limits:** "make sure caps are reasonable for limits and fit worker/durable objects (i pay for workers)".
- **Scaling:** "we can have shards if we need it and workers need to split up".
- **Analytics and observability:** "analytics and metrics for analytics engine". Sampled data is fine. "observability looks like cf has stuff already, we use that".
- **Four kinds of tools:** "tools that are org specific", "tools that are per user with auth", and "computer tools with vm etc" (2026-10-20). The fourth, named 2026-10-22: "it was the agent collaboration / fleet mcp", "that facilitated collaboration".
- **Organizations:** "organizations are isolated for auth only"; "you have owner and org members. that's it. owners can allow people to log in or allow auth related stuff"; "segregated by durable objects".
- **Secrets:** from Cloudflare's secrets (Worker secrets or Secrets Store) or 1Password service-account tokens.
- **Agent identity:** "the agent needs to auth as itself or on behalf of someone else".
- **Who issues real logins and agent keys** (2026-10-20, owner: "better auth i thought?"): Better Auth, our own login service. Later that day the owner also decided agents sign in with Better Auth from the start, not Cloudflare Access (see **Sign-in** below); that replaces an earlier plan of Access plus agent keys first.
- **Relayed by the Advisor from the owner's session:** "the outer portal is Cloudflare's managed MCP Portal". Answered for agents on 2026-10-20: they connect directly, with our own sign-in.
- **Sign-in** (2026-10-20, in chat): "i thought we would use our own auth and not cloudflare access"; "we need a identity aware login ... in the worker with better auth? and our config system". Better Auth runs in the sign-in service's own Worker, and the tool Worker checks its tokens ("yes to a"). Cloudflare Access is "only selected agents and a configuration server side and registration for computer control ... kinda like tailscale ... from worker downwards to those computers".
- **Admin panel** (2026-10-20): "i think i want everything to be configurable via admin panel", then option C: "request bar to search and make changes as proposal and user to accept with form. so agent makes the change user sees and accepts". It refines fleet F-41 and F-43: the panel has a request bar for search and proposals, and each proposal is shown as a form you accept. "we can design it more", so it gets its own design pass. **It's in the first version** ("no we need panel"), building on the base design: "gen ui with composing ui for show or edit with shadcn components using shadcn lint and shadcn cn library". The agent's draft form **can be edited** before accepting. **Accounts get a details view**: "a details page or modal or drawer form below".
- **Personal accounts are set up by their owners** (2026-10-20): "i like that each of us signs in for that agent to flow and setup our own just like agent-vm partially does now". Per-user tools keep agent-vm's flow: an agent-provided private link, then sign in, choose consent, connect the account and set its rules ([profile policy](../2026-09-13-profile-oauth-policy/requirements.md), U4). Each person does their own, and sign-in moves to Better Auth.
- **Who approves on a personal account** (2026-10-20, "yes to 1"): when a call on a person's own account requires approval, that account's owner decides it. You approve edits to your calendar, and your wife approves edits to hers. This adopts that row of the October 15 proposal. The owner also said to "cover auto approval or ability to change easily". So an owner can set an action on their account to auto (the judge decides, and asks them when unsure), to approved, or to approved until a time. They can change that easily: today on agent-vm's account page, later with one request in the admin panel, shown as a form they accept.
- **Approved with a time limit** ("so we have approved with time limit too"): approved can carry an end time, a temporary grant, after which the tool goes back to its previous mode. "Blocked until a time not required", so F-61's temporary revocation is dropped. Not in the first version.
- **Tool-loading case:** a URL parameter ("i thought it would be a url param when dialing in?").

## Owner decision on 2026-10-21

- **MCP 2026-07-28 only, stateless** (said to the Advisor, pointing at [Cloudflare's MCP v2 post](https://blog.cloudflare.com/mcp-v2/)): "we only want to support mcp 2 stateless" (typed as "fhy we only want to skupoed mcp 2 stateless"). Every MCP route we serve speaks only the 2026-07-28 protocol: no `initialize`, no protocol sessions, no `Mcp-Session-Id`. A 2025-era client is refused. This replaces "any client that works today keeps working" for MCP. It doesn't touch agent-vm's private connection, which Hermes uses inside agent-vm and which isn't MCP ([managed_gateway_bootstrap.py:919](../../../python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py#L919)).
  - **Who this affects today:**
    - **Claude Code** speaks it by default since 2.1.274 (HTTP) and 2.1.292 (stdio), unless a user opts out ([changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21274)).
    - **Codex** 0.163.0 speaks it only with its `mcp_2026_07_28` feature turned on, plus a per-server marker for stdio servers ([features](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/features/src/lib.rs#L1541)).
    - **Our Portal SDK clients** (Node and Python) move to the new SDKs.
    - **Clients on MCP SDK v1** can't connect.
  - **Our own connections out to tool servers reach each server on whatever MCP version it speaks** (question 8, answered 2026-10-22). Only what we serve to client agents is 2026-07-28 only.

## Owner decisions on 2026-10-22: the workspace is the unit

These replace the 2026-10-20 line that put workspaces "for later". The fleet framework records them as F-69 to F-76; the Lead's local data-map explainer (`docs/wip/2026-10-22-data-map/`, kept out of the repository) shows the data they change.

- **Each workspace has its own MCP** (F-73): "mcp is per workspace". An agent connects to the MCP of each workspace it belongs to. The workspace is the endpoint, not an argument on a call.
- **Auth is per workspace** (F-75): "auth is per works pace". An agent's token is scoped to one workspace and means nothing at another. This doesn't choose a new token issuer.
- **An agent has no access of its own** (F-71): "we arent creating any internal bots with its own access, its all vai workspace". In a workspace it belongs to, an agent has that workspace's tools, which its persona may narrow. Per agent we store only who it is, which workspaces it belongs to and its persona.
- **External agents get only agent-collaboration** (F-72, F-75): "external agents only have access to agent collaboration". Internal or external is decided per workspace by membership (F-69); internal and external agents alike reach resources only through mediation (F-70).
- **Every agent works through agent-collaboration** (F-74): "man agents go through agent-collaboration".
- **Agents join workspaces, and the fleet knows each workspace's members, machines and agent-collaboration** (F-76). The portal reads membership from the fleet, and from configuration until the fleet carries it (F-53).

What this changes in the design: today's code calls the portal's unit an *organization* (one Durable Object, one configuration, one admitted-agent list, one MCP endpoint). That unit becomes the workspace; its admitted-agent list is the workspace's membership; and a profile belongs to the workspace instead of being assigned to each agent. How sign-in's organizations relate to workspaces is still open (decision 1 in the Lead's local org-and-portal explainer). The Specification and Program Design haven't been revised for this yet.

## Questions for the owner

Questions 1, 2 and 5 were answered on 2026-10-20; 3 and 4 stand as assumed.

6. **What's in the first version?** This is the Lead's reading of your decisions, not your answer yet: agents acting with their own access, configured tools, and the three approval modes that exist today in your D-9 words: approved, requires approval and blocked (fleet F-23, F-35, F-53, F-56, D-9). Three separate choices follow, and any can come first:
   - per-user tools, under today's permission model;
   - the chat-led change flow (fleet F-41 to F-49), in the separate control UI.
   - the **auto** mode, with its judge (D-9), once where the judge runs (T-16) is settled;
   - **approved until a time** (temporary grants);

   The admin panel is in the first version (owner, 2026-10-20). The Lead reads the first version as keeping each organization's configuration in its database, as versions, which the panel changes with no redeploy.
7. **Does an agent ever act on behalf of a person?** Fleet F-35 says "on behalf of" is only a label, and an agent never uses a requester's accounts. On 2026-10-15 you said approval and control are "per agent, or on behalf of user". The design follows F-35 until you say otherwise.

1. **Answered on 2026-10-20:** agents reach the Worker directly and sign in with Better Auth, not through Cloudflare's MCP Portal or Access (see owner decisions).
2. **Answered on 2026-10-20: Better Auth** (see owner decisions).
3. **Do tool calls need history that survives a restart?** The design assumes not. Today's servers keep no record per call. On the Worker, the one thing kept is which approval tokens have been used, until each expires, so an approval still works only once.
4. **Do you want to retire either of today's standalone approval paths?** There are two: the standalone Tool Portal's signed batch approval, and the MCP proxy's signed approval token. Each serves its own way in, so the design keeps both.

5. **Answered on 2026-10-20:** a URL parameter, `?tools=direct` (see owner decisions).
8. **Answered on 2026-10-22: yes.** In your words: "downstream servers can be whatever, we should connect"; "2026-07-28 only" meant from us to client agents. DeepWiki, which speaks only up to 2025-11-25, is "super important" and must keep working. The Perplexity local server is no longer used, so it's out of scope. This replaces the Lead's earlier "no" recommendation.

**Deploying the Worker** uses the owner's existing Cloudflare CLI login (`wrangler`, already signed in on this machine). Nothing more is needed from the owner for it.
9. **What should aborting a Portal SDK call over HTTP do?** Today the SDK cancels the work, then keeps the response open for a short grace period to collect the call's final result (`resultGraceAfterAbortMs`). MCP 2026-07-28 over HTTP cancels by closing that request's stream, so both can't happen at once (checked with a real SDK test in S3d).
   - **The Lead recommends A:** the server is told to cancel at once, and the caller gets today's "grace expired, outcome uncertain" result, as if the grace period were zero. It follows the protocol you chose. Being told to cancel isn't proof that the work stopped: whether a tool that has started stops depends on that tool, and the test proves only that the request was cancelled. So the outcome stays uncertain, and nothing is retried automatically.
   - **The alternative, B:** keep the stream open through the grace period, then close it. The caller may still get the final result, but the server isn't asked to cancel until the grace period ends.
   - **Unchanged either way:** stdio and agent-vm's private connection keep today's grace.
   - **What happens if you defer:** A is in the S3d draft PR provisionally, and B is a small swap.
