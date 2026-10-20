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

1. **The three ways in keep working unchanged.** Callers reach tools three ways today, and each keeps its tool names, inputs, results and artifact reads:
   - **agent-vm's private connection** between its gateway and its portal (portal, artifact and catalog operations). It isn't MCP.
   - **the standalone Tool Portal:** its MCP tools (`tool_portal_*`, plus reading artifacts as MCP resources), which the Portal SDK uses, and its JSON-over-HTTP endpoint.
   - **the MCP proxy's tools** (`mcp_portal_*`, or one MCP tool per configured tool).
2. Agents see the same tools, under the same permissions, as today.
3. A call that needs approval still needs it, and approvals work as they do today:
   - in agent-vm, through its controller;
   - in each standalone server, through its own signed approval token, as today. Both of today's paths are kept.
4. Provider credentials never reach agents.
5. agent-vm's controller keeps its authority over its own tools, VMs and credentials.
6. Any client that works today keeps working, including the Portal SDK.
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

2. **The proxy shows tools one of two ways, chosen for each client.** Each organization's portal connects to its tool servers when it starts. What it shows depends on whether the connecting client loads tool definitions lazily itself:
   - **The client defers (`client-deferred`), so it gets `direct`:** every tool the agent may use is listed as its own MCP tool, and the search tools are offered as well and work. This was "catalog", which listed only the tools; offering the search tools too is a deliberate change.
   - **The portal defers (`portal-deferred`), so it gets `indirect`:** only the search tools are offered (list, search, describe, call), and the agent reaches every tool through them. This was "compact".
   - **Exactly these two cases.** A client not known to defer gets `portal-deferred`. Either way the agent reaches the same tools, under the same permissions and approvals.
   - **A big tool list still has to fit the client.** The full list has been measured at 4.56 MB or more, so in `client-deferred` it's sent in pages the client can take.

3. **A deployed, secured Cloudflare Worker** serves the MCP proxy's way in, with the same tools, results and approval token as the proxy on a machine.
   - **It refuses every caller it can't identify,** and it tells agents apart. How agents reach it, and how they prove who they are, is the first open question below.
   - **Its limits fit Workers and Durable Objects,** within the paid Workers plan the owner pays for.
   - **When one Worker or one Durable Object isn't enough,** the work can be split across several (sharding), once measurement shows it's needed.
   - Things a Worker can't run (stdio servers, configured CLIs, Tool VMs) stay on the Node host and agent-vm.

4. **Organizations, for sign-in only.** You belong to an organization to reach anything inside it. It has two roles:
   - the **owner**, who decides who may sign in and handles auth settings, nothing more;
   - **members**.

   Each organization has its own Durable Object, which is the one place its auth data lives. Being the owner grants no tool access and no access to anyone's personal accounts.

5. **Three kinds of tools, by whose credentials they use:**

   | Kind | What it is | When it can be built |
   | --- | --- | --- |
   | **Organization tools** | remote MCP servers set up for the organization, called with the organization's credentials. Today's proxy already does this with its configured servers and secret headers. | in this work |
   | **Per-user tools** | a person's own account, such as their own Google sign-in. A call runs only as that person, for an agent that person has allowed. | after the first two questions below; the design must not block it |
   | **Computer tools** | an MCP server on a machine or VM, which the Worker reaches privately. The Worker never runs them. | after the private connection and the machine's own sign-in are chosen; the design must not block it |

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
- Workspaces and per-workspace allowances. They're a separate layer inside an organization, for later.
- New screens: an access view, changing access by chat, entering secrets and approval settings.
- A full audit trail of permission and security changes.
- The people sign-in service. It's its own project ([people sign-in](../2026-10-20-people-sign-in/requirements.md)).
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
- **Three kinds of tools:** "tools that are org specific", "tools that are per user with auth", and "computer tools with vm etc".
- **Organizations:** "organizations are isolated for auth only"; "you have owner and org members. that's it. owners can allow people to log in or allow auth related stuff"; "segregated by durable objects".
- **Secrets:** from Cloudflare's secrets (Worker secrets or Secrets Store) or 1Password service-account tokens.
- **Agent identity:** "the agent needs to auth as itself or on behalf of someone else".
- **Relayed by the Advisor from the owner's session:** "the outer portal is Cloudflare's managed MCP Portal". The first question below asks whether that still holds for agents.

## Questions for the owner

Bring these one at a time, in this order. The first was sent as a brief on 2026-10-20.

1. **How do agents reach the Worker: through Cloudflare's managed MCP Portal, or directly behind Cloudflare Access?**
   - Cloudflare documents that the Portal sends one stored admin credential upstream for service-token sessions. So, for agents using service tokens, the Worker can't tell them apart through it, and per-user servers are excluded for those sessions. One upstream registration per agent might work around this. That's unproven, and proving it needs the owner's Cloudflare account.
   - Directly behind Access, the Worker tells agents apart by each agent's own credential, as today's proxy does with its agent bearer tokens.
   - **This blocks:** the Worker's caller check, and per-user tools.
2. **Who issues people's sign-in and agent tokens for real: our own auth service (Better Auth), or fleet?** Both advisors lean toward Better Auth, using fleet only if fleet commits a ready token contract. **This blocks:** per-user tools, and selling this as a product without the owner's Cloudflare Access.
3. **Do tool calls need history that survives a restart?** The design assumes not. Today's servers keep no record per call. On the Worker, the one thing kept is which approval tokens have been used, until each expires, so an approval still works only once.
4. **Do you want to retire either of today's standalone approval paths?** There are two: the standalone Tool Portal's signed batch approval, and the MCP proxy's signed approval token. Each serves its own way in, so the design keeps both.

5. **How does the portal know a client defers tool loading?** You asked for the case to come from the client's capabilities. No client declares that today, though MCP would allow a namespaced extension for it later. So the case comes from how the client is set up, in one of two ways:
   - **A (recommended): the address the client is given.** The portal has a default address, where it defers, and a `…/direct` address for clients that defer themselves. One credential per agent, and identity stays separate from presentation.
   - **B: a profile on each agent credential.** It costs an extra credential per kind of client an agent runs.

   Either way, a client on the default never gets the full list, and a wrong choice can't grant any tool. **This blocks** building `client-deferred`, not the rest of the design.

**Needed from the owner before the Worker can be deployed:** a Cloudflare account and an API token for the deployment and its proof.
