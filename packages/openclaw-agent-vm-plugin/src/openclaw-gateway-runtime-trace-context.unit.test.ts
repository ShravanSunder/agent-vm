import { describe, expect, it, vi } from 'vitest';

import {
	createOpenClawGatewayRuntimeTraceContextBridge,
	openClawDiagnosticRuntimeSdkPath,
} from './openclaw-gateway-runtime-trace-context.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const ACTIVE_SPAN_ID = '00f067aa0ba902b7';

describe('OpenClaw Gateway Runtime trace context', () => {
	it('loads diagnostics through the image-owned OpenClaw SDK seam', () => {
		expect(openClawDiagnosticRuntimeSdkPath).toBe('/opt/openclaw-sdk/diagnostic-runtime.js');
	});

	it('projects only the active OpenClaw parent into bounded W3C context', async () => {
		const createDiagnosticTraceContextFromActiveScope = vi.fn(() => ({
			parentSpanId: ACTIVE_SPAN_ID,
			spanId: '1111111111111111',
			traceFlags: '01',
			traceId: TRACE_ID,
		}));
		const formatDiagnosticTraceparent = vi.fn(
			(context: {
				readonly spanId?: string;
				readonly traceFlags?: string;
				readonly traceId: string;
			}) => `00-${context.traceId}-${context.spanId}-${context.traceFlags}`,
		);
		const bridge = createOpenClawGatewayRuntimeTraceContextBridge({
			loadDiagnosticRuntime: async () => ({
				createDiagnosticTraceContextFromActiveScope,
				formatDiagnosticTraceparent,
			}),
		});

		expect(bridge.provide()).toBeUndefined();
		await bridge.load();

		expect(bridge.provide()).toEqual({
			traceparent: `00-${TRACE_ID}-${ACTIVE_SPAN_ID}-01`,
		});
		expect(formatDiagnosticTraceparent).toHaveBeenCalledWith({
			spanId: ACTIVE_SPAN_ID,
			traceFlags: '01',
			traceId: TRACE_ID,
		});
	});

	it('omits trace metadata when OpenClaw has no active diagnostic scope', async () => {
		const formatDiagnosticTraceparent = vi.fn();
		const bridge = createOpenClawGatewayRuntimeTraceContextBridge({
			loadDiagnosticRuntime: async () => ({
				createDiagnosticTraceContextFromActiveScope: () => ({
					spanId: '1111111111111111',
					traceFlags: '01',
					traceId: TRACE_ID,
				}),
				formatDiagnosticTraceparent,
			}),
		});

		await bridge.load();

		expect(bridge.provide()).toBeUndefined();
		expect(formatDiagnosticTraceparent).not.toHaveBeenCalled();
	});
});
