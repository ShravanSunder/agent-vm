import { Writable } from 'node:stream';

import {
	configure,
	dispose,
	getJsonLinesFormatter,
	getLogger,
	getStreamSink,
	type Sink,
} from '@logtape/logtape';
import { getOpenTelemetrySink } from '@logtape/otel';

import type { PortalServerLogEvent, PortalServerLogger } from './serve-command.js';

const portalServerLogger = getLogger(['agent-vm', 'mcp-portal', 'server']);
const maxSafeIdentifierLength = 128;
const maxSafeReasonLength = 64;

type PortalServerLogLevel = 'error' | 'info' | 'warn';

export interface PortalServerLogRecord {
	readonly category: readonly ['agent-vm', 'mcp-portal', 'server'];
	readonly level: PortalServerLogLevel;
	readonly message: string;
	readonly properties: Readonly<Record<string, number | string>>;
}

export interface ProcessLoggingHandle {
	readonly shutdown: () => Promise<void>;
}

export interface ConfigureProcessLoggingProps {
	readonly stderr: Writable;
}

function boundedIdentifier(value: string): string {
	const normalized = value
		.trim()
		.replaceAll(/[^A-Za-z0-9_.:-]/gu, '_')
		.slice(0, maxSafeIdentifierLength);
	return normalized.length === 0 ? 'unknown' : normalized;
}

function boundedDurationMs(value: number): number {
	if (!Number.isFinite(value) || value < 0) {
		return 0;
	}
	return Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
}

function boundedReason(value: string): string {
	const normalized = value
		.trim()
		.replaceAll(/[^A-Za-z0-9_-]/gu, '_')
		.slice(0, maxSafeReasonLength);
	return normalized.length === 0 ? 'unknown' : normalized;
}

function classifyClientAddress(value: string): string {
	const address = value.trim().toLowerCase();
	if (address.length === 0 || address === 'direct-client') {
		return 'direct';
	}
	if (address === '::1' || address.startsWith('127.')) {
		return 'loopback';
	}
	if (
		address.startsWith('10.') ||
		address.startsWith('192.168.') ||
		address.startsWith('fc') ||
		address.startsWith('fd') ||
		/^172\.(?:1[6-9]|2\d|3[0-1])\./u.test(address)
	) {
		return 'private';
	}
	if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address) || address.includes(':')) {
		return 'public';
	}
	return 'unknown';
}

function propertiesWithOptionalReason(
	base: Readonly<Record<string, number | string>>,
	reason: string | undefined,
): Readonly<Record<string, number | string>> {
	return reason === undefined ? base : { ...base, reason: boundedReason(reason) };
}

function assertNever(value: never): never {
	void value;
	throw new Error('Unhandled MCP Portal server log event.');
}

export function mapPortalServerLogEvent(event: PortalServerLogEvent): PortalServerLogRecord {
	const category = ['agent-vm', 'mcp-portal', 'server'] as const;
	switch (event.event) {
		case 'server_error':
			return {
				category,
				level: 'error',
				message: 'MCP Portal server error',
				properties: { failureClass: 'server' },
			};
		case 'mcp_proxy_auth':
			return {
				category,
				level: event.decision === 'allow' ? 'info' : 'warn',
				message: 'MCP Portal proxy authentication decision',
				properties: propertiesWithOptionalReason(
					{
						clientAddressClass: classifyClientAddress(event.clientAddress),
						decision: event.decision,
						durationMs: boundedDurationMs(event.timeMs),
						scope: boundedIdentifier(event.agentId),
					},
					event.reason,
				),
			};
		case 'mcp_proxy_auth_audit_error':
			return {
				category,
				level: 'warn',
				message: 'MCP Portal proxy audit failed',
				properties: {
					durationMs: boundedDurationMs(event.timeMs),
					failureClass: 'auth-audit',
					scope: boundedIdentifier(event.agentId),
				},
			};
		case 'mcp_portal_approval':
			return {
				category,
				level: event.decision === 'allow' ? 'info' : 'warn',
				message: 'MCP Portal approval decision',
				properties: propertiesWithOptionalReason(
					{
						decision: event.decision,
						durationMs: boundedDurationMs(event.timeMs),
						scope: boundedIdentifier(event.agentId),
					},
					event.reason,
				),
			};
		case 'mcp_portal_approval_audit_error':
			return {
				category,
				level: 'warn',
				message: 'MCP Portal approval audit failed',
				properties: {
					durationMs: boundedDurationMs(event.timeMs),
					failureClass: 'approval-audit',
					scope: boundedIdentifier(event.agentId),
				},
			};
		case 'upstream_close_error':
			return {
				category,
				level: 'warn',
				message: 'MCP Portal upstream close failed',
				properties: {
					failureClass: 'upstream-close',
					scope: boundedIdentifier(event.agentScopeId),
				},
			};
		default:
			return assertNever(event);
	}
}

export function createPortalServerLogger(): PortalServerLogger {
	return {
		log: (event): void => {
			const record = mapPortalServerLogEvent(event);
			switch (record.level) {
				case 'error':
					portalServerLogger.error(record.message, record.properties);
					return;
				case 'info':
					portalServerLogger.info(record.message, record.properties);
					return;
				case 'warn':
					portalServerLogger.warn(record.message, record.properties);
					return;
			}
		},
	};
}

function disposeSink(sink: Sink & AsyncDisposable): Promise<void> {
	return Promise.resolve(sink[Symbol.asyncDispose]());
}

export async function configureProcessLogging(
	props: ConfigureProcessLoggingProps,
): Promise<ProcessLoggingHandle> {
	let stderrSink: (Sink & AsyncDisposable) | undefined;
	let otelSink: (Sink & AsyncDisposable) | undefined;
	try {
		stderrSink = getStreamSink(Writable.toWeb(props.stderr), {
			formatter: getJsonLinesFormatter({
				categorySeparator: '.',
				message: 'rendered',
				properties: 'nest:properties',
			}),
			nonBlocking: { bufferSize: 1 },
		});
		otelSink = getOpenTelemetrySink({
			diagnostics: false,
			exceptionAttributes: false,
			serviceName: 'agent-vm-mcp-portal',
		});
		await configure({
			loggers: [
				{ category: 'agent-vm', sinks: ['stderr', 'otel'] },
				{
					category: ['logtape', 'meta'],
					lowestLevel: 'warning',
					parentSinks: 'override',
					sinks: ['stderr'],
				},
				{
					category: ['logtape', 'meta', 'otel'],
					lowestLevel: 'warning',
					parentSinks: 'override',
					sinks: ['stderr'],
				},
			],
			reset: false,
			sinks: { otel: otelSink, stderr: stderrSink },
		});
	} catch (error: unknown) {
		await Promise.allSettled([
			...(stderrSink === undefined ? [] : [disposeSink(stderrSink)]),
			...(otelSink === undefined ? [] : [disposeSink(otelSink)]),
		]);
		throw error;
	}

	let shutdownPromise: Promise<void> | undefined;
	return {
		shutdown: (): Promise<void> => {
			shutdownPromise ??= dispose();
			return shutdownPromise;
		},
	};
}
