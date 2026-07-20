import type { GatewayRuntimeTraceContext } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';

export const openClawDiagnosticRuntimeSdkPath = '/opt/openclaw-sdk/diagnostic-runtime.js';

export interface OpenClawDiagnosticTraceContext {
	readonly parentSpanId?: string;
	readonly spanId?: string;
	readonly traceFlags?: string;
	readonly traceId: string;
}

export interface OpenClawDiagnosticRuntime {
	readonly createDiagnosticTraceContextFromActiveScope: () => OpenClawDiagnosticTraceContext;
	readonly formatDiagnosticTraceparent: (
		context: OpenClawDiagnosticTraceContext,
	) => string | undefined;
}

export type OpenClawDiagnosticRuntimeLoader = () => Promise<OpenClawDiagnosticRuntime>;

export interface OpenClawGatewayRuntimeTraceContextBridge {
	readonly load: () => Promise<void>;
	readonly provide: () => GatewayRuntimeTraceContext | undefined;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireUnknownFunction(
	value: unknown,
	exportName: string,
): (...arguments_: readonly unknown[]) => unknown {
	if (typeof value !== 'function') {
		throw new TypeError(`OpenClaw diagnostic runtime is missing ${exportName}.`);
	}
	return (...arguments_): unknown => {
		const result: unknown = Reflect.apply(value, undefined, arguments_);
		return result;
	};
}

function optionalStringProperty(
	record: Readonly<Record<string, unknown>>,
	propertyName: 'parentSpanId' | 'spanId' | 'traceFlags',
): string | undefined {
	const value = record[propertyName];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') {
		throw new TypeError(`OpenClaw diagnostic context ${propertyName} must be a string.`);
	}
	return value;
}

function requireOpenClawDiagnosticTraceContext(value: unknown): OpenClawDiagnosticTraceContext {
	if (!isUnknownRecord(value) || typeof value.traceId !== 'string') {
		throw new TypeError('OpenClaw diagnostic context must contain a string traceId.');
	}
	const parentSpanId = optionalStringProperty(value, 'parentSpanId');
	const spanId = optionalStringProperty(value, 'spanId');
	const traceFlags = optionalStringProperty(value, 'traceFlags');
	return {
		...(parentSpanId === undefined ? {} : { parentSpanId }),
		...(spanId === undefined ? {} : { spanId }),
		...(traceFlags === undefined ? {} : { traceFlags }),
		traceId: value.traceId,
	};
}

export async function loadOpenClawDiagnosticRuntime(): Promise<OpenClawDiagnosticRuntime> {
	const loadedModule: unknown = await import(openClawDiagnosticRuntimeSdkPath);
	if (!isUnknownRecord(loadedModule)) {
		throw new TypeError('OpenClaw diagnostic runtime module is not an object.');
	}
	const createDiagnosticTraceContextFromActiveScope = requireUnknownFunction(
		loadedModule.createDiagnosticTraceContextFromActiveScope,
		'createDiagnosticTraceContextFromActiveScope',
	);
	const formatDiagnosticTraceparent = requireUnknownFunction(
		loadedModule.formatDiagnosticTraceparent,
		'formatDiagnosticTraceparent',
	);
	return {
		createDiagnosticTraceContextFromActiveScope: () =>
			requireOpenClawDiagnosticTraceContext(createDiagnosticTraceContextFromActiveScope()),
		formatDiagnosticTraceparent: (context) => {
			const traceparent: unknown = formatDiagnosticTraceparent(context);
			if (traceparent !== undefined && typeof traceparent !== 'string') {
				throw new TypeError('OpenClaw diagnostic runtime returned an invalid traceparent.');
			}
			return traceparent;
		},
	};
}

export function createOpenClawGatewayRuntimeTraceContextBridge(
	options: {
		readonly loadDiagnosticRuntime?: OpenClawDiagnosticRuntimeLoader;
	} = {},
): OpenClawGatewayRuntimeTraceContextBridge {
	const loadDiagnosticRuntime = options.loadDiagnosticRuntime ?? loadOpenClawDiagnosticRuntime;
	let diagnosticRuntime: OpenClawDiagnosticRuntime | undefined;
	return {
		load: async () => {
			diagnosticRuntime = await loadDiagnosticRuntime();
		},
		provide: (): GatewayRuntimeTraceContext | undefined => {
			if (diagnosticRuntime === undefined) return undefined;
			const scopedContext = diagnosticRuntime.createDiagnosticTraceContextFromActiveScope();
			if (scopedContext.parentSpanId === undefined) return undefined;
			const traceparent = diagnosticRuntime.formatDiagnosticTraceparent({
				spanId: scopedContext.parentSpanId,
				...(scopedContext.traceFlags === undefined ? {} : { traceFlags: scopedContext.traceFlags }),
				traceId: scopedContext.traceId,
			});
			return traceparent === undefined ? undefined : { traceparent };
		},
	};
}
