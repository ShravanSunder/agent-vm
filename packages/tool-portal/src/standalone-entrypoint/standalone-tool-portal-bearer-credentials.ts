import { timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const TOOL_PORTAL_MCP_BEARER_AUDIENCE = 'tool-portal:mcp';
export const maximumStandaloneToolPortalBearerTokenCharacters = 4_096;

const StandaloneToolPortalBearerCredentialSchema = z
	.object({
		bearerToken: z.string().min(1).max(maximumStandaloneToolPortalBearerTokenCharacters),
		credentialVersion: z.number().int().positive(),
		principal: z
			.object({
				agentId: z.string().min(1),
				profileAssignmentRevision: z.string().min(1),
				toolPortalProfileId: z.string().min(1),
			})
			.strict(),
	})
	.strict();

const StandaloneToolPortalBearerCredentialSetSchema = z
	.object({
		audience: z.literal(TOOL_PORTAL_MCP_BEARER_AUDIENCE),
		credentials: z.array(StandaloneToolPortalBearerCredentialSchema).min(1),
		serviceGeneration: z.string().min(1),
	})
	.strict();

export type StandaloneToolPortalBearerCredential = z.infer<
	typeof StandaloneToolPortalBearerCredentialSchema
>;
export type StandaloneToolPortalBearerCredentialSet = z.infer<
	typeof StandaloneToolPortalBearerCredentialSetSchema
>;

export interface CompiledStandaloneToolPortalCredential {
	readonly authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelope;
	readonly credentialId: string;
	readonly credentialVersion: number;
	readonly principal: StandaloneToolPortalAuthenticatedPrincipal;
	readonly tokenBytes: Buffer;
}

export const StandaloneToolPortalAuthenticatedPrincipalSchema = z
	.object({
		agentId: z.string().min(1),
		credentialVersion: z.number().int().positive(),
		profileAssignmentRevision: z.string().min(1),
		toolPortalProfileId: z.string().min(1),
	})
	.strict();

export type StandaloneToolPortalAuthenticatedPrincipal = z.infer<
	typeof StandaloneToolPortalAuthenticatedPrincipalSchema
>;

export const StandaloneToolPortalAuthenticatedEnvelopeSchema = z
	.object({
		audience: z.literal(TOOL_PORTAL_MCP_BEARER_AUDIENCE),
		principal: StandaloneToolPortalAuthenticatedPrincipalSchema,
		serviceGeneration: z.string().min(1),
	})
	.strict();

export type StandaloneToolPortalAuthenticatedEnvelope = z.infer<
	typeof StandaloneToolPortalAuthenticatedEnvelopeSchema
>;

export interface StandaloneToolPortalCredentialSetState {
	readonly credentials: readonly CompiledStandaloneToolPortalCredential[];
	readonly drainWaiters: Set<() => void>;
	inFlightRequests: number;
	readonly identity: string;
}

export interface StandaloneToolPortalFixedCredentialPrincipal {
	readonly agentId: string;
	readonly profileAssignmentRevision: string;
	readonly toolPortalProfileId: string;
}

export function fixedStandaloneToolPortalCredentialPrincipals(
	state: StandaloneToolPortalCredentialSetState,
): ReadonlyMap<string, StandaloneToolPortalFixedCredentialPrincipal> {
	return new Map(
		state.credentials.map(({ principal }) => [
			principal.agentId,
			Object.freeze({
				agentId: principal.agentId,
				profileAssignmentRevision: principal.profileAssignmentRevision,
				toolPortalProfileId: principal.toolPortalProfileId,
			}),
		]),
	);
}

export function assertStandaloneToolPortalCredentialPrincipalsUnchanged(
	state: StandaloneToolPortalCredentialSetState,
	fixedPrincipals: ReadonlyMap<string, StandaloneToolPortalFixedCredentialPrincipal>,
): void {
	for (const { principal } of state.credentials) {
		const fixedPrincipal = fixedPrincipals.get(principal.agentId);
		if (
			fixedPrincipal === undefined ||
			principal.profileAssignmentRevision !== fixedPrincipal.profileAssignmentRevision ||
			principal.toolPortalProfileId !== fixedPrincipal.toolPortalProfileId
		) {
			throw new Error(
				`Standalone Tool Portal credential rotation cannot change identity for agent "${principal.agentId}".`,
			);
		}
	}
}

function credentialSetIdentity(
	credentials: readonly CompiledStandaloneToolPortalCredential[],
): string {
	return JSON.stringify(
		credentials
			.map((credential) => [
				credential.principal.agentId,
				credential.credentialVersion,
				credential.credentialId,
			])
			.toSorted(([leftAgentId], [rightAgentId]) =>
				Buffer.compare(
					Buffer.from(String(leftAgentId), 'utf8'),
					Buffer.from(String(rightAgentId), 'utf8'),
				),
			),
	);
}

export function compileStandaloneToolPortalCredentialSet(
	credentialSet: StandaloneToolPortalBearerCredentialSet,
): StandaloneToolPortalCredentialSetState {
	const parsed = StandaloneToolPortalBearerCredentialSetSchema.parse(credentialSet);
	const seenAgentIds = new Set<string>();
	const seenTokens = new Set<string>();
	const credentials = parsed.credentials.map((credential) => {
		if (seenAgentIds.has(credential.principal.agentId)) {
			throw new Error('Standalone Tool Portal MCP credentials must identify unique agents.');
		}
		if (seenTokens.has(credential.bearerToken)) {
			throw new Error('Standalone Tool Portal MCP bearer tokens must be unique.');
		}
		seenAgentIds.add(credential.principal.agentId);
		seenTokens.add(credential.bearerToken);
		const principal = StandaloneToolPortalAuthenticatedPrincipalSchema.parse({
			...credential.principal,
			credentialVersion: credential.credentialVersion,
		});
		return {
			authenticatedEnvelope: StandaloneToolPortalAuthenticatedEnvelopeSchema.parse({
				audience: parsed.audience,
				principal,
				serviceGeneration: parsed.serviceGeneration,
			}),
			credentialId: `${credential.principal.agentId}:v${String(credential.credentialVersion)}`,
			credentialVersion: credential.credentialVersion,
			principal,
			tokenBytes: Buffer.from(credential.bearerToken, 'utf8'),
		};
	});
	return {
		credentials,
		drainWaiters: new Set(),
		identity: credentialSetIdentity(credentials),
		inFlightRequests: 0,
	};
}

export function parseStandaloneToolPortalBearerToken(
	authorization: string | undefined,
): string | null {
	if (authorization === undefined) return null;
	const [scheme, token, extra] = authorization.split(/\s+/u);
	return scheme === 'Bearer' &&
		token !== undefined &&
		token.length > 0 &&
		token.length <= maximumStandaloneToolPortalBearerTokenCharacters &&
		extra === undefined
		? token
		: null;
}

function tokenBytesEqual(expected: Buffer, candidate: Buffer): boolean {
	const comparedLength = Math.max(expected.length, candidate.length, 1);
	const expectedPadded = Buffer.alloc(comparedLength);
	const candidatePadded = Buffer.alloc(comparedLength);
	expected.copy(expectedPadded);
	candidate.copy(candidatePadded);
	return timingSafeEqual(expectedPadded, candidatePadded) && expected.length === candidate.length;
}

export function authenticateStandaloneToolPortalRequest(
	bearerToken: string | null,
	credentialSet: StandaloneToolPortalCredentialSetState,
): CompiledStandaloneToolPortalCredential | null {
	if (bearerToken === null) return null;
	const candidateBytes = Buffer.from(bearerToken, 'utf8');
	let matchedCredential: CompiledStandaloneToolPortalCredential | null = null;
	for (const credential of credentialSet.credentials) {
		if (tokenBytesEqual(credential.tokenBytes, candidateBytes)) {
			matchedCredential = credential;
		}
	}
	return matchedCredential;
}

export function finishStandaloneToolPortalCredentialRequest(
	state: StandaloneToolPortalCredentialSetState,
): void {
	state.inFlightRequests -= 1;
	if (state.inFlightRequests !== 0) return;
	for (const resolve of state.drainWaiters) resolve();
	state.drainWaiters.clear();
}

export async function waitForStandaloneToolPortalCredentialDrain(
	state: StandaloneToolPortalCredentialSetState,
): Promise<void> {
	if (state.inFlightRequests === 0) return;
	await new Promise<void>((resolve) => state.drainWaiters.add(resolve));
}

export async function waitForStandaloneToolPortalCredentialDrainDeadline(
	state: StandaloneToolPortalCredentialSetState,
	drainTimeoutMs: number,
): Promise<void> {
	if (state.inFlightRequests === 0) return;
	await new Promise<void>((resolve) => {
		let settled = false;
		const finishWait = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			state.drainWaiters.delete(resolveDrained);
			resolve();
		};
		const resolveDrained = (): void => finishWait();
		const timeout = setTimeout(finishWait, drainTimeoutMs);
		state.drainWaiters.add(resolveDrained);
		if (state.inFlightRequests === 0) resolveDrained();
	});
}

export function activeCredentialVersionsByAgent(
	state: StandaloneToolPortalCredentialSetState,
): Readonly<Record<string, number>> {
	return Object.freeze(
		Object.fromEntries(
			state.credentials.map((credential) => [
				credential.principal.agentId,
				credential.credentialVersion,
			]),
		),
	);
}
