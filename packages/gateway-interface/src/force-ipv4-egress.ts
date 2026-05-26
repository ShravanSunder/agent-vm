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

const FORCE_IPV4_EGRESS_NODE_OPTION_FLAGS = FORCE_IPV4_EGRESS_NODE_OPTIONS.split(/\s+/u);

/**
 * Compose the forced IPv4-preference flags with a user-provided
 * NODE_OPTIONS value (if any).
 *
 * Use this at every site where NODE_OPTIONS is set into a VM env
 * block AFTER a spread of user-controlled secrets, to guarantee
 * the forced flags are always present in the final value even if
 * a zone secret happens to provide its own NODE_OPTIONS.
 *
 * Forced flags come FIRST so they are unambiguously applied.
 * User-provided flags are appended verbatim except for duplicate
 * forced IPv4-preference flags. Node treats NODE_OPTIONS as a
 * whitespace-separated list and all flags apply.
 *
 * Returns just the forced flags if the user value is undefined,
 * empty, or whitespace-only.
 *
 * Examples:
 *
 *   composeNodeOptions(undefined)
 *     ──► '--dns-result-order=ipv4first --no-network-family-autoselection'
 *
 *   composeNodeOptions('')
 *     ──► '--dns-result-order=ipv4first --no-network-family-autoselection'
 *
 *   composeNodeOptions('--inspect=0.0.0.0:9229')
 *     ──► '--dns-result-order=ipv4first --no-network-family-autoselection
 *          --inspect=0.0.0.0:9229'
 */
export function composeNodeOptions(userValue: string | undefined): string {
	const trimmed = userValue?.trim() ?? '';
	if (trimmed === '') {
		return FORCE_IPV4_EGRESS_NODE_OPTIONS;
	}
	const userFlags = trimmed
		.split(/\s+/u)
		.filter((flag) => !FORCE_IPV4_EGRESS_NODE_OPTION_FLAGS.includes(flag));
	if (userFlags.length === 0) {
		return FORCE_IPV4_EGRESS_NODE_OPTIONS;
	}
	return `${FORCE_IPV4_EGRESS_NODE_OPTIONS} ${userFlags.join(' ')}`;
}
