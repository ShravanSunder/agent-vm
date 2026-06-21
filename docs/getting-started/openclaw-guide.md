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
      "imageProfile": "openclaw",
      "stateDir": "../state/my-openclaw",
      "zoneFilesDir": "../zone-files/my-openclaw",
      "controlAuth": {
        "mode": "token",
        "secret": "OPENCLAW_GATEWAY_TOKEN"
      },
      "authProfilesByAgent": {
        "shravan": {
          "source": "environment",
          "envVar": "SHRAVAN_AUTH_PROFILES"
        }
      }
    },
    "secrets": {
      "OPENCLAW_GATEWAY_TOKEN": {
        "source": "environment",
        "envVar": "OPENCLAW_GATEWAY_TOKEN",
        "injection": "env",
        "audience": "gateway"
      }
    },
    "egressHosts": [
      { "host": "api.anthropic.com", "audience": "both" },
      { "host": "api.openai.com", "audience": "both" },
      { "host": "auth.openai.com", "audience": "both" },
      { "host": "chatgpt.com", "audience": "both" },
      { "host": "generativelanguage.googleapis.com", "audience": "both" }
    ],
    "websocketBypass": [],
    "defaultToolVmProfile": "standard",
    "agentToolVmProfiles": {}
  }]
}
```

For all system.jsonc fields, see
[reference/configuration/system-json.md](../reference/configuration/system-json.md).

### openclaw.json — OpenClaw Configuration

Controls the OpenClaw agent platform: model selection, sandbox mode, plugin registration.

### OpenClaw Version

`agent-vm init` writes a managed image profile. The installed
`@agent-vm/agent-vm` package includes `managed-images.json`, which selects
managed base image tags. Deployment overlays own extra runtime packages such as
`openclaw@...` or `@openclaw/discord@...`.

OpenClaw transitive runtime dependency fixes are agent-vm-managed release
decisions, not deployment overlay fields. When a managed release carries one,
`agent-vm build` prints it in the generated Dockerfile plan, for example
`overrides undici@8.5.0[managed-images.json]`. Rebuild the managed image and
verify the generated image resolves the managed patch from `openclaw` and any
installed `@openclaw/*` packages.

During `agent-vm build`, the generated Dockerfile is written under the
configured cache directory and the build output prints the resolved base image,
agent-vm OpenClaw plugin package, OpenClaw runtime packages, and the source of
each version. Treat generated Dockerfiles as build output; update package
versions in `package.json` and runtime image additions in the overlay.

For host-side validation, install the same OpenClaw version in the catalog:

```bash
pnpm add -D openclaw@2026.6.8
```

`agent-vm doctor` and `agent-vm validate` use the catalog's `openclaw`
binary, so OpenClaw stays loosely coupled: the catalog chooses the OpenClaw
version for host-side validation, and agent-vm validates against that choice.

### Auth Profiles

Auth profiles (OAuth tokens for model providers) are resolved per agent from
`gateway.authProfilesByAgent` and written to that agent's host-side state
directory before the VM boots. The VM accesses them via VFS mount.

For interactive OpenClaw provider login, configure the profile ids the helper
should refresh:

```jsonc
{
  "gateway": {
    "type": "openclaw",
    "authLogin": {
      "defaultAgent": "main",
      "providers": {
        "openai": {
          "profileIds": [
            "openai-codex:work@example.com",
            "openai-codex:personal@example.com"
          ]
        }
      }
    }
  }
}
```

Then run:

```bash
agent-vm auth openclaw login openai \
  --zone my-openclaw \
  --all-configured-profiles \
  --device-code
```

The helper logs in each configured profile for `gateway.authLogin.defaultAgent`
and verifies the profile ids afterward. Use `--agent <agentId>` with one or more
`--profile-id <profileId>` values for one-off profile creation, and `--dry-run`
to inspect the resolved plan without opening SSH.

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
       | POST /lease { zoneId, agentId, sessionKey, workMountDir }
       v
  Controller
       |
       | Resolves hostWorkMountDir, allocates TCP slot, boots tool VM
       v
  Tool VM (Zone 3 — untrusted)
       | /workspace mounted, no raw secrets, scoped mediated placeholders only
       | SSH access via tool-{slot}.vm.host:22
```

Leases are keyed by `zoneId + agentId`. The controller selects the Tool VM
profile from the zone's `agentToolVmProfiles` map, falling back to
`defaultToolVmProfile`. Idle leases are reaped by `leaseIdleTtl`, with a 100
minute default when no policy is configured.

The lease `workMountDir` is a gateway VM path, not a host path. It must name a
concrete child path under `/zone` or
`/home/openclaw/.openclaw/state/sandboxes`; the controller rejects those roots
themselves as too broad. The controller resolves the selected path to the host
directory that backs the Tool VM's `/workspace` mount.

For internals, see [architecture/openclaw-gateway.md](../architecture/openclaw-gateway.md#tool-vm-leases).

---

## Multi-Agent Scaffold

For a household or small team zone, scaffold named OpenClaw agents up front:

```bash
agent-vm init sunfam --type openclaw --openclaw-agents sun,shravan,alevtina
```

This writes `agents.list` entries with `/zone/agents/<id>` workspaces and
identity-name stubs. Channel bindings, Discord allowlists, and per-agent auth
profiles stay deployment-owned because those depend on real account and guild
IDs.

---

## Web Fetch With Gondolin

Gondolin uses synthetic DNS for mediated egress and TCP host mapping. Current
agent-vm scaffolds OpenClaw `web_fetch` with fake-IP SSRF policy so OpenClaw
trusts the mediated boundary:

```json
{
  "tools": {
    "web": {
      "fetch": {
        "ssrfPolicy": {
          "allowRfc2544BenchmarkRange": true,
          "allowIpv6UniqueLocalRange": true
        }
      }
    }
  }
}
```

This only passes OpenClaw's SSRF check. Gondolin still enforces
`zones[].egressHosts`, so arbitrary public websites are not reachable unless
the deployment allows them or routes `web_fetch` through a provider such as
Firecrawl/Jina.

For gateway/tool TCP mappings, agent-vm uses RFC2544 synthetic IPv4 addresses
and an IPv4-mapped RFC2544 synthetic AAAA answer (`::ffff:198.18.0.1`). The
AAAA answer prevents OpenClaw from rejecting a host only because DNS returned a
fake IPv6 answer. It does not mean the guest has general IPv6 egress.

The scaffold also includes `tools.sandbox.tools.alsoAllow` for `web_search`,
`web_fetch`, `message`, and `group:plugins` so sandboxed sessions can see web
tools when the deployment later configures a search or fetch provider, can
explicitly send channel replies when OpenClaw uses `message_tool_only` group
reply delivery, and can see optional plugin-owned tools such as MCP Portal's
`mcp_portal_*` tools.

---

## Channels

Discord is a deployment recipe, not an agent-vm framework default. To enable
Discord, configure `channels.discord` in OpenClaw config, then add
`DISCORD_BOT_TOKEN`, Discord hosts, and the Discord gateway websocket bypass to
`system.jsonc`. Managed OpenClaw images install `@openclaw/discord`
automatically when `channels.discord.enabled` is true.

```json
{
  "secrets": {
    "DISCORD_BOT_TOKEN": {
      "source": "1password",
      "ref": "op://agent-vm/my-openclaw-discord/bot-token",
      "injection": "env",
      "audience": "gateway"
    }
  },
  "egressHosts": [
    { "host": "discord.com", "audience": "both" },
    { "host": "*.discord.com", "audience": "both" },
    { "host": "discord.gg", "audience": "both" },
    { "host": "*.discord.gg", "audience": "both" },
    { "host": "discord.media", "audience": "both" },
    { "host": "*.discord.media", "audience": "both" },
    { "host": "discordapp.com", "audience": "both" },
    { "host": "*.discordapp.com", "audience": "both" },
    { "host": "*.discordapp.net", "audience": "both" }
  ],
  "websocketBypass": [
    "gateway.discord.gg:443",
    "gateway-us-east1-b.discord.gg:443",
    "gateway-us-east1-c.discord.gg:443",
    "gateway-us-east1-d.discord.gg:443"
  ]
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

Use controller logs for both the gateway boot log and the OpenClaw runtime log
tail. The gateway VM writes these logs under `/agent-vm/logs`, backed by
`<runtimeDir>/zones/<zone>/logs` on the host, so they survive gateway restarts
without entering normal zone backups:

```bash
agent-vm controller logs --zone my-openclaw
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Doctor reports `openclaw-agent-auth-profile-*` failing | Auth material missing | Check `gateway.authProfilesByAgent` in system.jsonc or refresh configured OpenClaw profiles with `agent-vm auth openclaw login <provider> --zone <id> --all-configured-profiles` |
| Codex OAuth expired | Token expires ~10 days | Re-auth: `agent-vm auth codex-harness --zone <id> --agent <agentId>` |
| Tool calls fail | Lease creation failing | Check `defaultToolVmProfile` exists, TCP pool has free slots |
| Discord not connecting | Deployment channel config incomplete | Add Discord plugin/config, `DISCORD_BOT_TOKEN`, broad Discord egress hosts, and exact Discord Gateway `websocketBypass` hosts |
| Can't reach external API | Host not allowlisted | Add to `zones[].egressHosts` with the needed audience |
