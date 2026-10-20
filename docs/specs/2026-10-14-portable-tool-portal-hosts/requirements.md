# Requirements: take Tool Portal apart and put it back together

[Specification](2026-10-14-portable-tool-portal-hosts.md) · [Program Design](program-design.md) · [Verification Design](verification-design.md)

## What this work is

agent-vm has two libraries for tools today: `@agent-vm/tool-portal` and `@agent-vm/mcp-portal`. They grew up together and each one mixes several jobs:
- the rules for who may call what;
- serving MCP to agents;
- calling other MCP servers;
- running agent-vm's own tools;
- Node-only code.

This work takes them apart into pieces with **one job each**, and puts agent-vm back together on those pieces. **Behaviour stays the same.** No new features.

**Why:**
- each piece can be understood, tested and changed on its own;
- the rules can be used without pulling in the server;
- code mode can be added later, in one place.

## What must stay the same

1. **The three ways in keep working unchanged.** Callers reach tools three ways today, and each keeps its tool names, inputs, results and artifact reads:
   - **agent-vm's private connection** between its gateway and its portal (portal, artifact and catalog operations). It isn't MCP.
   - **the standalone Tool Portal's MCP tools** (`tool_portal_*`, plus reading artifacts as MCP resources). The Portal SDK uses these.
   - **the MCP proxy's tools** (`mcp_portal_*`, or one MCP tool per configured tool).
2. Agents see the same tools, under the same permissions, as today.
3. A call that needs approval still needs it, and approvals work as they do today:
   - in agent-vm, through its controller;
   - in each standalone server, through its own signed approval token, as today. Both of today's paths are kept.
4. Provider credentials never reach agents.
5. agent-vm's controller keeps its authority over its own tools, VMs and credentials.
6. Any client that works today keeps working, including the Portal SDK.
7. Today's limits stay as they are, at the entry point where each applies. They're listed in the [Program Design](program-design.md#limits-today).

## What changes

1. **The pieces.** The two libraries become these:

   | New piece | Its one job |
   | --- | --- |
   | `@agent-collaboration/tool-access` | The rules: may this agent call this tool, and does the call need approval? It has no server code. |
   | `@agent-collaboration/tool-engine` | The core: shows tools to agents, routes every call through one dispatcher, and talks to other MCP servers. |
   | `@agent-collaboration/tool-host-node` | Runs the engine on a machine: takes connections, checks who's calling, and loads config. It replaces both of today's standalone servers and keeps each one's tools and results. |
   | agent-vm's managed adapter | Plugs agent-vm's own tools and approvals into the engine. It stays inside agent-vm. |

   When agent-vm runs on the new pieces, the old `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` are deleted. Deleting the packages doesn't change any of the three ways in.

2. **The proxy's two ways of showing tools get clearer names:**
   - **`direct`**: every tool the agent may use is listed as its own MCP tool, and the search tools are offered as well and work. This was "catalog", which listed only the tools; offering the search tools too is the one deliberate change.
   - **`indirect`**: only the search tools are offered (list, search, describe, call), and the agent reaches every tool through them. This was "compact".

## Not in this work

Pruned by the owner on 2026-10-20. Several of these **were** asked for at different times, as separate tracks: workspace scopes, a React UI, audit, changing access by chat, people sign-in, and a central cloud entry. The owner also said "in essence this is 2 projects" and "lets move to the core functionality and design and split". So they belong in their own later projects, not in this core split. The earlier design made them all one delivery; that was the mistake. The owner's words for each are kept in the [independent inventory](../../wip/2026-10-20-tool-portal-scope-inventory/inventory.md).
- A Cloudflare Worker host, a cloud gateway in front of computers, and calls routed across machines.
- Fleet and Router integration, and enrolment of agents, machines and services.
- A stored record of every call, and recovery of calls after a restart. Today's server keeps no such record.
- Workspaces and per-workspace allowances.
- Any UI or screens, an access view, changing access by chat, entering secrets, and approval settings.
- Audit events.
- The people sign-in service.
- A control API for proposing and deciding changes.
- New limits or hardening beyond today's limits.

## Later, if wanted

- **Code mode in both `direct` and `indirect`:** code calls tools through a typed API. It's wanted eventually, not in this work.

## Owner decisions on 2026-10-20

- **Scope:** take apart and recompose only, with no new features. In the owner's words: "decompose and rethink composition and system ground up not add more features."
- **Mode names:** `direct` and `indirect`.
- **Code mode:** in both modes eventually, "but not now".
- **Pruning:** everything listed under "Not in this work".

## Questions for the owner

Bring these one at a time. None of them blocks writing this design.

1. **Is a deployed Cloudflare Worker part of this delivery?** The design assumes not: the first delivery ends at the new packages, running in agent-vm and in the standalone Node server. If "I can use it from anywhere now" is required, the Worker host comes back into this delivery.
2. **Do tool calls need history that survives a restart?** The design assumes not. Today's server keeps no record per call, and you asked "why do we need to store anything". If that's right, the disk store built in S3b is replaced by what today's servers keep: a record in memory only for calls that need approval, lost on restart. The name-in-`_meta` requirement is removed.
3. **Do you want to retire either of today's standalone approval paths?** There are two: the standalone Tool Portal's signed batch approval, and the MCP proxy's signed approval token. Each serves its own way in, so the design keeps both. Retiring one is only your call.
