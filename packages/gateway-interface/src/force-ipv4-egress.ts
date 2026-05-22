/**
 * Canonical NODE_OPTIONS value for forcing IPv4-preference egress
 * in agent-vm VMs.
 *
 * Background: Gondolin's synthetic DNS (when tcpHosts is enabled)
 * returns a per-host IPv4 (reverse-lookable) and a single shared
 * IPv4-mapped IPv6 (::ffff:198.18.0.1, NOT reverse-lookable). Node
 * 20+'s fetch (via undici, autoSelectFamily: true) races both
 * families; when the IPv6 race wins (~5-20% under sequential load),
 * gondolin cannot route it and the request fails with a non-JSON
 * 400 (HTTP) or 403 (TLS). The two flags below stop the race:
 *
 *   --dns-result-order=ipv4first       changes dns.lookup() so
 *                                      IPv4 addresses are listed
 *                                      before IPv6.
 *
 *   --no-network-family-autoselection  disables Node's Happy
 *                                      Eyeballs entirely. This is
 *                                      the load-bearing flag —
 *                                      --dns-result-order alone
 *                                      doesn't prevent Node from
 *                                      racing both families if
 *                                      IPv4 is slow.
 *
 * Composition: NODE_OPTIONS is whitespace-separated. To add more
 * flags downstream, append rather than replace. Example:
 *
 *   NODE_OPTIONS: `${FORCE_IPV4_EGRESS_NODE_OPTIONS} --inspect`
 *
 * Reference: see `shravan-claw@0ddf5f2:docs/wip/debugging/
 * 2026-05-21-lease-keepalive-400-and-discord-403-ipv6-race.md`
 * for the full root-cause analysis. Node-side flag references:
 * https://github.com/nodejs/node/issues/54359 (autoSelectFamily
 * revert recommendation by the Node core team).
 */
export const FORCE_IPV4_EGRESS_NODE_OPTIONS =
	'--dns-result-order=ipv4first --no-network-family-autoselection';
