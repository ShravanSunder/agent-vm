import { createHash, timingSafeEqual } from 'node:crypto';

import {
	maximumNodeHostBearerTokenCharacters,
	NodeHostBearerCredentialSetSchema,
	type NodeHostBearerCredentialSet,
	type CompiledNodeHostCredential,
	NodeHostAuthenticatedPrincipalSchema,
	NodeHostAuthenticatedEnvelopeSchema,
	type NodeHostCredentialSetState,
	type NodeHostFixedCredentialPrincipal,
} from '#node-host/mcp-proxy-server/models/bearer-credentials';

export function fixedNodeHostCredentialPrincipals(
	state: NodeHostCredentialSetState,
): ReadonlyMap<string, NodeHostFixedCredentialPrincipal> {
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

export function assertNodeHostCredentialPrincipalsUnchanged(
	state: NodeHostCredentialSetState,
	fixedPrincipals: ReadonlyMap<string, NodeHostFixedCredentialPrincipal>,
): void {
	for (const { principal } of state.credentials) {
		const fixedPrincipal = fixedPrincipals.get(principal.agentId);
		if (
			fixedPrincipal === undefined ||
			principal.profileAssignmentRevision !== fixedPrincipal.profileAssignmentRevision ||
			principal.toolPortalProfileId !== fixedPrincipal.toolPortalProfileId
		) {
			throw new Error(
				`Node Tool Portal credential rotation cannot change identity for agent "${principal.agentId}".`,
			);
		}
	}
}

function credentialSetIdentity(credentials: readonly CompiledNodeHostCredential[]): string {
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

export function compileNodeHostCredentialSet(
	credentialSet: NodeHostBearerCredentialSet,
): NodeHostCredentialSetState {
	const parsed = NodeHostBearerCredentialSetSchema.parse(credentialSet);
	const seenAgentIds = new Set<string>();
	const seenTokens = new Set<string>();
	const credentials = parsed.credentials.map((credential) => {
		if (seenAgentIds.has(credential.principal.agentId)) {
			throw new Error('Node Tool Portal MCP credentials must identify unique agents.');
		}
		if (seenTokens.has(credential.bearerToken)) {
			throw new Error('Node Tool Portal MCP bearer tokens must be unique.');
		}
		seenAgentIds.add(credential.principal.agentId);
		seenTokens.add(credential.bearerToken);
		const principal = NodeHostAuthenticatedPrincipalSchema.parse({
			...credential.principal,
			credentialVersion: credential.credentialVersion,
		});
		return {
			authenticatedEnvelope: NodeHostAuthenticatedEnvelopeSchema.parse({
				audience: parsed.audience,
				principal,
				serviceGeneration: parsed.serviceGeneration,
			}),
			// Opaque admission identity includes authority generation; operation keys use agentId separately.
			credentialId: createHash('sha256')
				.update(
					JSON.stringify([
						parsed.serviceGeneration,
						credential.principal.agentId,
						credential.credentialVersion,
					]),
				)
				.digest('hex'),
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

export function parseNodeHostBearerToken(authorization: string | undefined): string | null {
	if (authorization === undefined) return null;
	const [scheme, token, extra] = authorization.split(/\s+/u);
	return scheme === 'Bearer' &&
		token !== undefined &&
		token.length > 0 &&
		token.length <= maximumNodeHostBearerTokenCharacters &&
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

export function authenticateNodeHostRequest(
	bearerToken: string | null,
	credentialSet: NodeHostCredentialSetState,
): CompiledNodeHostCredential | null {
	if (bearerToken === null) return null;
	const candidateBytes = Buffer.from(bearerToken, 'utf8');
	let matchedCredential: CompiledNodeHostCredential | null = null;
	for (const credential of credentialSet.credentials) {
		if (tokenBytesEqual(credential.tokenBytes, candidateBytes)) {
			matchedCredential = credential;
		}
	}
	return matchedCredential;
}

export function finishNodeHostCredentialRequest(state: NodeHostCredentialSetState): void {
	state.inFlightRequests -= 1;
	if (state.inFlightRequests !== 0) return;
	for (const resolve of state.drainWaiters) resolve();
	state.drainWaiters.clear();
}

export async function waitForNodeHostCredentialDrain(
	state: NodeHostCredentialSetState,
): Promise<void> {
	if (state.inFlightRequests === 0) return;
	await new Promise<void>((resolve) => state.drainWaiters.add(resolve));
}

export async function waitForNodeHostCredentialDrainDeadline(
	state: NodeHostCredentialSetState,
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
	state: NodeHostCredentialSetState,
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
