import { z } from 'zod/v4';

export const GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH = 512;
export const GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH = 512;
export const GATEWAY_RUNTIME_TRACESTATE_MAX_MEMBERS = 32;

const lowercaseHexPattern = /^[0-9a-f]+$/u;
const tracestateSimpleKeyPattern = /^[a-z][a-z0-9_*/-]{0,255}$/u;
const tracestateMultiTenantKeyPattern = /^[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13}$/u;
const tracestateValuePattern =
	/^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/u;
const futureTraceparentSuffixPattern = /^[\x21-\x7e]+$/u;

function traceparentIsValid(traceparent: string): boolean {
	if (traceparent.length < 55 || traceparent.length > GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH) {
		return false;
	}
	if (traceparent[2] !== '-' || traceparent[35] !== '-' || traceparent[52] !== '-') {
		return false;
	}
	const version = traceparent.slice(0, 2);
	const traceId = traceparent.slice(3, 35);
	const parentId = traceparent.slice(36, 52);
	const traceFlags = traceparent.slice(53, 55);
	if (
		!lowercaseHexPattern.test(version) ||
		version === 'ff' ||
		!lowercaseHexPattern.test(traceId) ||
		traceId === '0'.repeat(32) ||
		!lowercaseHexPattern.test(parentId) ||
		parentId === '0'.repeat(16) ||
		!lowercaseHexPattern.test(traceFlags)
	) {
		return false;
	}
	if (traceparent.length === 55) return true;
	if (version === '00' || traceparent[55] !== '-') return false;
	return futureTraceparentSuffixPattern.test(traceparent.slice(56));
}

function tracestateIsValid(tracestate: string): boolean {
	if (tracestate.length > GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH) return false;
	const rawMembers = tracestate.split(',');
	if (rawMembers.length > GATEWAY_RUNTIME_TRACESTATE_MAX_MEMBERS) return false;
	const seenKeys = new Set<string>();
	for (const rawMember of rawMembers) {
		const member = rawMember.replace(/^[ \t]+|[ \t]+$/gu, '');
		if (member.length === 0) continue;
		const equalsIndex = member.indexOf('=');
		if (equalsIndex <= 0 || equalsIndex !== member.lastIndexOf('=')) return false;
		const key = member.slice(0, equalsIndex);
		const value = member.slice(equalsIndex + 1);
		if (
			(!tracestateSimpleKeyPattern.test(key) && !tracestateMultiTenantKeyPattern.test(key)) ||
			!tracestateValuePattern.test(value)
		) {
			return false;
		}
		if (seenKeys.has(key)) return false;
		seenKeys.add(key);
	}
	return true;
}

const GatewayRuntimeTraceparentSchema = z
	.string()
	.max(GATEWAY_RUNTIME_TRACEPARENT_MAX_LENGTH)
	.refine(traceparentIsValid, 'traceparent must follow the bounded W3C Trace Context grammar.');

const GatewayRuntimeTracestateSchema = z
	.string()
	.max(GATEWAY_RUNTIME_TRACESTATE_MAX_LENGTH)
	.refine(tracestateIsValid, 'tracestate must follow the bounded W3C Trace Context grammar.');

export const GatewayRuntimeTraceContextSchema = z
	.object({
		traceparent: GatewayRuntimeTraceparentSchema,
		tracestate: GatewayRuntimeTracestateSchema.optional(),
	})
	.strict();

export type GatewayRuntimeTraceContext = z.infer<typeof GatewayRuntimeTraceContextSchema>;

/** Read current invocation metadata; the client validates every returned value before transport. */
export type GatewayRuntimeTraceContextProvider = () => unknown;
