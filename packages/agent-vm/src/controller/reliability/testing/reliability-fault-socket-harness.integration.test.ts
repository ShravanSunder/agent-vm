import { access, mkdtemp, readdir, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ReliabilityFaultAuthority } from './reliability-fault-authority.js';
import { createReliabilityFaultPort } from './reliability-fault-port.js';
import {
	resolveReliabilityFaultSocketPaths,
	startReliabilityFaultSocketHarness,
} from './reliability-fault-socket-harness.js';
import type {
	ReliabilityFaultApplyRequest,
	ReliabilityFaultReceipt,
	ReliabilityFaultRefusalReason,
} from './reliability-test-fault-contracts.js';

const request = {
	action: 'disconnect-control-transport',
	actionId: '0d3e8dc2-8d6b-4e63-8d1d-8c10a159d8af',
	authorityId: 'f5867f86-f1bc-4d60-967c-985686db5528',
	expiresAtMs: 2_000,
	fences: {
		controller: { generation: 7, id: 'controller-a' },
		controlSession: { generation: 11, id: 'session-a' },
		gateway: { generation: 8, id: 'gateway-a' },
		leaseLeaf: { generation: 13, id: 'agent-a' },
	},
	issuedAtMs: 1_000,
	nonce: 'L9g15AipZmeLzG1IR6pB3w',
	runId: 'reliability-run-a',
	schemaVersion: 1,
	target: { generation: 11, id: 'session-a', kind: 'control-session' },
} satisfies ReliabilityFaultApplyRequest;

function createRefusalReceipt(
	requestToRefuse: ReliabilityFaultApplyRequest,
	reason: ReliabilityFaultRefusalReason,
): ReliabilityFaultReceipt {
	return {
		action: requestToRefuse.action,
		actionId: requestToRefuse.actionId,
		authorityId: requestToRefuse.authorityId,
		fences: requestToRefuse.fences,
		reason,
		receiptId: 'c15b991a-a006-4faf-8fc7-33d3c1d82395',
		recordedAtMs: 1_500,
		runId: requestToRefuse.runId,
		schemaVersion: 1,
		state: 'refused',
		target: requestToRefuse.target,
	};
}

function createAppliedReceipt(
	requestToApply: ReliabilityFaultApplyRequest,
): ReliabilityFaultReceipt {
	return {
		action: requestToApply.action,
		actionId: requestToApply.actionId,
		authorityId: requestToApply.authorityId,
		fences: requestToApply.fences,
		receiptId: 'd25b991a-a006-4faf-8fc7-33d3c1d82395',
		recordedAtMs: 1_500,
		restorationDeadlineMs: 2_500,
		runId: requestToApply.runId,
		schemaVersion: 1,
		state: 'applied',
		target: requestToApply.target,
	};
}

async function exchangeUnixSocket(socketPath: string, payload: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const socket = connect(socketPath);
		let response = '';
		socket.setEncoding('utf8');
		socket.on('connect', () => socket.write(payload));
		socket.on('data', (chunk: string) => {
			response += chunk;
		});
		socket.on('end', () => resolve(response));
		socket.on('error', reject);
	});
}

describe('reliability fault Unix socket harness', () => {
	it('refuses an existing symlink at the per-run directory boundary', async () => {
		const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-fault-symlink-'));
		const outsideDirectory = await mkdtemp(path.join(tmpdir(), 'agent-vm-fault-outside-'));
		const paths = resolveReliabilityFaultSocketPaths(runtimeRoot, request.runId);
		await symlink(outsideDirectory, paths.runtimeDirectoryPath);
		try {
			const port = createReliabilityFaultPort({ createRefusalReceipt, handlers: {} });
			if (port === undefined) {
				throw new Error('Expected explicit test port.');
			}
			await expect(
				startReliabilityFaultSocketHarness({
					authority: new ReliabilityFaultAuthority({
						authorityId: request.authorityId,
						nowMs: () => 1_500,
						runId: request.runId,
					}),
					mode: 'reliability-test',
					ownedRuntimeDirectory: runtimeRoot,
					port,
					runId: request.runId,
				}),
			).rejects.toThrow(/already exists/u);
			await expect(access(path.join(outsideDirectory, 'fault.sock'))).rejects.toThrow();
		} finally {
			await unlink(paths.runtimeDirectoryPath);
			await rmdir(runtimeRoot);
			await rmdir(outsideDirectory);
		}
	});

	it('is unreachable in production mode', async () => {
		const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-fault-production-'));
		try {
			const port = createReliabilityFaultPort({
				createRefusalReceipt,
				handlers: {},
			});
			if (port === undefined) {
				throw new Error('Expected explicit test port.');
			}
			const harness = await startReliabilityFaultSocketHarness({
				authority: new ReliabilityFaultAuthority({
					authorityId: request.authorityId,
					nowMs: () => 1_500,
					runId: request.runId,
				}),
				mode: 'production',
				ownedRuntimeDirectory: runtimeRoot,
				port,
				runId: request.runId,
			});

			expect(harness).toBeUndefined();
			expect(await readdir(runtimeRoot)).toEqual([]);
		} finally {
			await rmdir(runtimeRoot);
		}
	});

	it('locks permissions and returns only closed receipts for apply, replay, and wrong-run', async () => {
		const runtimeRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-fault-test-'));
		const port = createReliabilityFaultPort({
			createRefusalReceipt,
			handlers: {
				'disconnect-control-transport': (requestToApply) =>
					Promise.resolve(createAppliedReceipt(requestToApply)),
			},
		});
		if (port === undefined) {
			throw new Error('Expected explicit test port.');
		}
		const harness = await startReliabilityFaultSocketHarness({
			authority: new ReliabilityFaultAuthority({
				authorityId: request.authorityId,
				nowMs: () => 1_500,
				runId: request.runId,
			}),
			mode: 'reliability-test',
			ownedRuntimeDirectory: runtimeRoot,
			port,
			runId: request.runId,
		});
		if (harness === undefined) {
			throw new Error('Expected reliability-test harness.');
		}
		try {
			const directoryMode = (await stat(harness.paths.runtimeDirectoryPath)).mode & 0o777;
			const socketMode = (await stat(harness.paths.socketPath)).mode & 0o777;
			expect(directoryMode).toBe(0o700);
			expect(socketMode).toBe(0o600);

			const applied = await exchangeUnixSocket(
				harness.paths.socketPath,
				`${JSON.stringify(request)}\n`,
			);
			expect(JSON.parse(applied)).toMatchObject({ state: 'applied' });
			const replayed = await exchangeUnixSocket(
				harness.paths.socketPath,
				`${JSON.stringify(request)}\n`,
			);
			expect(JSON.parse(replayed)).toMatchObject({
				reason: 'replayed-request',
				state: 'refused',
			});
			const wrongRun = await exchangeUnixSocket(
				harness.paths.socketPath,
				`${JSON.stringify({
					...request,
					actionId: '90c53d0e-3af4-4a89-a828-76da94ee3234',
					nonce: 'another_nonce_value',
					runId: 'wrong-run',
				})}\n`,
			);
			expect(JSON.parse(wrongRun)).toMatchObject({ reason: 'wrong-run', state: 'refused' });

			expect(await exchangeUnixSocket(harness.paths.socketPath, '{malformed}\n')).toBe('');
			expect(
				await exchangeUnixSocket(harness.paths.socketPath, `${'x'.repeat(16 * 1_024 + 1)}\n`),
			).toBe('');
		} finally {
			await harness.close();
			await rmdir(runtimeRoot);
		}
	});
});
