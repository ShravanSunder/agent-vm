Event 214 Beta Build/Restart Checkpoint
=======================================

Scope:
- Deployment proof target: `../shravan-claw-beta`
- Source branch: `mcp-portal-better-interface`
- Remaining PR-readiness blocker:
  live beta allowed-user Discord/OpenClaw inbound proof.

Fresh beta build evidence:
- Recovered the in-flight beta build after compaction.
- `mise exec -- pnpm build` completed successfully in `../shravan-claw-beta`.
- Docker gateway/OpenClaw and default Tool VM image builds completed.
- Gondolin gateway/OpenClaw and default Tool VM artifact builds completed.
- Cache auto-prune skipped because beta runtime records existed.
- Host observability preparation skipped because no OpenClaw zone opted in.

Fresh beta runtime evidence:
- Pre-restart health was green:
  - controller `/health`: `ok:true`, port `18900`, state `ready`
  - controller zone health: `ok:true`, `/readyz`, HTTP 200, zone `beta`
  - direct ingress `/readyz`: `ready:true`
- Restart command:
  - `mise exec -- pnpm restart`
- Restart anomaly:
  - first stop returned `ok:true`
  - nested stop returned `fetch failed`
  - force-stop cleaned no processes
  - start hit `EADDRINUSE` on `127.0.0.1:18900`
- Follow-up process and status evidence:
  - `lsof` showed the port owner was the beta `agent-vm controller start`
    process.
  - The controller had a live `qemu-system-aarch64` child.
  - post-anomaly controller, zone, and direct ingress health checks were green.
  - controller status reported beta running, readiness running, gateway
    infrastructure running, active leases `0`, ingress port `18891`, booted at
    `2026-07-05T04:37:47.527Z`, VM id
    `c23e498b-2b08-4859-a703-c54307201efb`.

OpenClaw startup evidence after fresh boot:
- Discord channels resolved for the configured beta guild/channel.
- Discord client initialized.
- Discord gateway WebSocket opened.
- The agent-vm OpenClaw plugin loaded from the freshly synced local package
  tarball path.

Blocked proof attempt:
- Attempted the fresh external Discord REST message after the `04:37:47Z` boot.
- The send did not reach Discord because 1Password authorization timed out while
  reading the redacted test sender bot secret.
- No secret value was printed or captured.
- No exported fallback test-token environment variable was present.

Next action:
- Authorize/unlock 1Password for the redacted test sender bot secret, or send a
  manual allowed-user Discord message into the beta channel.
- Then capture all three proof surfaces:
  1. Discord send/readback message id + nonce.
  2. OpenClaw log lines after `2026-07-05T04:37:47Z` showing inbound route,
     trigger/user processing, and delivered reply.
  3. Beta session trajectory showing `messageProvider: discord`,
     finalStatus success, and the requested nonce in the assistant reply.
