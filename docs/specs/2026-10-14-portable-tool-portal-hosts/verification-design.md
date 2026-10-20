# Verification Design: how we'll know it works

[Requirements](requirements.md) · [Specification](2026-10-14-portable-tool-portal-hosts.md) · [Program Design](program-design.md)

This is the plan for proving the twelve checks in the [Specification](2026-10-14-portable-tool-portal-hosts.md). Writing it proves nothing; each check is proven when its test or run passes on the real code.

**The main method is to compare old with new, through each way in.** While `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` still exist (before the switch in S4), the same configuration and the same calls go to the old code and to the new pieces, and the results must match. That's how "the same as today" gets checked rather than assumed.
- **The old side is pinned to `master` commit `08f9e426`,** so the reference can't drift during the comparison.
- **The comparison runs through each of the three ways in:** agent-vm's private connection, the standalone Tool Portal's MCP tools, and the MCP proxy.

**VM tests run in GitHub CI only,** never locally. VM memory there is 2.5G (#242).

| # | Check | How it's proven | It fails if… |
| --- | --- | --- | --- |
| 1 | Same tools and shapes | Old-versus-new for each way in, over a fixed set of configurations and callers: tool names, inputs, result shapes and artifact reads, compared item by item. For the proxy's `direct` mode, the expected new list is the old list plus exactly the four search tools | a tool, schema, result shape or artifact read differs, or `direct` lists anything beyond the four added search tools |
| 2 | The proxy's two modes reach the same tools | The tools each caller can reach are compared between `direct` and `indirect`. In one `direct` connection, a real call to a search tool and a real call to a listed tool both work | the modes reach different tools, or a search tool listed in `direct` is refused |
| 3 | Hidden stays hidden | Calls to a hidden tool through each way in, by exact name, guessed name and search result, plus an allowed call as the control | a hidden tool runs or is shown |
| 4 | Same outcomes | Old-versus-new for allowed, refused, needs-approval and failed calls, result for result, including the bytes of the per-tool TypeScript helper that `describe` returns | any result differs from today's |
| 5 | One way to a tool | A deliberately wrong build that calls a backend without going through the dispatcher must fail the test, on the unauthorised effect, not on a setup error | the wrong build passes |
| 6 | Approvals | **agent-vm, a journey still to be built (CI):** a tool configured to need approval, the real controller decision, a count of effects, then a replay, which must add zero effects. The existing Hermes composition test (`portal-composition.hermes.e2e.test.ts`) needs no approvals, so it only covers unprotected calls. **Standalone Tool Portal:** today's batch-approval tests carried over, on both routes: the approval in MCP metadata from the real Portal SDK, and in the header on the JSON route. The exact batch runs; a call outside the batch is refused; a reused approval is refused; an approval from before a restart with a new service generation is refused. **MCP proxy:** today's token tests carried over, in both forms: `portalApprovalToken` in `mcp_portal_call`, and the approval metadata on a `direct` call to a tool that needs approval. The named calls run; a missing, mismatched or reused token adds zero effects | a call runs without approval, an approval runs a call it doesn't name, an approval is used twice, or an approved call can't run |
| 7 | Credentials stay out | A secret "canary" value given to a test tool server; the test checks it never shows up in results, errors, catalogs or logs a caller can read | the canary appears anywhere a caller can see it |
| 8 | Same limits | Today's limits checked at the old entry point and its replacement: Tool Portal JSON-route requests (64 KiB passes, 65 KiB refused), with no new cap on its MCP route; Tool Portal MCP text at 4,096 bytes while the structured result is still returned; proxy tool-server responses at 4 MiB before redaction; and a large proxy request that today's proxy accepts isn't refused by a new cap | any limit moves, disappears, or is newly added |
| 9 | Managed tools unchanged | After the switch: agent-vm's full suite, its VM and Hermes tests in CI, and the private connection's `portal`, `artifact.read` and catalog operations | any managed tool, approval, private operation or controller check stops working |
| 10 | Same clients | The Portal SDK calling `tool_portal_call` with approval metadata and reading an artifact through the replacement standalone server; a request on the Tool Portal's JSON route; the MCP SDK client over Streamable HTTP against the proxy; Hermes in the CI Hermes tests | a client that worked can't connect, call or read |
| 11 | Allowed imports only | The packed import checks per package (already in `pnpm check`), plus poisoned builds that must fail | a forbidden import gets through |
| 12 | Clean switch | After S4: no source or package refers to `@agent-vm/tool-portal` or `@agent-vm/mcp-portal`, both folders are gone, CI passes, and checks 1, 9 and 10 still pass through all three ways in | anything still imports or re-exports the old packages, or a way in changed |

## What stays unproven

- **Real third-party MCP servers.** Tests use controlled test servers; Gmail, GitHub and others aren't called.
- **Clients beyond the Portal SDK, the MCP SDK client and Hermes.** Other harnesses are expected to work because the protocols are unchanged, but none is tested here.
- **Code mode.** It's not in this work.
