import type { IncomingMessage } from 'node:http';

import { z } from 'zod';

export interface StandaloneToolPortalHttpRequestPolicy {
	readonly allowedHosts: ReadonlySet<string>;
	readonly allowedOrigins: ReadonlySet<string>;
}

export function compileStandaloneToolPortalHttpRequestPolicy(props: {
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
}): StandaloneToolPortalHttpRequestPolicy {
	const allowedHosts = new Set(
		z.array(z.string().min(1)).min(1).parse(props.allowedHosts).map(normalizeConfiguredHost),
	);
	const allowedOrigins = new Set(
		z.array(z.string().url()).parse(props.allowedOrigins).map(normalizeOrigin),
	);
	return { allowedHosts, allowedOrigins };
}

export function standaloneToolPortalHttpRequestIsAllowed(
	request: IncomingMessage,
	policy: StandaloneToolPortalHttpRequestPolicy,
): boolean {
	const requestTarget = request.url;
	if (
		requestTarget === undefined ||
		!requestTarget.startsWith('/') ||
		requestTarget.startsWith('//')
	) {
		return false;
	}
	const hostHeader = request.headers.host;
	if (hostHeader === undefined || Array.isArray(hostHeader)) return false;
	const host = parseHostHeader(hostHeader);
	if (host === null || !policy.allowedHosts.has(host)) return false;
	const originHeader = request.headers.origin;
	if (originHeader === undefined) return true;
	if (Array.isArray(originHeader)) return false;
	try {
		return policy.allowedOrigins.has(normalizeOrigin(originHeader));
	} catch {
		return false;
	}
}

function normalizeOrigin(origin: string): string {
	const parsed = new URL(origin);
	if (
		!['http:', 'https:'].includes(parsed.protocol) ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.pathname !== '/' ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		throw new TypeError(`Invalid standalone Tool Portal Origin: ${origin}`);
	}
	return parsed.origin;
}

function normalizeConfiguredHost(host: string): string {
	const parsedHost = parseHostHeader(host);
	if (parsedHost === null)
		throw new TypeError(`Invalid standalone Tool Portal allowed Host: ${host}`);
	return parsedHost;
}

function parseHostHeader(hostHeader: string): string | null {
	try {
		const parsed = new URL(`http://${hostHeader}`);
		if (
			parsed.username.length > 0 ||
			parsed.password.length > 0 ||
			parsed.pathname !== '/' ||
			parsed.search.length > 0 ||
			parsed.hash.length > 0
		) {
			return null;
		}
		return parsed.hostname;
	} catch {
		return null;
	}
}
