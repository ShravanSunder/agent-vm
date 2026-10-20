# Verification Design: how we'll know it works

[Requirements](requirements.md) · [Specification](2026-10-14-portable-tool-portal-hosts.md) · [Program Design](program-design.md)

This is the plan for proving the twelve checks in the [Specification](2026-10-14-portable-tool-portal-hosts.md). Writing it proves nothing; each check is proven when its test or run passes on the real code.

**The main method is to compare old with new.** While `@agent-vm/tool-portal` and `@agent-vm/mcp-portal` still exist (before the switch in S4), the same configuration and the same calls run through both the old code and the new pieces, and the results must match. That's how "the same as today" gets checked rather than assumed.

**VM tests run in GitHub CI only,** never locally. VM memory there is 2.5G (#242).

| # | Check | How it's proven | It fails if… |
| --- | --- | --- | --- |
| 1 | Same tool list | Old-vs-new comparison: for a fixed set of configurations and agents, the old and new tool lists are compared item by item | a tool appears or disappears, or its schema differs |
| 2 | Two modes, same tools | The same set run through `direct` and `indirect`: the same reachable tools, and the same results for the same calls. `direct` also lists the four search tools | one mode shows or allows something the other doesn't |
| 3 | Hidden stays hidden | Calls to a hidden tool by its exact name, a guessed name and a search result, in both modes, plus an allowed call as the control | a hidden tool runs or is shown |
| 4 | Same outcomes | Old-vs-new comparison of allowed, refused, needs-approval and failed calls, matching result for result | any result differs from today's |
| 5 | One way in | A deliberately wrong build that calls a backend without going through the dispatcher must fail the test, on the unauthorised effect, not on a setup error | the wrong build passes |
| 6 | Approvals | **agent-vm:** the real controller path in CI, through the Hermes portal-composition test (`portal-composition.hermes.e2e.test.ts`): a call needing approval waits, runs once after approval, and a reused approval is refused. A batch approval runs exactly the calls it names and nothing else. **Standalone:** the tests of the approval path the owner picks, carried over from today | a call runs without approval, an approval runs a call it doesn't name, or an approval is used twice |
| 7 | Credentials stay out | A secret "canary" value given to a test tool server; the test checks it never shows up in results, errors, catalogs or logs the agent can read | the canary appears anywhere an agent can see it |
| 8 | Same size caps | Today's size-cap tests carried over: 4 MiB for what an agent sends, 4 MiB for what a tool server returns | either cap moves or disappears |
| 9 | Managed tools unchanged | agent-vm's full suite, plus its VM and Hermes tests in CI, run after the switch | any managed tool, approval or controller check stops working |
| 10 | Same clients | The MCP SDK client over Streamable HTTP in the host tests; Hermes in the CI Hermes tests | a client that worked can't connect or call |
| 11 | Allowed imports only | The packed import checks per package (already in `pnpm check`), plus poisoned builds that must fail | a forbidden import gets through |
| 12 | Clean switch | After S4: no source or package refers to `@agent-vm/tool-portal` or `@agent-vm/mcp-portal`, both folders are gone, and CI passes | anything still imports or re-exports the old packages |

## What stays unproven

- **Real third-party MCP servers.** Tests use controlled test servers; Gmail, GitHub and others aren't called.
- **Clients beyond the MCP SDK client and Hermes.** Other harnesses are expected to work because the protocol is unchanged, but none is tested here.
- **Code mode.** It's not in this work.
