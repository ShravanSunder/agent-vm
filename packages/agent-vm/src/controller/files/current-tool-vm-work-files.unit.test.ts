import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	ToolVmLeaseRequestAuthority,
	ToolVmLeaseRetirementEvent,
} from '../leases/lease-manager.js';
import {
	withCurrentToolVmWorkFiles,
	type ToolVmWorkFileAccess,
	type ToolVmWorkFileLeaseManager,
} from './current-tool-vm-work-files.js';

const authority: ToolVmLeaseRequestAuthority = {
	gateway: {
		bootId: 'boot',
		controllerEpoch: 'controller',
		gatewayEpochId: 'gateway',
		gatewayVmId: 'gateway-vm',
		generationId: 'generation',
		zoneId: 'zone',
	},
	principal: {
		agentId: 'sun',
		frameworkIdentity: { kind: 'hermes', profileName: 'sun' },
		profileAssignmentRevision: 'assignment',
		toolPortalProfileId: 'standard',
	},
};
const executionProof = {
	operationPayloadDigest: 'digest',
	processEpoch: 'process',
	semanticOperationId: 'operation',
	sessionAttachmentGeneration: 1,
};

function arrange(): {
	readonly leases: ToolVmWorkFileLeaseManager;
	readonly start: ReturnType<typeof vi.fn<ToolVmWorkFileLeaseManager['startActiveUse']>>;
	readonly end: ReturnType<typeof vi.fn<ToolVmWorkFileLeaseManager['endActiveUse']>>;
	readonly state: { current: boolean; agentId: string; vmId: string; heartbeatAvailable: boolean };
	readonly retire: () => Promise<void>;
} {
	vi.useFakeTimers();
	const state = { current: true, agentId: 'sun', vmId: 'tool-vm', heartbeatAvailable: true };
	const start = vi.fn<ToolVmWorkFileLeaseManager['startActiveUse']>((_leaseId, request) => ({
		useId: request.useId,
		expiresAt: Date.now() + 3000,
		heartbeatAfterMs: 1000,
	}));
	const end = vi.fn<ToolVmWorkFileLeaseManager['endActiveUse']>(() => ({ kind: 'ended' }));
	let onRetire: ((event: ToolVmLeaseRetirementEvent) => Promise<void>) | undefined;
	const leases: ToolVmWorkFileLeaseManager = {
		listLeases: () => [
			{
				id: 'lease',
				agentId: state.agentId,
				zoneId: 'zone',
				vm: {
					id: 'tool-vm',
					exec: () => {
						throw new Error('Unexpected byte operation in lease unit test.');
					},
				},
			},
		],
		getLeaseAuthority: () =>
			state.current
				? {
						authority: { ...authority, leaseId: 'lease', leafGeneration: 'leaf' },
						compatibility: {
							policyFingerprint: 'policy',
							profileId: 'profile',
							purpose: 'hermes',
							profileAssignmentRevision: 'assignment',
						},
					}
				: undefined,
		getCurrentLeaseBinding: () =>
			state.current
				? {
						idleExpiresAtMs: 10000,
						leaseId: 'lease',
						leafGeneration: 'leaf',
						runtimeBinding: { vmId: state.vmId, tcpSlot: 1, runtimeRecordId: 'record' },
						sshBinding: {
							bindingId: 'binding',
							host: 'localhost',
							identityFile: 'identity',
							port: 22,
							serverIdentity: 'server',
							user: 'agent',
						},
					}
				: undefined,
		startActiveUse: start,
		endActiveUse: end,
		heartbeatActiveUse: () =>
			state.heartbeatAvailable
				? { expiresAt: Date.now() + 3000, heartbeatAfterMs: 1000 }
				: undefined,
		subscribeLeaseRetirement: (listener) => {
			onRetire = listener;
			return () => {
				onRetire = undefined;
			};
		},
	};
	return {
		leases,
		start,
		end,
		state,
		retire: async () => {
			await onRetire?.({ leaseId: 'lease', reason: 'released' });
		},
	};
}

afterEach(() => vi.useRealTimers());

describe('current Tool VM file-use lifetime', () => {
	it('holds the existing lease use and invalidates access when the callback ends', async () => {
		// Arrange
		const fixture = arrange();
		let savedAccess: ToolVmWorkFileAccess | undefined;
		// Act
		const result = await withCurrentToolVmWorkFiles({
			agentId: 'sun',
			authority,
			executionProof,
			leaseManager: fixture.leases,
			program: 'fixed',
			signal: new AbortController().signal,
			use: async (access) => {
				savedAccess = access;
				expect(fixture.start).toHaveBeenCalledTimes(1);
				expect(fixture.end).not.toHaveBeenCalled();
				expect(access.authorityIsCurrent()).toBe(true);
				return 'completed';
			},
		});
		// Assert
		expect(result).toBe('completed');
		expect(savedAccess?.signal.aborted).toBe(true);
		expect(savedAccess?.authorityIsCurrent()).toBe(false);
		expect(savedAccess).not.toHaveProperty('writer');
		await expect(savedAccess?.files.read('late')[Symbol.asyncIterator]().next()).rejects.toThrow(
			'unavailable',
		);
		expect(fixture.end).toHaveBeenCalledWith(
			'lease',
			expect.any(String),
			expect.objectContaining({ outcome: 'completed' }),
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['wrong-agent', 'missing', 'wrong-vm', 'replacement'] as const)(
		'rejects %s before starting a transfer',
		async (failure) => {
			// Arrange
			const fixture = arrange();
			if (failure === 'wrong-agent') fixture.state.agentId = 'ember';
			if (failure === 'missing') fixture.state.current = false;
			if (failure === 'wrong-vm') fixture.state.vmId = 'replacement';
			const use = vi.fn(async () => 'unexpected');
			// Act / Assert
			await expect(
				withCurrentToolVmWorkFiles({
					agentId: 'sun',
					authority,
					executionProof,
					leaseManager: fixture.leases,
					program: 'fixed',
					signal: new AbortController().signal,
					...(failure === 'replacement'
						? { expectedBinding: { leaseId: 'old', leafGeneration: 'leaf', vmId: 'tool-vm' } }
						: {}),
					use,
				}),
			).rejects.toThrow('unavailable');
			expect(use).not.toHaveBeenCalled();
			expect(fixture.start).not.toHaveBeenCalled();
		},
	);

	it.each(['retirement', 'heartbeat-loss'] as const)(
		'aborts active access on %s and reports failure',
		async (failure) => {
			// Arrange
			const fixture = arrange();
			// Act / Assert
			await expect(
				withCurrentToolVmWorkFiles({
					agentId: 'sun',
					authority,
					executionProof,
					leaseManager: fixture.leases,
					program: 'fixed',
					signal: new AbortController().signal,
					use: async (access) => {
						if (failure === 'retirement') await fixture.retire();
						else {
							fixture.state.heartbeatAvailable = false;
							await vi.advanceTimersByTimeAsync(1200);
						}
						expect(access.signal.aborted).toBe(true);
						return 'must not report complete';
					},
				}),
			).rejects.toThrow('unavailable');
			expect(fixture.end).toHaveBeenCalledWith(
				'lease',
				expect.any(String),
				expect.objectContaining({ outcome: 'failed' }),
			);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
