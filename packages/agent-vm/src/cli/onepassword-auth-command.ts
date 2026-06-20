import readline from 'node:readline/promises';
import { Writable } from 'node:stream';

import { stripOpReadStdoutTerminator, type ExecFileResult } from '@agent-vm/secret-management';
import { execa } from 'execa';

import type { SystemConfig } from '../config/system-config.js';
import type { CliDependencies, CliIo } from './agent-vm-cli-support.js';
import {
	resolveServiceAccountKeychainTarget,
	storeServiceAccountToken,
} from './keychain-credential.js';

interface OnePasswordAuthCommandDependencies {
	readonly createReadlineInterface?: () => readline.Interface;
	readonly runCommand?: CliDependencies['runCommand'];
	readonly stdinIsTty?: () => boolean;
	readonly storeServiceAccountToken?: typeof storeServiceAccountToken;
}

function readOnePasswordKeychainTokenSource(systemConfig: SystemConfig): {
	readonly account: string;
	readonly service: string;
} {
	const secretsProvider = systemConfig.host.secretsProvider;
	if (secretsProvider?.type !== '1password') {
		throw new Error('agent-vm auth 1password requires host.secretsProvider.type="1password".');
	}
	const tokenSource = secretsProvider.tokenSource;
	if (tokenSource.type !== 'keychain') {
		throw new Error(
			'agent-vm auth 1password requires host.secretsProvider.tokenSource.type="keychain".',
		);
	}
	return resolveServiceAccountKeychainTarget({
		account: tokenSource.account,
		service: tokenSource.service,
	});
}

async function runOpRead(
	tokenReference: string,
	dependencies: Pick<OnePasswordAuthCommandDependencies, 'runCommand'>,
): Promise<string> {
	const runCommand =
		dependencies.runCommand ??
		(async (
			command: string,
			arguments_: readonly string[],
		): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> => {
			const result: ExecFileResult = await execa(command, [...arguments_]);
			return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
		});
	const result = await runCommand('op', ['read', tokenReference]);
	if (result.exitCode !== 0) {
		throw new Error('Failed to read 1Password service account token with op read.');
	}
	return stripOpReadStdoutTerminator(result.stdout);
}

async function readInteractiveToken(
	io: CliIo,
	dependencies: Pick<OnePasswordAuthCommandDependencies, 'createReadlineInterface' | 'stdinIsTty'>,
): Promise<string> {
	const stdinIsTty = dependencies.stdinIsTty ?? (() => process.stdin.isTTY === true);
	if (!stdinIsTty()) {
		throw new Error(
			'agent-vm auth 1password requires a token ref/url argument when stdin is not interactive.',
		);
	}

	const mutedOutput = new Writable({
		write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
			callback();
		},
	});
	const rl =
		dependencies.createReadlineInterface?.() ??
		readline.createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
	try {
		io.stderr.write('Paste your 1Password service account token:\n> ');
		const token = await rl.question('');
		io.stderr.write('\n');
		return token;
	} finally {
		rl.close();
	}
}

export async function runOnePasswordAuthCommand(options: {
	readonly dependencies?: OnePasswordAuthCommandDependencies;
	readonly io: CliIo;
	readonly systemConfig: SystemConfig;
	readonly tokenReference?: string;
}): Promise<void> {
	const dependencies = options.dependencies ?? {};
	const target = readOnePasswordKeychainTokenSource(options.systemConfig);
	const token =
		options.tokenReference === undefined
			? await readInteractiveToken(options.io, dependencies)
			: await runOpRead(options.tokenReference, dependencies);
	const trimmedToken = token.trim();
	if (trimmedToken.length === 0) {
		throw new Error('1Password service account token is empty.');
	}

	const storeToken = dependencies.storeServiceAccountToken ?? storeServiceAccountToken;
	storeToken(trimmedToken, {
		account: target.account,
		service: target.service,
	});
	options.io.stdout.write(
		`Stored 1Password service account token in macOS Keychain service '${target.service}' account '${target.account}'.\n`,
	);
}
