import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type CheckGateCommandId =
	| 'build'
	| 'lint'
	| 'managed-vm-boundaries'
	| 'managed-vm-contracts'
	| 'package-versions'
	| 'portal-architecture'
	| 'portal-contracts'
	| 'portal-exports'
	| 'zod-version'
	| 'test-taxonomy'
	| 'vm-ownership-boundaries'
	| 'reliability-fault-boundaries'
	| 'format'
	| 'type-aware-lint'
	| 'typecheck';

export interface CheckGateCommand {
	readonly args: readonly string[];
	readonly command: string;
	readonly id: CheckGateCommandId;
	readonly label: string;
}

export interface CheckGatePhase {
	readonly commands: readonly CheckGateCommand[];
	readonly name: string;
}

export type CheckGateCommandStatus = 'passed' | 'failed';

export interface CheckGateCommandResult {
	readonly command: CheckGateCommand;
	readonly durationMs: number;
	readonly errorMessage?: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly status: CheckGateCommandStatus;
	readonly stderr: string;
	readonly stdout: string;
}

export interface CheckGateSummary {
	readonly failedCount: number;
	readonly lines: readonly string[];
	readonly ok: boolean;
	readonly passedCount: number;
	readonly totalDurationMs: number;
}

export type CheckGateCommandRunner = (command: CheckGateCommand) => Promise<CheckGateCommandResult>;

interface RunCheckGateOptions {
	readonly commandRunner?: CheckGateCommandRunner;
	readonly now?: () => number;
	readonly stderr?: NodeJS.WritableStream;
	readonly stdout?: NodeJS.WritableStream;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createCheckGatePlan(): readonly CheckGatePhase[] {
	return [
		{
			commands: [
				{
					args: ['run', 'build'],
					command: 'pnpm',
					id: 'build',
					label: 'workspace build',
				},
			],
			name: 'build artifacts',
		},
		{
			commands: [
				{
					args: ['run', 'check:package-versions'],
					command: 'pnpm',
					id: 'package-versions',
					label: 'package version sync',
				},
				{
					args: ['run', 'check:zod'],
					command: 'pnpm',
					id: 'zod-version',
					label: 'zod version guard',
				},
				{
					args: ['run', 'test:taxonomy'],
					command: 'pnpm',
					id: 'test-taxonomy',
					label: 'test taxonomy audit',
				},
				{
					args: ['run', 'test:portal-architecture'],
					command: 'pnpm',
					id: 'portal-architecture',
					label: 'portal architecture audit',
				},
				{
					args: ['run', 'test:portal-exports'],
					command: 'pnpm',
					id: 'portal-exports',
					label: 'portal package export audit',
				},
				{
					args: ['exec', 'tsx', 'scripts/generate-portal-contracts.ts', '--check-clean'],
					command: 'pnpm',
					id: 'portal-contracts',
					label: 'generated portal contract freshness',
				},
				{
					args: ['run', 'test:managed-vm-boundaries'],
					command: 'pnpm',
					id: 'managed-vm-boundaries',
					label: 'managed VM package boundary audit',
				},
				{
					args: ['exec', 'tsx', 'scripts/verify-managed-vm-contracts.ts', '--skip-workspace-build'],
					command: 'pnpm',
					id: 'managed-vm-contracts',
					label: 'managed VM contract and declaration verifier',
				},
				{
					args: ['run', 'test:vm-ownership-boundaries'],
					command: 'pnpm',
					id: 'vm-ownership-boundaries',
					label: 'VM ownership boundary audit',
				},
				{
					args: ['run', 'test:reliability-fault-boundaries'],
					command: 'pnpm',
					id: 'reliability-fault-boundaries',
					label: 'reliability fault boundary audit',
				},
				{
					args: ['run', 'lint'],
					command: 'pnpm',
					id: 'lint',
					label: 'lint',
				},
				{
					args: ['run', 'fmt:check'],
					command: 'pnpm',
					id: 'format',
					label: 'format check',
				},
			],
			name: 'fast independent checks',
		},
		{
			commands: [
				{
					args: ['run', 'lint:types'],
					command: 'pnpm',
					id: 'type-aware-lint',
					label: 'type-aware lint',
				},
				{
					args: ['run', 'typecheck'],
					command: 'pnpm',
					id: 'typecheck',
					label: 'typecheck',
				},
			],
			name: 'heavy static checks',
		},
	];
}

export function formatCheckGateDuration(durationMs: number): string {
	return `${(durationMs / 1000).toFixed(2)}s`;
}

export function summarizeCheckGateResults(
	results: readonly CheckGateCommandResult[],
	totalDurationMs: number,
): CheckGateSummary {
	const failedResults = results.filter((result) => result.status === 'failed');
	const passedCount = results.length - failedResults.length;
	const lines = [
		`check gate: ${String(passedCount)} passed, ${String(failedResults.length)} failed in ${formatCheckGateDuration(totalDurationMs)}`,
		...results.map((result) => {
			const marker = result.status === 'passed' ? 'PASS' : 'FAIL';
			const suffix =
				result.status === 'passed'
					? ''
					: result.exitCode === null
						? ` (${result.signal ?? result.errorMessage ?? 'no exit code'})`
						: ` (exit ${String(result.exitCode)})`;
			return `${marker} ${result.command.id}: ${result.command.label} ${formatCheckGateDuration(result.durationMs)}${suffix}`;
		}),
	];
	return {
		failedCount: failedResults.length,
		lines,
		ok: failedResults.length === 0,
		passedCount,
		totalDurationMs,
	};
}

function stringifyOutput(chunks: readonly Buffer[]): string {
	return Buffer.concat(chunks).toString('utf8');
}

export async function runCheckGateCommand(
	commandToRun: CheckGateCommand,
	now: () => number = () => performance.now(),
): Promise<CheckGateCommandResult> {
	const startTimeMs = now();
	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];

	return await new Promise<CheckGateCommandResult>((resolve) => {
		let spawnErrorMessage: string | undefined;
		const childProcess = spawn(commandToRun.command, [...commandToRun.args], {
			cwd: repositoryRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		childProcess.stdout?.on('data', (chunk: Buffer) => {
			stdoutChunks.push(chunk);
		});
		childProcess.stderr?.on('data', (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});
		childProcess.on('error', (error) => {
			spawnErrorMessage = error.message;
		});
		childProcess.on('close', (exitCode, signal) => {
			resolve({
				command: commandToRun,
				durationMs: now() - startTimeMs,
				...(spawnErrorMessage === undefined ? {} : { errorMessage: spawnErrorMessage }),
				exitCode,
				signal,
				status:
					exitCode === 0 && signal === null && spawnErrorMessage === undefined
						? 'passed'
						: 'failed',
				stderr: stringifyOutput(stderrChunks),
				stdout: stringifyOutput(stdoutChunks),
			});
		});
	});
}

function writeCommandOutput(stream: NodeJS.WritableStream, result: CheckGateCommandResult): void {
	if (result.stdout.length > 0) {
		stream.write(`\n[${result.command.id}] stdout\n${result.stdout}`);
		if (!result.stdout.endsWith('\n')) {
			stream.write('\n');
		}
	}
	if (result.stderr.length > 0) {
		stream.write(`\n[${result.command.id}] stderr\n${result.stderr}`);
		if (!result.stderr.endsWith('\n')) {
			stream.write('\n');
		}
	}
}

export async function runCheckGate(
	phases: readonly CheckGatePhase[] = createCheckGatePlan(),
	options: RunCheckGateOptions = {},
): Promise<CheckGateSummary> {
	const commandRunner = options.commandRunner ?? ((command) => runCheckGateCommand(command));
	const now = options.now ?? (() => performance.now());
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	const startTimeMs = now();
	const results: CheckGateCommandResult[] = [];

	for (const phase of phases) {
		stdout.write(`\ncheck phase: ${phase.name}\n`);
		// oxlint-disable-next-line no-await-in-loop -- phases are intentionally serial; commands inside a phase run together.
		const phaseResults = await Promise.all(
			phase.commands.map(async (command) => await commandRunner(command)),
		);
		for (const result of phaseResults) {
			results.push(result);
			writeCommandOutput(result.status === 'passed' ? stdout : stderr, result);
		}
		if (phaseResults.some((result) => result.status === 'failed')) {
			break;
		}
	}

	const summary = summarizeCheckGateResults(results, now() - startTimeMs);
	const summaryStream = summary.ok ? stdout : stderr;
	summaryStream.write('\n');
	for (const line of summary.lines) {
		summaryStream.write(`${line}\n`);
	}
	return summary;
}

async function main(): Promise<void> {
	try {
		const summary = await runCheckGate();
		if (!summary.ok) {
			process.exit(1);
		}
	} catch (error) {
		process.stderr.write(
			`Unhandled error in check gate: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
		);
		process.exit(1);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	await main();
}
