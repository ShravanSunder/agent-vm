import { createHash, timingSafeEqual } from 'node:crypto';

import { GATEWAY_RUNTIME_APPROVAL_AUDIENCE } from '@agent-vm/gateway-control-contracts';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import type { LoadedSystemConfig } from '../../config/system-config.js';
import type {
	ApprovalBearerAuthenticationRequest,
	ApprovalBearerAuthenticationResult,
} from '../http/controller-approval-routes.js';

type ZoneConfig = LoadedSystemConfig['zones'][number];
type BearerApprovalAuthority = Extract<
	NonNullable<ZoneConfig['approvalAccess']>['approvers'][number],
	{ readonly kind: 'bearer' }
>;
type HostSecretReference = BearerApprovalAuthority['secret'];

interface ResolvedApprovalCredential {
	readonly credential: string;
	readonly credentialId: string;
	readonly operator: Extract<
		ApprovalBearerAuthenticationResult,
		{ readonly kind: 'authenticated' }
	>['operator'];
	readonly zoneId: string;
}

interface ResolvedNonApprovalCredential {
	readonly credential: string;
	readonly zoneId: string;
}

function secretRefFromHostReference(reference: HostSecretReference): SecretRef {
	switch (reference.source) {
		case '1password':
			return { ref: reference.ref, source: reference.source };
		case 'environment':
			return { ref: reference.envVar, source: reference.source };
		case 'config':
			return { source: reference.source, value: reference.value };
		default:
			throw new Error(`Unsupported approval secret reference: ${String(reference)}`);
	}
}

function credentialId(props: {
	readonly approverId: string;
	readonly reference: HostSecretReference;
	readonly zoneId: string;
}): string {
	const referenceIdentity =
		props.reference.source === '1password'
			? props.reference.ref
			: props.reference.source === 'environment'
				? props.reference.envVar
				: 'controller-config';
	return `sha256:${createHash('sha256')
		.update('agent-vm-approval-credential-v1', 'utf8')
		.update('\0')
		.update(props.zoneId, 'utf8')
		.update('\0')
		.update(props.approverId, 'utf8')
		.update('\0')
		.update(props.reference.source, 'utf8')
		.update('\0')
		.update(referenceIdentity, 'utf8')
		.digest('hex')}`;
}

function credentialsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, 'utf8');
	const rightBytes = Buffer.from(right, 'utf8');
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerCredential(
	authorizationHeader: string | undefined,
):
	| { readonly credential: string; readonly kind: 'parsed' }
	| { readonly kind: 'malformed' | 'missing' } {
	if (authorizationHeader === undefined) {
		return { kind: 'missing' };
	}
	if (!authorizationHeader.startsWith('Bearer ')) {
		return { kind: 'malformed' };
	}
	const credential = authorizationHeader.slice('Bearer '.length);
	return credential.length === 0 ? { kind: 'malformed' } : { credential, kind: 'parsed' };
}

export async function createControllerApprovalBearerAuthenticator(props: {
	readonly secretResolver: SecretResolver;
	readonly systemConfig: LoadedSystemConfig;
}): Promise<
	(request: ApprovalBearerAuthenticationRequest) => Promise<ApprovalBearerAuthenticationResult>
> {
	const approvalCredentials: ResolvedApprovalCredential[] = [];
	const nonApprovalCredentials: ResolvedNonApprovalCredential[] = [];
	const resolvedZoneCredentials = await Promise.all(
		props.systemConfig.zones.map(async (zone) => ({
			adminCredential:
				zone.adminAccess?.mode === 'secret'
					? await props.secretResolver.resolve(secretRefFromHostReference(zone.adminAccess.secret))
					: null,
			approverCredentials: await Promise.all(
				(zone.approvalAccess?.approvers ?? [])
					.filter((approver): approver is BearerApprovalAuthority => approver.kind === 'bearer')
					.map(async (approver) => ({
						approver,
						credential: await props.secretResolver.resolve(
							secretRefFromHostReference(approver.secret),
						),
					})),
			),
			zoneId: zone.id,
		})),
	);
	for (const resolvedZone of resolvedZoneCredentials) {
		for (const { approver, credential } of resolvedZone.approverCredentials) {
			if (credential.length === 0) {
				throw new Error(`Approval credential for zone '${resolvedZone.zoneId}' must not be empty.`);
			}
			if (
				approvalCredentials.some((candidate) => credentialsEqual(candidate.credential, credential))
			) {
				throw new Error('One approval credential cannot identify more than one approver.');
			}
			approvalCredentials.push({
				credential,
				credentialId: credentialId({
					approverId: approver.approverId,
					reference: approver.secret,
					zoneId: resolvedZone.zoneId,
				}),
				operator: {
					approverId: approver.approverId,
					audience: GATEWAY_RUNTIME_APPROVAL_AUDIENCE,
					credentialId: credentialId({
						approverId: approver.approverId,
						reference: approver.secret,
						zoneId: resolvedZone.zoneId,
					}),
					provenance: 'approval-access',
				},
				zoneId: resolvedZone.zoneId,
			});
		}
		if (resolvedZone.adminCredential !== null) {
			nonApprovalCredentials.push({
				credential: resolvedZone.adminCredential,
				zoneId: resolvedZone.zoneId,
			});
		}
	}

	return async (request): Promise<ApprovalBearerAuthenticationResult> => {
		const parsedBearer = bearerCredential(request.authorizationHeader);
		if (parsedBearer.kind !== 'parsed') {
			return { kind: 'unauthorized', reason: parsedBearer.kind };
		}
		const approvalCredential = approvalCredentials.find(
			(candidate) =>
				candidate.zoneId === request.zoneId &&
				credentialsEqual(candidate.credential, parsedBearer.credential),
		);
		if (approvalCredential !== undefined) {
			return { kind: 'authenticated', operator: approvalCredential.operator };
		}
		const recognizedNonApprovalCredential = nonApprovalCredentials.some(
			(candidate) =>
				candidate.zoneId === request.zoneId &&
				credentialsEqual(candidate.credential, parsedBearer.credential),
		);
		return recognizedNonApprovalCredential
			? { kind: 'forbidden', reason: 'recognized-non-approval-credential' }
			: { kind: 'unauthorized', reason: 'unknown' };
	};
}
