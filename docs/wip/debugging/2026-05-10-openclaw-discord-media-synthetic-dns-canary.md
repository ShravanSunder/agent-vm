# 2026-05-10 OpenClaw Discord Media Synthetic DNS Canary

Newest first. This runbook validates the agent-vm synthetic DNS change that
moves Gondolin's shared synthetic AAAA answer from `fc00::1` to
`::ffff:198.18.0.1`.

## Goal

Prove that Discord media no longer fails OpenClaw SSRF validation while
controller, Tool VM SSH, and Discord WebSocket raw TCP mappings still use the
IPv4/per-host path.

## Expected DNS Model

- `controller.vm.host` A resolves to a per-host RFC2544 address such as
  `198.19.x.y`.
- `tool-0.vm.host` A resolves to a per-host RFC2544 address such as
  `198.19.x.y`.
- Discord CDN A resolves to a per-host RFC2544 address such as `198.19.x.y`.
- Shared synthetic AAAA resolves to `::ffff:198.18.0.1`.
- Forced guest IPv6 is not expected to provide general egress. If `curl -6`
  succeeds through IPv4-mapped kernel behavior, record that as a runtime
  observation before loosening docs.

## Gateway VM Checks

Run through `agent-vm controller ssh --zone <zoneId>` or the protected zone
execute-command route.

```bash
getent ahostsv4 controller.vm.host
getent ahostsv6 controller.vm.host
getent ahostsv4 tool-0.vm.host
getent ahostsv6 tool-0.vm.host
getent ahostsv4 cdn.discordapp.com
getent ahostsv6 cdn.discordapp.com
```

Expected:

- IPv4 answers exist for controller, tool, and Discord CDN.
- IPv6 answers show `::ffff:198.18.0.1` or no usable forced-IPv6 path.
- No answer should be `fc00::1`.

## Raw TCP Regression Checks

```bash
curl -sS --max-time 5 http://controller.vm.host:18800/health
curl -4 -sS --max-time 5 http://controller.vm.host:18800/health
curl -6 -sS --max-time 5 http://controller.vm.host:18800/health
```

Expected:

- Normal curl succeeds.
- `curl -4` succeeds.
- `curl -6` may fail; failure is acceptable if normal curl does not stall.
- If `curl -6` succeeds, confirm logs still show IPv4/per-host mapping for
  normal raw TCP use.

## Discord Media Check

Send a Discord image attachment and a Discord voice attachment to the agent.

Check logs:

```bash
agent-vm controller logs --zone <zoneId> | rg -n "blocked URL fetch|failed to download attachment|audio: failed|cdn.discordapp.com|media.discordapp.net"
```

Expected:

- No `blocked URL fetch` for Discord CDN.
- No `resolves to private/internal/special-use IP address` for Discord CDN.
- Media is delivered to the OpenClaw message as a local media payload.

## Discord WebSocket Check

Check logs for reconnect storms:

```bash
agent-vm controller logs --zone <zoneId> | rg -n "gateway.discord.gg|websocket|reconnect|disconnect|heartbeat"
```

Expected:

- No repeated reconnect loop after the synthetic DNS change.
- Agent remains online.

## Rollback

Revert the adapter constant from `::ffff:198.18.0.1` back to `fc00::1`, rebuild
the agent-vm package/image, restart the gateway, and re-run the Discord media
check. Rollback should reproduce the old SSRF failure and prove the canary is
measuring the intended boundary.

## Fallback

If the synthetic DNS fix does not unblock Discord media, use the broader
OpenClaw-side fallback explicitly and document the tradeoff:

```json
{
  "browser": {
    "ssrfPolicy": {
      "allowedHostnames": [
        "cdn.discordapp.com",
        "media.discordapp.net"
      ]
    }
  }
}
```

Tradeoff: `allowedHostnames` skips private-IP checks for matching hostnames. It
is narrower than disabling SSRF globally, but broader than the adapter-level
synthetic DNS fix because every resolved address for those exact hostnames is
trusted. OpenClaw treats `allowedHostnames` as exact matches, not wildcard
patterns; add any additional Discord media hostnames literally as they appear in
logs.
