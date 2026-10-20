# Specification: what must be true when this is done

[Requirements](requirements.md) · [Program Design](program-design.md) · [Verification Design](verification-design.md)

Each check below compares the new pieces against **today's behaviour** on `master`. That makes today's `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` the reference: if they did something, the new pieces do the same thing, unless a check below says otherwise.

## Agents see the same tools

1. **Same tool list.** With the same configuration and the same agent, the tools an agent can see match today's, tool for tool.
2. **Two modes, same tools.**
   - In `direct` mode, every tool the agent may use is listed as its own MCP tool, and so are the four search tools (list, search, describe, call).
   - In `indirect` mode, only the four search tools are listed.
   - Either way the agent can reach exactly the same tools, and the same call gives the same result.
3. **Hidden stays hidden.** A tool the agent may not use can't be found or called in either mode, by its name, by a guessed name, or through the search tools.

## Calls behave the same

4. **Same outcomes.** For the same call, the result matches today's: allowed and run, refused, needs approval, or failed.
5. **One way in.** Every call, in both modes and from both agent-vm and the standalone server, goes through the same dispatcher and the same rules check. Nothing can reach a tool another way.
6. **Approvals.** A call that needs approval doesn't run without it. An approval granted for one call can't be reused for a different call.
   - In agent-vm, approvals go through the controller, as today.
   - In the standalone server, approvals work as they do today. Today there are two signed-token paths: the old standalone Tool Portal's batch approval, and the MCP proxy's approval token. Which one the new server keeps is an open question in the [Requirements](requirements.md#questions-for-the-owner). Until that's settled, neither is replaced by something new.
7. **Credentials stay out.** Provider credentials never appear in what an agent sends, receives, sees in errors, or can read from logs. Secrets in results and errors are redacted, as today.
8. **Same size caps.** 4 MiB for what an agent sends, and 4 MiB for what a tool server returns, as today.

## agent-vm keeps working

9. **Managed tools unchanged.** agent-vm's own tools (native tools, configured CLIs and Tool VMs), its approvals and its controller's authority work end to end after the switch, as they do today.
10. **Same clients.** Hermes and the other MCP clients that work today connect and call tools the same way.

## The pieces stay separate

11. **Allowed imports only.**
    - `tool-access` imports none of the other pieces.
    - `tool-engine` imports `tool-access`, but no Node-only code and nothing from agent-vm.
    - `tool-host-node` doesn't import agent-vm.
    - agent-vm's managed adapter lives inside agent-vm.
12. **Clean switch.** When agent-vm runs on the new pieces, `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` are deleted. Nothing re-exports them, and nothing translates old calls into new ones.

## Not checked here

Everything under "Not in this work" in the [Requirements](requirements.md#not-in-this-work), and code mode, which comes later.
