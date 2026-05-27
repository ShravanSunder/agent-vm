import * as dns from 'node:dns';
import * as net from 'node:net';

export interface HostNetworkDefaultsResult {
	readonly autoSelectFamily: false | 'unavailable';
	readonly dnsResultOrder: 'ipv4first' | 'unavailable';
}

export interface HostNetworkDefaultsDependencies {
	readonly setDefaultAutoSelectFamily?: ((value: boolean) => void) | undefined;
	readonly setDefaultResultOrder?: ((order: 'ipv4first') => void) | undefined;
}

/**
 * Gondolin raw tcpHosts passthrough sockets are opened by the host-side Node
 * process, not by guest Node processes. VM NODE_OPTIONS cannot affect those
 * sockets, so host processes that create Gondolin VMs also force deterministic
 * IPv4-first behavior before network state is constructed.
 */
export function configureHostNetworkDefaults(
	dependencies: HostNetworkDefaultsDependencies = {},
): HostNetworkDefaultsResult {
	const setDefaultResultOrder =
		'setDefaultResultOrder' in dependencies
			? dependencies.setDefaultResultOrder
			: dns.setDefaultResultOrder;
	const setDefaultAutoSelectFamily =
		'setDefaultAutoSelectFamily' in dependencies
			? dependencies.setDefaultAutoSelectFamily
			: net.setDefaultAutoSelectFamily;

	let dnsResultOrder: HostNetworkDefaultsResult['dnsResultOrder'] = 'unavailable';
	if (typeof setDefaultResultOrder === 'function') {
		setDefaultResultOrder('ipv4first');
		dnsResultOrder = 'ipv4first';
	}

	let autoSelectFamily: HostNetworkDefaultsResult['autoSelectFamily'] = 'unavailable';
	if (typeof setDefaultAutoSelectFamily === 'function') {
		setDefaultAutoSelectFamily(false);
		autoSelectFamily = false;
	}

	return {
		autoSelectFamily,
		dnsResultOrder,
	};
}
