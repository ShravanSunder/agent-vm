import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { z } from 'zod';

import { cachedOwnerTokenSchema, type AuthTarget } from '#auth/native-owner-cli/auth-target';
import { recordAuthProofPhase } from '#auth/test-fixtures/auth-proof-phase-recording';

/** Reuses the actual CLI cache on the next command, so server live-status rejection remains observable. */
export async function runCachedNativeOwnerCommand(props: {
	readonly target: AuthTarget;
	readonly repositoryRoot: string;
	readonly args: readonly string[];
}): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
	try {
		const output = await promisify(execFile)(
			process.execPath,
			[
				'scripts/verify-auth/owner-cli.ts',
				'--target',
				path.join(path.dirname(props.target.tokenCachePath), 'owner-cli-target.json'),
				'--no-browser',
				...props.args,
			],
			{ cwd: props.repositoryRoot, timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		return { code: 0, ...output };
	} catch (error) {
		const failure = z
			.object({
				code: z.union([z.number(), z.string(), z.null()]),
				signal: z.string().nullable(),
				killed: z.boolean(),
				stdout: z.string(),
				stderr: z.string(),
			})
			.parse(error);
		const authorizationUrlPrinted = failure.stdout.includes('AUTHORIZATION_URL=');
		await recordAuthProofPhase({
			kind: 'cli-exit',
			code: failure.code,
			signal: failure.signal,
			killed: failure.killed,
			authorizationUrlPrinted,
			targetOrigin: new URL(props.target.issuer).origin,
		});
		if (typeof failure.code !== 'number' || failure.signal !== null || failure.killed)
			throw new Error(
				`Owner CLI did not exit normally (code=${String(failure.code)}, signal=${String(failure.signal)}, killed=${String(failure.killed)}, authorizationUrlPrinted=${String(authorizationUrlPrinted)}); termination is not an owner refusal`,
				{ cause: error },
			);
		return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
	}
}

/** Exercises the delivered entry, argument parsing, PKCE loopback and private cache, not only its login helper. */
export async function loginThroughNativeOwnerCli(props: {
	readonly target: AuthTarget;
	readonly repositoryRoot: string;
	readonly browser: (url: string) => Promise<readonly string[]>;
}): Promise<string> {
	const targetFile = path.join(path.dirname(props.target.tokenCachePath), 'owner-cli-target.json');
	await writeFile(targetFile, JSON.stringify(props.target), { mode: 0o600 });
	const child = spawn(
		process.execPath,
		[
			'scripts/verify-auth/owner-cli.ts',
			'--target',
			targetFile,
			'--no-browser',
			'--force-auth',
			'login',
		],
		{
			cwd: props.repositoryRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
			signal: AbortSignal.timeout(120_000),
		},
	);
	const ending = new Promise<number>((resolveEnd, rejectEnd) => {
		child.once('error', rejectEnd);
		child.once('exit', (code) => resolveEnd(code ?? 1));
	});
	const output: string[] = [];
	const sensitiveValues: string[] = [];
	const stdout = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stdout })) {
			output.push(line);
			if (line.startsWith('AUTHORIZATION_URL='))
				sensitiveValues.push(...(await props.browser(line.slice('AUTHORIZATION_URL='.length))));
		}
	})();
	const stderr = (async (): Promise<void> => {
		for await (const line of createInterface({ input: child.stderr })) {
			output.push(line);
		}
	})();
	try {
		const [exitCode] = await Promise.all([ending, stdout, stderr]);
		if (exitCode !== 0) throw new Error(`Delivered native CLI failed (${exitCode})`);
		const cached = cachedOwnerTokenSchema.parse(
			JSON.parse(await readFile(props.target.tokenCachePath, 'utf8')),
		);
		if (
			output.some((line) =>
				[cached.token, ...sensitiveValues].some((value) => value !== '' && line.includes(value)),
			)
		)
			throw new Error('Delivered native CLI logged a captured credential or authorization code');
		return cached.token;
	} finally {
		if (child.exitCode === null) child.kill('SIGTERM');
	}
}
