# Networking follow-up evidence ledger

Mode: design input. Cutoff: 2026-10-15. Written in the owner-requested WIP
handoff directory instead of the research skill's default scratch directory.
The [research note](networking-research.md) carries the reader-facing synthesis.

## Questions and decision boundary

1. How can Fly and Railway attach private MCP services to a fleet network?
2. Which options provide selected-service access versus general participation?
3. What does connector failover preserve, and what still needs application or
   durable-operation recovery?

Network selection belongs to the owner. This investigation does not enroll
devices, configure a tunnel, change credentials, deploy a service, or implement
the portable host. A documentation-supported composition is not runtime proof.

## Source-class coverage

| Class | Coverage and reason |
| --- | --- |
| Current local code / contracts | Governing three-document design and standalone MCP connector/listener boundary re-anchored; no product edits |
| Current platform docs | Fly, Railway, Tailscale and Cloudflare official documentation selected because runtime privileges, routing and replica behavior determine feasibility |
| Specific documents | Railway Forwarder, outbound bridge, volume caveats; Fly autostart/volumes/service routing; Mesh container/setup; Tunnel availability/private hostnames; Tailscale userspace/HA/route selection |
| OSS source structure | Not needed for platform contract claims; existing SDK custom-fetch artifact evidence retained separately |
| Memory / sessions | Existing trace supplies owner intent; no historical network setup treated as current enrollment evidence |
| Saved Reader research | Not selected; no user-saved item identified as a dependency |
| UI / live runtime | Not selected; no accounts, deployments or new network enrollment authorized; documentation cannot establish live setup |

Two bounded native workers gathered platform evidence: Sol 6.1/high for Railway
and Luna/xhigh for Fly, per the owner's requested model selection. Both returned
without product/trace writes. This Lead inspected the decisive public sources
or primary captures before using their findings. No additional independent
research reviewer was commissioned: the accepted claims are narrow primary-doc
summaries, with deployment support and composition inferences explicitly limited.

## Search record and nulls

Perplexity official-domain searches/asks located sources; Tavily advanced
extraction and workers' direct HTTPS Markdown reads supplied primary content.

Verbatim search strings:

- `site:docs.railway.com runtime security capabilities privileged containers NET_ADMIN tun device`
- `site:docs.railway.com cloudflared private networking tailscale`
- `site:tailscale.com docs userspace networking TS_DEST_IP TS_SERVE_CONFIG TS_STATE_DIR containerboot`
- `site:docs.railway.com "cloudflared" "internal" OR "privileged" OR "NET_ADMIN" OR "tun"`
- `site:developers.cloudflare.com cloudflared tunnel requirements outbound connections 7844 replicas same tunnel origin service URL hostname`
- `site:docs.railway.com volumes "replicas" "Limitations" private networking load balancing`
- `site:docs.railway.com "Volumes" "Replicas cannot"`
- `site:developers.cloudflare.com/cloudflare-one "private hostname" "cloudflared" DNS resolver`
- `site:developers.cloudflare.com/mesh "userspace" OR "no TUN" OR "proxy mode"`
- `site:fly.io/docs /dev/net/tun Fly Machines NET_ADMIN NET_RAW privileged`
- `site:tailscale.com/kb Fly.io Machines Tailscale official deployment`
- `site:fly.io/docs Tailscale Fly Machines example`
- `site:fly.io/docs auto_stop_machines auto_start_machines always on Fly Machines`
- `site:fly.io/docs volumes one Machine at a time replication volumes Fly Machines`
- `site:fly.io/docs 6PN WireGuard external peer private networking DNS app Machines`
- `site:tailscale.com/docs "High availability" "subnet routers" primary failover`
- `site:developers.cloudflare.com "tunnel health" "internal services"`

Root ask topics, recorded as query scope: Tunnel replica selection versus origin
health and session continuity; Tailscale relay fallback versus subnet HA versus
application failover; userspace proxy direction and inbound service exposure.
Generated answers were discovery, not accepted as a substitute for primary docs.

Nulls and limitations:

- The guessed Fly Tailscale blueprint URL was a 404; the real Tailscale vendor
  integration guide was subsequently found. No unsupported-platform conclusion
  follows from the bad URL.
- No decisive official Fly Machine capability/TUN contract found. A vendor
  Tailscale example does not certify Cloudflare Mesh on Fly.
- No Railway grant for the Mesh-required devices/capabilities established.
  Its outbound-bridge guide reports a privilege-escalation restriction.
- No supported no-TUN/proxy-only Mesh mode established; Mesh setup explicitly
  excludes proxy-only/DNS-only node modes.
- Precise Railway-private origin replica balancing/session affinity remains
  unverified. Public load balancing does not establish that private path.
- Standard web-tool routing failed for workers; they used direct primary reads.
  This Lead used the existing isolated Tavily CLI; no project dependencies or
  accounts were installed/configured.

## Finding dispositions

| Finding | State / evidence class | Primary basis / limit |
| --- | --- | --- |
| Railway selected-service ingress through Tailscale | Accepted / cited source summary | [Forwarder guide](https://docs.railway.com/guides/set-up-a-tailscale-forwarder); actual MCP path untested |
| Railway application-proxy egress through Tailscale | Accepted / cited source summary | [Railtail/RDS guide](https://docs.railway.com/guides/bridge-railway-to-rds-with-tailscale); other destinations not established |
| Railway Cloudflare private hostname composition | Investigated / inference | [Railway private DNS](https://docs.railway.com/networking/private-networking/how-it-works) plus [cloudflared host resolver](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/); egress/listener/runtime proof missing |
| Full Mesh in Railway/Fly | Unresolved / explicit gap | [Mesh prerequisites](https://developers.cloudflare.com/mesh/guides/run-mesh-in-containers/); matching platform device/capability proof missing |
| Tailscale Fly deployment example | Accepted / cited source summary | [Tailscale on Fly](https://tailscale.com/docs/install/cloud/flydotio), validated by vendor Dec 4, 2025; owner deployment untested |
| Fly automatic wake-up on arbitrary private packets | Refuted / cited source summary | [Autostart](https://docs.fly.io/launch/autostop-autostart); private Proxy/Flycast configuration matters |
| Fly volumes automatically replicate | Refuted / cited source summary | [Volumes](https://docs.fly.io/volumes/overview); per-Machine storage, application owns replication |
| Stateful Railway Forwarder scales into HA by increasing replicas | Refuted / inference from primary constraints | Forwarder retains volume identity; [Railway volumes](https://docs.railway.com/volumes/reference) prohibit service replicas with volumes |
| Tunnel replica health guarantees origin health | Refuted / cited source summary | [Health scope](https://developers.cloudflare.com/tunnel/monitoring/index.md) distinguishes connector connectivity from origin access |
| Tunnel replicas provide connector failover | Accepted / cited source summary | [Availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/); no origin-aware balancing or stream-state guarantee inferred |
| Identical approved Tailscale subnet routes can fail over | Accepted / cited source summary | [HA setup](https://tailscale.com/docs/how-to/set-up-high-availability), [route selection](https://tailscale.com/docs/features/route-selection); not a generic virtual IP for named Forwarders |
| Two overlays automatically supply outage redundancy | Refuted / structural inference | Independent routes/control planes do not define selection, health, credential or application recovery; no such mechanism exists in this design |

## Synthesis and next owner

There are documented ways to expose selected Railway/Fly services privately;
full Mesh in every hosted runtime is not an established requirement or supported
fact. Connector availability, service identity, backend replication and durable
operation authority must remain separate. A replacement stream must reuse the
known operation identity and preserve ambiguity about prior effects.

Owner response after the comparison: network selection is not known yet and
needs discussion. Both candidates remain open. This is an explicit direction to
continue shared understanding, not a reason to block the ready handoff or infer
adoption of the recommended Cloudflare path.

Return token: `program-design-gap` — source-characterized attachment choices
are available; the chosen deployment path and its actual runtime proof remain
open. This does not block packaging the handoff and does not admit implementation.
