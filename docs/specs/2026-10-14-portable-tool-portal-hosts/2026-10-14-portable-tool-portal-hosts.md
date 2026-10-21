# Specification: what must be true when this is done

[Requirements](requirements.md) · [Program Design](program-design.md) · [Verification Design](verification-design.md)

Each check below compares the new pieces against **today's behaviour at `master` commit `08f9e426`**. That makes today's `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` the reference: if they did something, the new pieces do the same thing, unless a check below names the change.

There are three ways in today, and checks 1 to 12 apply to each one:
- agent-vm's private gateway connection;
- the standalone Tool Portal (its MCP tools and its JSON-over-HTTP endpoint);
- the MCP proxy.

They're described in the [Program Design](program-design.md#the-three-ways-in).

## Each way in looks the same

1. **Same tools and the same shapes.** With the same configuration and the same caller, each way in offers the same tools as today. Each tool has the same names, inputs and result shapes, and artifact reads work the same way.
2. **Each client gets one of two cases, and both reach the same tools.**
   - A client that connects with `?tools=direct` (`client-deferred`, for clients that defer tool loading themselves) gets `direct`: every tool the agent may use is listed as its own MCP tool, and the four search tools (list, search, describe, call) are listed too and work.
   - A client on the plain address (`portal-deferred`) gets `indirect`: only the four search tools are listed.
   - A caller gets the same case on every request, whatever other clients of the organization are connected.
   - The organization's portal connects to its tool servers and reads their tool lists when it starts, before any client's first call.
   - Either way the agent can reach exactly the same tools, and the same call gives the same result.
   - In `client-deferred`, the tool list comes in pages of at most 1 MiB, and only a client whose own page and tool limits cover the caller's whole list is set up that way.
   - The changes from today: `direct` also offers the search tools; the case is chosen per client instead of per server; and the list comes in pages.
3. **Hidden stays hidden.** A tool the caller may not use can't be found or called through any way in, by its name, by a guessed name, or through the search tools.

## Calls behave the same

4. **Same outcomes.** For the same call, the result matches today's: allowed and run, refused, needs approval, or failed. That includes what `describe` returns, such as today's per-tool TypeScript helper.
5. **One way to a tool.** Every call, whichever way it came in, goes through the same dispatcher and the same rules check. Nothing can reach a tool another way.
6. **Approvals.**
   - A call that needs approval doesn't run without it.
   - An approval covers exactly the calls it names (one call or a batch, as today). It can be used once, and it can't be reused for other calls.
   - **In agent-vm,** approvals go through the controller, as today.
   - **In the standalone Tool Portal,** its signed batch approval works as today, carried in MCP metadata on its MCP route and in its header on its JSON route. That includes refusing an old approval after the server restarts with a new service generation.
   - **In the MCP proxy,** its signed approval token works as today, carried in `mcp_portal_call`'s input or in MCP metadata on a `direct` call. Its record of used tokens lasts for the life of the process.
7. **Credentials stay out.** Provider credentials never appear in what a caller sends, receives, sees in errors, or can read from logs. Secrets in results and errors are redacted, as today.
8. **Same limits.** Each way in enforces today's limits, with today's meaning, and no new ones. They're listed in the [Program Design](program-design.md#limits-today). The Worker's own limits are check 15.

## agent-vm keeps working

9. **Managed tools unchanged.** agent-vm's own tools (native tools, configured CLIs and Tool VMs), its approvals, its private gateway connection and its controller's authority all work end to end after the switch, as they do today.
10. **MCP 2026-07-28 clients only** (owner, 2026-10-21).
    - Clients that speak MCP 2026-07-28, including the Portal SDK on the new client and Claude Code, connect and call the same tools in the same way.
    - A 2025-era `initialize` gets MCP's unsupported-version error. A 2026-07-28 request that's malformed (missing its required metadata, or with headers that don't match its body) gets the protocol's own error for that case. Neither runs anything.
    - There are no protocol sessions: no `Mcp-Session-Id` is issued, and one a client sends is ignored. `GET` and `DELETE` get 405.
    - Every `tools/list` page and every `resources/read` result carries `ttlMs` and `cacheScope: "private"`, because they depend on the caller. So does `server/discover`.
    - agent-vm's private connection, which Hermes uses inside agent-vm, isn't MCP and works as today.
    - Whether connections out to tool servers must also be 2026-07-28 is owner question 8.

## The pieces stay separate

11. **Allowed imports only.**
    - `tool-access` imports none of the other pieces.
    - `tool-engine` imports `tool-access`, but no Node-only code and nothing from agent-vm.
    - `tool-host-node` doesn't import agent-vm.
    - `tool-host-cloudflare` imports neither agent-vm nor `tool-host-node`.
    - agent-vm's managed adapter lives inside agent-vm.
12. **Clean switch.** When agent-vm runs on the new pieces, `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` are deleted. Nothing re-exports them, and nothing translates old calls into new ones. The three ways in stay as they are.

## The Worker

The Worker serves the MCP proxy's way in for organization tools. Its reference is today's proxy at `08f9e426`, run on a machine with the same configuration.

13. **The Worker behaves like the proxy.**
    - With the same configuration and caller, it offers the same tools, in `direct` or `indirect` mode, with the same results and the same refusals, as checks 1 to 4 require of the proxy. The only differences are the four search tools `direct` adds (check 2) and the Worker's own limits (check 15).
    - Its approval token works as the proxy's does (check 6). A token can be used only once, even when two copies of the Worker receive it at the same time, and no call runs if its use can't be recorded.
    - `describe` returns the same per-tool helper as on a machine, built from the tool's current schema.
14. **Only known callers, kept apart.**
    - The Worker refuses a caller it can't identify: a request with no sign-in token, or with one that's forged, expired or meant for another service.
    - An agent can't gain another agent's tools, connections or effects by sending another's name, session ID or client name. Such labels are ignored, and the call runs, or is refused, as the agent's own credential allows.
    - One organization's callers can't list or call another organization's tools, use its credentials or connections, or read its auth data, even when both organizations use the same agent or server names.
    - Removing an agent from its organization stops that agent's next call.
15. **The Worker's own limits hold,** as listed in the [Program Design](program-design.md#limits-on-the-worker): a request over the size limit is refused; a batch over the call limit is refused; no more than 6 calls of one batch run at once; and a reply that would pass its limit returns too-large results instead of failing the Worker.
16. **Analytics carry nothing private.** Each call sends one data point, in the shape the Program Design lists, and none holds arguments, results, secrets, tokens or personal details. Every data point fits Analytics Engine's limits, however long the configured names are, and a failed analytics write never changes the call. Credentials stay out of the Worker's logs, as check 7 requires everywhere.

## Not checked here

- Everything under "Not in this work" in the [Requirements](requirements.md#not-in-this-work).
- Code mode, which comes later.
- Per-user and computer tools, which come after the first version. Only the design's openings for them are in this work.
