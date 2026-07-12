import { targetsAudience, type RuntimeVmAudience, type VmAudience } from './audience.js';

export interface WebSocketUpgradeConfig {
	readonly audience: VmAudience;
	readonly scheme: 'ws' | 'wss';
	readonly host: string;
	readonly port?: number | undefined;
	readonly path?: string | undefined;
}

export interface CreateWebSocketUpgradeRequestGuardOptions {
	readonly rules: readonly WebSocketUpgradeConfig[];
	readonly runtimeAudience: RuntimeVmAudience;
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function hostMatchesPattern(host: string, pattern: string): boolean {
	const normalizedPattern = pattern.trim().toLowerCase();
	if (normalizedPattern === '') {
		return false;
	}
	if (normalizedPattern === '*') {
		return true;
	}

	const patternRegex = new RegExp(
		`^${normalizedPattern.split('*').map(escapeRegExpLiteral).join('.*')}$`,
		'iu',
	);
	return patternRegex.test(host.toLowerCase());
}

function isWebSocketUpgradeRequest(request: Request): boolean {
	const upgrade = request.headers.get('upgrade')?.toLowerCase() ?? '';
	const connection = request.headers.get('connection')?.toLowerCase() ?? '';
	return (
		upgrade === 'websocket' ||
		connection
			.split(',')
			.map((token) => token.trim())
			.includes('upgrade') ||
		request.headers.has('sec-websocket-key') ||
		request.headers.has('sec-websocket-version')
	);
}

function requestSchemeForRule(url: URL): 'ws' | 'wss' | null {
	if (url.protocol === 'http:') {
		return 'ws';
	}
	if (url.protocol === 'https:') {
		return 'wss';
	}
	return null;
}

function requestPortForScheme(url: URL, scheme: 'ws' | 'wss'): number {
	if (url.port.length > 0) {
		return Number.parseInt(url.port, 10);
	}
	return scheme === 'wss' ? 443 : 80;
}

function defaultPortForScheme(scheme: 'ws' | 'wss'): number {
	return scheme === 'wss' ? 443 : 80;
}

function websocketRuleMatchesRequest(rule: WebSocketUpgradeConfig, request: Request): boolean {
	const url = new URL(request.url);
	const requestScheme = requestSchemeForRule(url);
	if (requestScheme !== rule.scheme) {
		return false;
	}

	if (!hostMatchesPattern(url.hostname, rule.host)) {
		return false;
	}

	if (
		requestPortForScheme(url, requestScheme) !== (rule.port ?? defaultPortForScheme(rule.scheme))
	) {
		return false;
	}

	if (rule.path !== undefined && url.pathname !== rule.path) {
		return false;
	}

	return true;
}

export function websocketUpgradesForAudience(
	rules: readonly WebSocketUpgradeConfig[] | undefined,
	runtimeAudience: RuntimeVmAudience,
): readonly WebSocketUpgradeConfig[] {
	return (rules ?? []).filter((rule) => targetsAudience(rule.audience, runtimeAudience));
}

export function createWebSocketUpgradeRequestGuard(
	options: CreateWebSocketUpgradeRequestGuardOptions,
): (request: Request) => Promise<Response | void> {
	const runtimeRules = websocketUpgradesForAudience(options.rules, options.runtimeAudience);

	return async (request: Request): Promise<Response | void> => {
		if (!isWebSocketUpgradeRequest(request)) {
			return undefined;
		}

		if (runtimeRules.some((rule) => websocketRuleMatchesRequest(rule, request))) {
			return undefined;
		}

		return new Response('WebSocket upgrade blocked by agent-vm policy', {
			status: 403,
			statusText: 'Forbidden',
		});
	};
}
