# Tool Portal: defects found and deferred during the decomposition

These are defects in today's behavior, found while porting it. The new code reproduces each one exactly ("same behaviour"). Fixing them belongs after cutover (S4), as an owner-visible change.

| Found | Defect | Today's anchors | Kept as | Who would notice |
| --- | --- | --- | --- | --- |
| 2026-10-21, S3d (#245, Bugbot) | A standalone artifact read can return no media type, but the Portal SDK's high-level `artifacts.read` requires one, so the SDK call fails for such an artifact | Portal SDK `index.ts:105–113`; old MCP projection returns `mimeType` undefined; identical at `d25be046` | today's behavior, pinned by an old-versus-new parity test | a Portal SDK caller reading an artifact that has no media type |

Fixed instead of deferred, because the new code would otherwise break a published contract:

| Found | Defect | Fix |
| --- | --- | --- |
| 2026-10-21, S3d | Today's standalone approval coordinator emits a 32-hex `challengeId`, while the Portal SDK schema requires a UUID | the new Node host formats a deterministic UUID from the same fingerprint; token bytes are unchanged |

## Order-sensitive assertion on concurrent effects (test defect)

`packages/tool-engine/src/mcp-gateway/approval-carriers.unit.test.ts:73`
(from S3a, #241) compares the order of upstream effects with the order of the
calls in the batch. The calls in one batch run concurrently by design, so under
load they can finish in either order: `[43, 42]` instead of `[42, 43]`. Seen
once on 2026-10-21 in a loaded Implementer run at b8c80560; it passed 6/6 when
rerun. **Fix in its own layer:** compare the effects' arguments as a multiset,
and keep the exactly-once count and the receipt assertion. This doesn't weaken
proof, because order isn't a requirement. Not changed during the structure
pass.

## Approved managed MCP calls are refused at the provider (pre-existing product defect)

In agent-vm's managed path, an MCP tool that requires approval is refused even
after the controller approves it. `createToolPortalMcpProjection`
(`packages/config-contracts/src/tool-portal-config.ts:1077`) copies the profile's
`calls` unchanged into the provider's view. The managed wrapper
(`packages/tool-portal/src/mcp-provider-backend/tool-portal-mcp-provider-backend-port.ts:153–175`)
passes the operation id but no approval grant. The provider's
`preflightCallDecision` (`packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:547–568`)
then answers `approval_required` for every requiresApproval tool; its unit test
(:737) pins that. Existing approval tests use factory doubles, so they never hit it.

Confirmed on 2026-10-21 by S4a's Implementer with the actual old factory,
connector and a controlled MCP server: an unprotected `read_thing` ran once; a
grant-carrying `write_thing` was refused `approval_required` with no effect.
Source is identical at `08f9e426` and #245.

**Not changed in S4a.** The cutover keeps today's behavior, and its tests don't
pin the defect as expected. Fixing it changes behavior: the provider would have
to accept a controller-dispatched approval for that exact call. **Owner decision.**
