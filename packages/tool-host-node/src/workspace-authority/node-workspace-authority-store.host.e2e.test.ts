import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { expect, it } from 'vitest';
import { z } from 'zod';

const resultSchema = z.object({ pid: z.number().int().positive(), result: z.unknown() });
const fixturePath = resolve(
	'packages/tool-host-node/src/workspace-authority/test-fixtures/workspace-authority-process.ts',
);

function startAuthorityProcess(
	databasePath: string,
	operation: string,
): {
	readonly ready: Promise<void>;
	readonly release: () => void;
	readonly result: Promise<z.infer<typeof resultSchema>>;
} {
	const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, databasePath, operation], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const ready = Promise.withResolvers<void>();
	const replies: unknown[] = [];
	let errors = '';
	child.stderr.on('data', (chunk: Buffer) => {
		errors += chunk.toString();
	});
	const lines = createInterface({ input: child.stdout });
	lines.on('line', (line) => {
		const parsed: unknown = JSON.parse(line);
		if (z.object({ ready: z.literal(true) }).safeParse(parsed).success) ready.resolve();
		else replies.push(parsed);
	});
	const result = once(child, 'close').then(([code]) => {
		lines.close();
		if (code !== 0) throw new Error(`Authority process failed (${String(code)}): ${errors}`);
		if (replies.length !== 1) throw new Error('Expected one authority process result');
		return resultSchema.parse(replies[0]);
	});
	return {
		ready: Promise.race([ready.promise, result.then(() => undefined)]),
		release: () => child.stdin.end('go\n'),
		result,
	};
}

it('does not forget the acknowledged notice ID, removal mark or approval replay after a real process exits', async () => {
	// Arrange
	const databasePath = join(
		await mkdtemp(join(tmpdir(), 'identity-authority-process-')),
		'workspace.sqlite',
	);
	// Act: the recording process fully exits before a different process opens its file.
	const recorded = await startAuthorityProcess(databasePath, 'record').result;
	const reopened = await startAuthorityProcess(databasePath, 'read').result;
	// Assert
	expect(reopened.pid).not.toBe(recorded.pid);
	expect(recorded.result).toEqual({
		notice: { result: 'recorded', noticeId: '019a1335-20c0-7000-8000-000000000001' },
		approval: { ok: true },
	});
	expect(reopened.result).toEqual({
		mark: 8,
		notice: { result: 'alreadyRecorded', noticeId: '019a1335-20c0-7000-8000-000000000001' },
		approval: { ok: false, reason: 'replayed' },
		uses: { 'principal:approval': 20_000 },
	});
});

it('does not accept the same first approval use from two processes released against one SQLite file', async () => {
	// Arrange: both connections are open before either decision is released.
	const databasePath = join(
		await mkdtemp(join(tmpdir(), 'identity-authority-contention-')),
		'workspace.sqlite',
	);
	const first = startAuthorityProcess(databasePath, 'contend');
	const second = startAuthorityProcess(databasePath, 'contend');
	await Promise.all([first.ready, second.ready]);
	// Act
	first.release();
	second.release();
	const replies = await Promise.all([first.result, second.result]);
	// Assert
	expect(replies[0]?.pid).not.toBe(replies[1]?.pid);
	expect(replies.map((reply) => reply.result)).toEqual(
		expect.arrayContaining([{ ok: true }, { ok: false, reason: 'replayed' }]),
	);
});
