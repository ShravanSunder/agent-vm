import * as hegel from '@hegeldev/hegel';
import * as generators from '@hegeldev/hegel/generators';
import { expect, it } from 'vitest';

import type { WorkspaceAuthorityStore } from '#tool-host-core/workspace-authority/models/workspace-authority-store';
import { createVolatileAuthorityStore } from '#tool-host-core/workspace-authority/volatile-authority-store';
import { createWorkspaceAuthority } from '#tool-host-core/workspace-authority/workspace-authority';

interface IssuedToken {
	readonly tokenId: string;
	readonly expiresAtMs: number;
}

interface AuthorityScenario {
	readonly cap: number;
	readonly clock: { nowMs: number };
	readonly writes: { failNext: boolean };
	readonly store: WorkspaceAuthorityStore;
	authority: ReturnType<typeof createWorkspaceAuthority>;
	readonly issued: hegel.stateful.Pool<IssuedToken>;
	readonly replayModel: Map<string, number>;
}

const writeFailure = new Error('controlled authority write failure');

function createAuthorityScenario(tc: hegel.TestCase): AuthorityScenario {
	const clock = { nowMs: 100 };
	const writes = { failNext: false };
	const retained = createVolatileAuthorityStore();
	const store: WorkspaceAuthorityStore = {
		read: retained.read,
		write: (key, value) => store.transaction(async (storage) => storage.write(key, value)),
		transaction: (decide) =>
			retained.transaction((storage) =>
				decide({
					read: storage.read,
					write: async (key, value) => {
						await storage.write(key, value);
						if (writes.failNext) {
							writes.failNext = false;
							throw writeFailure;
						}
					},
				}),
			),
	};
	const cap = tc.draw(generators.sampledFrom([2, 32, 128, 1024]));
	return {
		cap,
		clock,
		writes,
		store,
		authority: createWorkspaceAuthority({ store, clock: { nowMs: () => clock.nowMs }, cap }),
		issued: new hegel.stateful.Pool<IssuedToken>(tc),
		replayModel: new Map(),
	};
}

// Independent byte budget: braces, comma separators, quoted keys, colon, decimal expiry.
function replayRecordBytes(records: ReadonlyMap<string, number>): number {
	let byteCount = 2;
	for (const [tokenId, expiry] of records) {
		byteCount += new TextEncoder().encode(JSON.stringify(tokenId)).byteLength;
		byteCount += 1 + String(expiry).length;
	}
	return byteCount + Math.max(0, records.size - 1);
}

async function consumeToken(scenario: AuthorityScenario, token: IssuedToken): Promise<void> {
	const liveExpiry = scenario.replayModel.get(token.tokenId);
	if (liveExpiry !== undefined && liveExpiry > scenario.clock.nowMs) {
		expect(await scenario.authority.consumeApprovalToken(token.tokenId, token.expiresAtMs)).toEqual(
			{
				ok: false,
				reason: 'replayed',
			},
		);
		return;
	}
	const proposed = new Map<string, number>();
	for (const [tokenId, expiry] of scenario.replayModel) {
		if (expiry > scenario.clock.nowMs) proposed.set(tokenId, expiry);
	}
	proposed.set(token.tokenId, token.expiresAtMs);
	if (replayRecordBytes(proposed) > scenario.cap) {
		expect(await scenario.authority.consumeApprovalToken(token.tokenId, token.expiresAtMs)).toEqual(
			{
				ok: false,
				reason: 'replay-cache-full',
			},
		);
		return;
	}
	if (scenario.writes.failNext) {
		await expect(
			scenario.authority.consumeApprovalToken(token.tokenId, token.expiresAtMs),
		).rejects.toBe(writeFailure);
		return;
	}
	expect(await scenario.authority.consumeApprovalToken(token.tokenId, token.expiresAtMs)).toEqual({
		ok: true,
	});
	scenario.replayModel.clear();
	for (const [tokenId, expiry] of proposed) scenario.replayModel.set(tokenId, expiry);
}

const authorityMachine: hegel.stateful.StateMachine<AuthorityScenario> = {
	rules: {
		issueToken: (tc, scenario) => {
			scenario.issued.add({
				tokenId: tc.draw(generators.sampledFrom(['token-a', 'token-b', 'é-token'])),
				expiresAtMs:
					scenario.clock.nowMs + tc.draw(generators.integers({ minValue: 1, maxValue: 100 })),
			});
		},
		consumeIssuedToken: async (tc, scenario) => {
			const token = tc.draw(scenario.issued.valuesReusable());
			tc.note(`consume ${token.tokenId} exp=${token.expiresAtMs} now=${scenario.clock.nowMs}`);
			await consumeToken(scenario, token);
		},
		consumeFreshToken: async (tc, scenario) => {
			const token = {
				tokenId: `fresh-${tc.draw(generators.integers({ minValue: 0, maxValue: 10 }))}`,
				expiresAtMs: scenario.clock.nowMs + 100,
			};
			scenario.issued.add(token);
			await consumeToken(scenario, token);
		},
		advanceClock: (tc, scenario) => {
			scenario.clock.nowMs += tc.draw(generators.integers({ minValue: 0, maxValue: 100 }));
		},
		reopenAuthority: (_tc, scenario) => {
			// Same process-local retained store, not a claim about durable storage or deployment.
			scenario.authority = createWorkspaceAuthority({
				store: scenario.store,
				clock: { nowMs: () => scenario.clock.nowMs },
				cap: scenario.cap,
			});
		},
		failNextWrite: (_tc, scenario) => {
			scenario.writes.failNext = true;
		},
	},
	invariants: {
		committedReplayRecordsMatchModel: {
			alwaysCheck: true,
			check: async (_tc, scenario) => {
				expect((await scenario.store.read('approval-uses-v1')) ?? {}).toEqual(
					Object.fromEntries(scenario.replayModel),
				);
			},
		},
	},
};

it('models first use, capacity, write rollback, and reopening across generated sequences', async () => {
	await hegel.testAsync(
		async (tc) => {
			await hegel.stateful.runAsync(tc, authorityMachine, createAuthorityScenario(tc));
		},
		{ testCases: 100, derandomize: true, database: hegel.Database.disabled },
	);
});
