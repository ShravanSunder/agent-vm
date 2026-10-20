# Networking research: overlap, platform fit and redundancy

Research cutoff: 2026-10-15, including the follow-up platform investigation.
**No network or topology has been adopted.** Platform documents establish
capabilities, not compatibility with the owner's deployed services. The
[evidence ledger](networking-evidence-ledger.md) records searches and source
coverage; the topology choice is pending owner input.

## Separate the layers

| Technology | Its job | Relationship to this portal |
| --- | --- | --- |
| Tailscale | Private device/service network using WireGuard; prefers direct peer paths and has relay paths | Candidate shared private network |
| Cloudflare Mesh | Private participants and routed resources connected through Cloudflare; formerly WARP Connector | Alternative candidate for the same connectivity need |
| Cloudflare Tunnel | `cloudflared` initiates outbound connections so configured origins/routes can be reached | Connects resources; does not give every host a general Mesh participant identity |
| Cloudflare Access | Application identity and access policy | Can authenticate MCP ingress; does not establish the whole private network by itself |
| Cloudflare Gateway | Network traffic policy | Controls admitted traffic; separate from per-capability portal permissions |
| Workers VPC | Worker access to private network destinations through bindings | Connects a Worker-hosted portal to private resource services |
| Cloudflare MCP Portals | Managed MCP aggregation/authentication and discovery features | Optional outer aggregator; distinct from our Tool Portal library |
| Our Tool Portal | Caller/profile/capability authorization, exact approvals and normalized results | Must enforce its policy regardless of network reachability |

The substantial Tailscale overlap is **Cloudflare Mesh**. Access is a different
layer. A decision to use Mesh may remove the need for Tailscale for these routes;
running both does not create automatic failover between them.

## Two candidate paths; neither selected

```text
Cloudflare-connected candidate

  laptop / Mac / Linux VM with One Client / Mesh
                    |
             Cloudflare private network
                    |
        +-----------+--------------------+
        |                                |
  Mesh participants             Tunnel-routed MCP origins
        ^                                ^
        +---- Worker VPC Network --------+
              binding: cf1:network

  Fly / Railway placement still requires a proven attachment method.
```

```text
Tailscale-connected candidate

  laptop / Mac / supported cloud nodes
                    |
           one tailnet, grants/ACLs
                    |
         private MCP resource services

  A Worker needs an explicit supported bridge/integration.
  It does not automatically join this tailnet.
```

Cloudflare Mesh sends participant traffic through Cloudflare; its node profile
uses MASQUE for the documented routing/HA features. Tailscale prefers direct
WireGuard connections and can relay while retaining end-to-end encryption.
This difference affects path, trust and performance; sharing an underlying
protocol does not make two independently enrolled networks one network.
Sources: [Mesh concepts](https://developers.cloudflare.com/mesh/concepts/),
[One Client protocol settings](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/settings/),
[Tailscale overview](https://tailscale.com/docs/concepts/what-is-tailscale),
[Tailscale connection types](https://tailscale.com/docs/reference/connection-types).

Tunnel's outbound initiation does not mean one-way application data: requests
and responses flow both ways over the established connection. Its configured
origin/route publication differs from full participant-to-participant routing.
Source: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

## What a Worker can reach

Workers VPC has two materially different bindings:

- **VPC Service:** one registered destination host/port through a Tunnel. The
  fetch URL's host supplies Host/SNI rather than selecting another origin;
  its port does not override the registered destination.
- **VPC Network:** network destinations, either through a particular Tunnel
  or the account-wide `network_id: "cf1:network"`. The account network can reach
  Mesh nodes/client devices and admitted Tunnel/Mesh routes. The destination
  URL matters for network routing.

A Worker uses a binding's `fetch` for HTTP MCP. This is outbound private access;
it is not an ordinary OS VPN interface. A private route need not have a public
hostname. Origin-leg TLS still matters: a Tunnel-to-origin HTTP hop is plaintext
on that leg, while HTTPS protects it and validates certificates by default.
Sources: [VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/),
[VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/),
[API](https://developers.cloudflare.com/workers-vpc/api/),
[Mesh example](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/),
[Tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/).

These documents establish the routing categories. They do not prove our MCP
streaming, cancellation, metadata, long calls, OAuth or Durable Object execution
through those bindings. Standard Worker limits continue to apply.

## Fly and Railway: attachment options now established

| Platform / path | Established evidence | Limits / remaining proof |
| --- | --- | --- |
| Ordinary Linux host / VM | Mesh container guide requires `NET_ADMIN`, `NET_RAW`, `/dev/net/tun`; subnet routing also needs forwarding setup and persistent client state | Whether each actual host grants those requirements |
| Fly / Tailscale | Tailscale publishes an explicit Fly deployment example that starts its daemon and joins the tailnet | Vendor-documented integration, not a test of the owner's deployment or a guarantee about Mesh prerequisites |
| Fly / Cloudflare | Fly supplies its own private 6PN network; a connector with access to an origin can publish that origin | No decisive official Machine `NET_ADMIN`/TUN contract or Mesh-on-Fly support statement found; generic connector composition still needs proof |
| Railway / Tailscale inbound | Railway documents a Tailscale Forwarder: selected tailnet-machine ports forward to Railway-private origins | Service access, not general outbound tailnet routing by every app |
| Railway / Tailscale outbound | Railway's Railtail guide documents application-proxy egress toward a tailnet-connected AWS subnet router | Demonstrated for RDS; other destinations and MCP behavior need separate proof |
| Railway / Cloudflare | A same-environment `cloudflared` can use the host resolver; Railway services resolve their private origin names there | Source-supported composition inference; not a tested Railway/Cloudflare deployment |
| Railway / full Mesh | Mesh needs device/network privileges; Railway's bridge guide reports no privilege escalation | Full Mesh participant is unproven, with a documented privilege obstacle; no no-TUN Mesh mode established |

Sources: [Mesh in containers](https://developers.cloudflare.com/mesh/guides/run-mesh-in-containers/),
[Fly private networking](https://fly.io/docs/networking/private-networking/),
[Tailscale on Fly](https://tailscale.com/docs/install/cloud/flydotio),
[Railway Forwarder](https://docs.railway.com/guides/set-up-a-tailscale-forwarder),
[Railway outbound bridge](https://docs.railway.com/guides/bridge-railway-to-rds-with-tailscale),
[Railway networking](https://docs.railway.com/networking/private-networking/how-it-works),
[Cloudflare private hostname routing](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/).

The earlier Railway runtime extraction was navigation only, and the guessed Fly
blueprint returned 404. Those nulls were not compatibility evidence. The later
primary pages above establish specific alternatives without establishing a full
Mesh participant. Mesh setup explicitly excludes proxy-only and DNS-only modes.
Source: [Mesh setup](https://developers.cloudflare.com/mesh/get-started/).

### Selected inbound services on Railway

```text
tailnet client
      |  forwarder name + mapped port
      v
Railway Tailscale Forwarder
      |  same-environment private connection
      v
Railway MCP origin
```

The official Forwarder guide supports multiple port mappings, MagicDNS and an
optional HTTPS terminator. The client uses the forwarder's name; Railway's
internal DNS is resolved inside the environment. Its attached volume retains
Tailscale identity across restarts. It replaces the old subnet-router template,
whose shared Railway address range conflicted across environments. This is a
documented path for reaching an HTTP MCP listener, not MCP interoperability
proof or a blanket network interface for the origin process.

Railway disallows replicas on volume-attached services and documents redeploy
downtime for those services. Consequently the documented stateful Forwarder
does not become HA by increasing its replica count. Separate forwarders would
need separate identities and an explicit service/failover arrangement.
Source: [Railway volume caveats](https://docs.railway.com/volumes/reference).

For outbound userspace Tailscale, applications must use the SOCKS/HTTP proxy.
The Docker egress-target variables `TS_TAILNET_TARGET_IP` and
`TS_TAILNET_TARGET_FQDN` explicitly do not support `TS_USERSPACE`; they are not a
no-TUN shortcut. Preserve Railway runtime DNS when configuring a connector.
Sources: [userspace mode](https://tailscale.com/docs/concepts/userspace-networking),
[Docker parameters](https://tailscale.com/docs/features/containers/docker/docker-params).

### Fly lifecycle and origin routing

Fly's direct private access and Flycast are different routes. Flycast supplies
private Fly Proxy service routing; a direct 6PN connection is not implicitly a
Proxy request. A stopped private-only origin is not awakened by an arbitrary
overlay packet. The autostart path requires the documented Fly Proxy/Flycast
service configuration; its minimum-running count applies to the primary
region. For an always-connected connector, keep its host running or explicitly
design the wake-up path. Sources: [service routing](https://docs.fly.io/networking/app-services),
[autostop/autostart](https://docs.fly.io/launch/autostop-autostart).

Fly volumes are local to a server, attach one-to-one to Machines and do not
replicate automatically. A second Machine does not share the first's identity,
database or approval state. Source: [Fly volumes](https://docs.fly.io/volumes/overview).

### Existing portal listener boundary still applies

An internal platform address is not permission to bind our standalone plaintext
Node listener to every interface. Its current contract keeps plaintext on
loopback behind confidential termination. A separate Railway connector needs
a compliant reachable HTTPS origin/terminator, or a proven same-host protected
composition. The Forwarder guide's generic listen-address instruction is not a
waiver of that portal rule. A connector on the Mac can reach a loopback origin;
a connector on another host cannot reach that same loopback address.
See [Specification R10/C5](../../specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md)
and the baseline's standalone listener source links.

For each platform the receiving agent should distinguish:

```text
Full network participant       Service behind a connector
------------------------       --------------------------
can initiate private flows     connector reaches its MCP origin
has a participant identity     only configured service/routes exposed
needs platform support         needs proven origin reachability

Both can serve the product, but only the first meets a requirement
for that workload to initiate general private-network connections.
```

Do not assume Fly's network, Railway's network and a tailnet are joined because
they all use WireGuard. Enrollment, addressing, routes, DNS and policy remain
separate. Likewise a public Railway/Fly hostname does not by itself satisfy the
owner's shared-private-network outcome.

## “Redundant” has two meanings

**Replacement:** choosing Cloudflare Mesh could make Tailscale unnecessary for
the overlapping private routes. The platform and Worker integration constraints
must be resolved before recommending that choice.

**Availability:** identify the exact failure being covered:

```text
connector unavailable → another connector reaching the SAME resources
service unavailable   → another valid service replica and service routing
host asleep           → resource available elsewhere, or explicit unavailable
state owner lost      → one recovered durable authority, fenced old owner
reply lost            → operation lookup / honest ambiguity; no blind replay
```

Cloudflare Mesh's documented HA is active/passive, with at least two Linux
hosts on the same subnet and matching route configuration. It protects CIDR
routes. Inbound traffic to the routed subnet can fail over; outbound routing
through the gateway does not automatically fail over. Replica Mesh IPs are
individual identities, not a portable service address. It does not replicate
Mac apps, their data, portal approvals or outstanding effects.
Source: [Mesh high availability](https://developers.cloudflare.com/mesh/features/high-availability/).

Tunnel replicas now have a verified documentation basis: multiple `cloudflared`
instances share one tunnel; each creates four Cloudflare connections. Requests
normally go to the geographically closest replica, with other replicas tried
on connection failure. This is not origin-health-aware service balancing or a
promise of round-robin/session affinity. Every eligible replica must be able to
reach the intended origin for this design to provide useful failover. A Tunnel
can be healthy while its origin is unreachable. Sources:
[Tunnel availability](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/),
[Tunnel health scope](https://developers.cloudflare.com/tunnel/monitoring/index.md).

Tailscale subnet HA requires identical approved prefixes on multiple eligible
routers. Default active/passive selection uses the oldest eligible connector;
failure detection is not instantaneous. A broader prefix is not a fallback
when all routers for a more-specific prefix disappear. This does not apply
automatically to two separately named Railway Forwarders. Sources:
[HA setup](https://tailscale.com/docs/how-to/set-up-high-availability),
[route selection](https://tailscale.com/docs/features/route-selection).

Two separate machines exposing different tools are distinct upstreams, not
interchangeable replicas. Neither connector mechanism establishes survival of
existing MCP streams, application state replication or exactly-once effects.
On a broken stream, reconnect and inspect the same durable operation; do not
replay uncertain work merely because another network path is available. An
automatic public fallback or cross-overlay retry has not been designed,
authorized or tested.

## MCP SDK and local connector evidence

Local source inspected:
[`upstream-mcp-client-runtime.ts`](../../../packages/mcp-portal/src/upstream-mcp-client-runtime.ts),
remote config at lines 37–42 and transport construction at 338–342. It mixes
HTTP and stdio imports and passes `requestInit`, without a host fetch binding.

Published `@modelcontextprotocol/client@2.0.0` declarations were inspected from
the npm artifact. `StreamableHTTPClientTransportOptions` includes
`fetch?: FetchLike`; its implementation uses the custom fetch in transport/auth
paths. Source locators: `sdk-v2-index.d.mts:3020–3054` and
`sdk-v2-index.mjs` in the capture directory below.
[Published package metadata](https://registry.npmjs.org/@modelcontextprotocol/client/2.0.0)
identifies that exact inspected version; this is not a claim that it is the
latest version or already installed here.

The draft therefore needs a host-supplied HTTP dispatch boundary, with explicit
resource and OAuth issuer/token routing. A fixed VPC Service binding must not
silently route public issuer URLs to the private MCP origin or forward resource
credentials to an issuer/redirect. DeepWiki suggested a manager-level hook, but
that exact-version API was not established; use the inspected transport hook as
the grounded starting point. End-to-end compatibility remains unproved.

## Evidence provenance and continuation

Perplexity ask used official-domain filters; Tavily CLI advanced extraction
captured the primary pages. The standard web tool was unavailable. Firecrawl
callables were not exposed. No account, network configuration, credential or
runtime deployment was changed for this research.

Original captures are temporary, under
`/private/tmp/2026-10-portable-tool-portal-design/`:

- `tavily-vpc-extract.json`, `tavily-mesh-extract.json`
- `tavily-mesh-tailscale.json`, `tavily-mesh-tech-ha.json`
- `tavily-mesh-ha-containers.json`, `tavily-host-network-capabilities.json`
- `tavily-network-redundancy-followup.json`, `tavily-railway-forwarder-lead.json`, `tavily-fly-followup.json`
- `sdk-v2-package.json`, `sdk-client-2.0.0.tgz`, `sdk-v2-index.d.mts`, `sdk-v2-index.mjs`

These paths may expire. This note preserves the useful findings and live primary
URLs so the next agent need not treat temporary files as durable proof. The
[handoff](handoff.md) owns current session identities, scope, review state and
the receiving task. Collect the owner's actual deployment information, resolve
the platform gaps, then draw the exact ingress/egress and failure paths before
proposing a topology. Stay in design mode.
