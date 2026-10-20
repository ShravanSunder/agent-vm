# Specification: what must be true when this is done

[Requirements](requirements.md) · [Program Design](program-design.md) · [Verification Design](verification-design.md)

Each check below compares the new pieces against **today's behaviour at `master` commit `08f9e426`**. That makes today's `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` the reference: if they did something, the new pieces do the same thing, unless a check below names the change.

There are three ways in today, and every check applies to each one:
- agent-vm's private gateway connection;
- the standalone Tool Portal (its MCP tools and its JSON-over-HTTP endpoint);
- the MCP proxy.

They're described in the [Program Design](program-design.md#the-three-ways-in).

## Each way in looks the same

1. **Same tools and the same shapes.** With the same configuration and the same caller, each way in offers the same tools as today. Each tool has the same names, inputs and result shapes, and artifact reads work the same way.
2. **The proxy's two modes reach the same tools.**
   - In `direct` mode, every tool the agent may use is listed as its own MCP tool, and the four search tools (list, search, describe, call) are listed too and work.
   - In `indirect` mode, only the four search tools are listed.
   - Either way the agent can reach exactly the same tools, and the same call gives the same result.
   - The only change from today is that `direct` also offers the search tools.
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
8. **Same limits.** Each way in enforces today's limits, with today's meaning, and no new ones. They're listed in the [Program Design](program-design.md#limits-today).

## agent-vm keeps working

9. **Managed tools unchanged.** agent-vm's own tools (native tools, configured CLIs and Tool VMs), its approvals, its private gateway connection and its controller's authority all work end to end after the switch, as they do today.
10. **Same clients.** The Portal SDK, Hermes, and other MCP clients that work today connect and call tools the same way.

## The pieces stay separate

11. **Allowed imports only.**
    - `tool-access` imports none of the other pieces.
    - `tool-engine` imports `tool-access`, but no Node-only code and nothing from agent-vm.
    - `tool-host-node` doesn't import agent-vm.
    - agent-vm's managed adapter lives inside agent-vm.
12. **Clean switch.** When agent-vm runs on the new pieces, `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` are deleted. Nothing re-exports them, and nothing translates old calls into new ones. The three ways in stay as they are.

## Not checked here

Everything under "Not in this work" in the [Requirements](requirements.md#not-in-this-work), and code mode, which comes later.
