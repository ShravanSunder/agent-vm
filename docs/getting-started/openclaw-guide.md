# OpenClaw Gateway Guide

[Overview](../README.md) > Getting Started > OpenClaw Gateway

How to configure and run agent-vm in OpenClaw Gateway — interactive chat agent with sandboxed tool execution.

---

## What OpenClaw Gateway Does

A long-running gateway VM hosts the OpenClaw interactive agent. Deployments add
their own channels, such as Discord or WhatsApp. When the agent needs to execute
code, it requests a Tool VM lease from the controller. Tool VMs are ephemeral —
created on demand, destroyed after use.

For the full OpenClaw architecture, see [architecture/openclaw-gateway.md](../architecture/openclaw-gateway.md).

---

## Configuration

### system.jsonc — Define an OpenClaw Zone

```json
{
  "zones": [{
    "id": "my-openclaw",
    "gateway": {
      "type": "openclaw",
      "memory": "2G",
      "cpus": 2,
      "port": 18791,
      "config": "./my-openclaw/openclaw.json",
      "stateDir": "../state/my-openclaw",
      "zoneFilesDir": "../zone-files/my-openclaw",
      "authProfilesRef": {
        "source": "1password",
        "ref": "op://agent-vm/auth-profiles/credential"
      }
    },
    "secrets": {
      "OPENCLAW_GATEWAY_TOKEN": {
        "source": "1password",
        "ref": "op://agent-vm/openclaw-token/credential",
        "injection": "env"
      }
    },
    "allowedHosts": [
      "api.anthropic.com",
      "api.openai.com",
      "auth.openai.com",
      "chatgpt.com",
      "generativelanguage.googleapis.com"
    ],
    "websocketBypass": [],
    "defaultToolVmProfile": "standard"
  }]
}
```

For all system.jsonc fields, see
[reference/configuration/system-json.md](../reference/configuration/system-json.md).

### openclaw.json — OpenClaw Configuration

Controls the OpenClaw agent platform: model selection, sandbox mode, plugin registration.

### OpenClaw Version

`agent-vm init` writes a gateway Dockerfile with a tested OpenClaw version, for example:

```dockerfile
RUN pnpm add -g openclaw@2026.4.24
```

That pin is a scaffold default, not a host-side package lock. After scaffold, the catalog repo owns `vm-images/gateways/openclaw/Dockerfile`; edit that line in the catalog when you want to try or pin a different OpenClaw release.

For host-side validation, install the same OpenClaw version in the catalog:

```bash
pnpm add -D openclaw@2026.4.24
```

`agent-vm doctor` and `agent-vm validate` use the catalog's `openclaw`
binary, so OpenClaw stays loosely coupled: the catalog chooses the OpenClaw
version, and agent-vm validates against that choice.

### Auth Profiles

Auth profiles (OAuth tokens for model providers) are resolved from 1Password and written to the host-side state directory before the VM boots. The VM accesses them via VFS mount.

See [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md#auth-profiles) for the full flow.

---

## Starting the Gateway

```bash
agent-vm controller start --zone my-openclaw
```

The controller:
1. Resolves secrets (1Password / env)
2. Builds the gateway VM image (cached by fingerprint)
3. Writes effective config + auth profiles to state dir
4. Boots the gateway VM (long-running)
5. Starts the OpenClaw process inside the VM
6. Waits for health check, enables ingress

The gateway stays running until you stop it or the controller shuts down.

---

## Tool VMs and Leases

When the agent needs to run code, OpenClaw requests a tool VM lease from the controller:

```
  OpenClaw (inside gateway VM)
       |
       | POST /lease { scopeKey, zoneId, workMountDir }
       v
  Controller
       |
       | Resolves hostWorkMountDir, allocates TCP slot, boots tool VM
       v
  Tool VM (Zone 3 — untrusted)
       | /work mounted, no secrets, no network
       | SSH access via tool-{slot}.vm.host:22
```

Leases are scoped by `scopeKey` for reuse within the same conversation. For
`agent:<agentId>` scopes, the controller selects the Tool VM profile from the
zone's `agentToolVmProfiles` map, falling back to `defaultToolVmProfile`. Idle
leases are reaped by `leaseIdleTtl`, with a 30 minute default when no policy is
configured.

The lease `workMountDir` is a gateway VM path, not a host path. It must name a
concrete child path under `/zone` or
`/home/openclaw/.openclaw/state/sandboxes`; the roots themselves are rejected as
too broad. The controller resolves the selected path to the host directory that
backs the Tool VM's `/work` mount.

For internals, see [architecture/openclaw-gateway.md](../architecture/openclaw-gateway.md#tool-vm-leases).

---

## Channels

Discord is a deployment recipe, not an agent-vm framework default. To enable
Discord, configure it in your deployment Dockerfile and OpenClaw config, then
add `DISCORD_BOT_TOKEN`, Discord hosts, and the Discord gateway websocket bypass
to `system.jsonc`.

```json
{
  "secrets": {
    "DISCORD_BOT_TOKEN": {
      "source": "1password",
      "ref": "op://agent-vm/my-openclaw-discord/bot-token",
      "injection": "env"
    }
  },
  "allowedHosts": ["discord.com", "cdn.discordapp.com"],
  "websocketBypass": ["gateway.discord.gg:443"]
}
```

Other channels follow the same deployment-owned pattern: install or bake the
plugin, enable it in `openclaw.json`, add secrets, allow required HTTP hosts,
and add websocket bypass hosts only when the channel needs raw WebSocket access.

---

## SSH Access

```bash
agent-vm controller ssh --zone my-openclaw
```

Opens an SSH session into the gateway VM for debugging.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Gateway won't start | Auth profiles missing | Check `authProfilesRef` in system.jsonc |
| Codex OAuth expired | Token expires ~10 days | Re-auth: `agent-vm auth-interactive codex --zone <id>` |
| Tool calls fail | Lease creation failing | Check `defaultToolVmProfile` exists, TCP pool has free slots |
| Discord not connecting | Deployment channel config incomplete | Add Discord plugin/config, `DISCORD_BOT_TOKEN`, Discord hosts, and `gateway.discord.gg:443` |
| Can't reach external API | Host not allowlisted | Add to `zones[].allowedHosts` |
