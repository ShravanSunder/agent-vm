/* oxlint-disable typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-type-assertion -- dynamic imports and child JSON cross a local Gondolin checkout boundary */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import {
	formatDurationRange,
	type BenchmarkSampleTiming,
} from '../../packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts';

type WorkerGitLayout = 'full-rootfs' | 'full-realfs' | 'rootfs-worktree-realfs-gitdir';

interface WorkerGitOptions {
	readonly fileCount: number;
	readonly gondolinRepo: string;
	readonly imagePath: string | null;
	readonly jsonOut: string | null;
	readonly largeMiB: number;
	readonly samples: number;
	readonly startTimeoutMs: number;
	readonly warmupSamples: number;
}

interface WorkerGitSample extends BenchmarkSampleTiming {
	readonly gitAddInitialMs: number;
	readonly gitAddModifiedMs: number;
	readonly gitCommitMs: number;
	readonly gitDiffMs: number;
	readonly gitStatusCleanMs: number;
	readonly gitStatusDirtyMs: number;
	readonly modifyFilesMs: number;
}

interface WorkerGitResult {
	readonly layout: WorkerGitLayout;
	readonly ok: true;
	readonly samples: readonly WorkerGitSample[];
	readonly summary: WorkerGitSummary;
}

interface WorkerGitFailure {
	readonly error: string;
	readonly layout: WorkerGitLayout;
	readonly ok: false;
}

type WorkerGitLayoutResult = WorkerGitFailure | WorkerGitResult;

interface WorkerGitSummary {
	readonly gitAddInitialMs: DurationSummary;
	readonly gitAddModifiedMs: DurationSummary;
	readonly gitCommitMs: DurationSummary;
	readonly gitDiffMs: DurationSummary;
	readonly gitStatusCleanMs: DurationSummary;
	readonly gitStatusDirtyMs: DurationSummary;
	readonly largeWriteMs: DurationSummary;
	readonly modifyFilesMs: DurationSummary;
	readonly smallReadMs: DurationSummary;
	readonly smallWriteMs: DurationSummary;
}

interface DurationSummary {
	readonly max: number;
	readonly median: number;
	readonly min: number;
}

interface WorkerGitOutput {
	readonly benchmark: {
		readonly fileCount: number;
		readonly gondolinRepo: string;
		readonly imagePath: string | null;
		readonly largeMiB: number;
		readonly samples: number;
		readonly startedAt: string;
		readonly startTimeoutMs: number;
		readonly warmupSamples: number;
	};
	readonly environment: {
		readonly df: string;
		readonly host: {
			readonly arch: string;
			readonly node: string;
			readonly platform: string;
			readonly release: string;
		};
		readonly mounts: string;
		readonly uname: string;
	};
	readonly results: readonly WorkerGitLayoutResult[];
}

interface ManagedBenchmarkVm {
	close(): Promise<void>;
	exec(command: readonly string[]): Promise<{
		readonly exitCode: number;
		readonly stderr: string;
		readonly stdout: string;
	}>;
}

interface VmConstructor {
	create(options: {
		readonly rootfs: { readonly mode: 'cow' };
		readonly sandbox?: { readonly imagePath?: string };
		readonly startTimeoutMs: number;
		readonly vfs: {
			readonly mounts: Record<string, VirtualProvider>;
		};
	}): Promise<ManagedBenchmarkVm>;
}

type VirtualProvider = object;

interface GondolinModules {
	readonly RealFSProvider: new (hostPath: string) => VirtualProvider;
	readonly VM: VmConstructor;
}

function parseCliArgs(argv: readonly string[]): WorkerGitOptions {
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (current === '--') {
			continue;
		}
		if (!current.startsWith('--')) {
			throw new Error(`unexpected positional argument: ${current}`);
		}
		const [rawKey, inlineValue] = current.slice(2).split('=', 2);
		if (inlineValue !== undefined) {
			values.set(rawKey, inlineValue);
			continue;
		}
		const next = argv[index + 1];
		if (next === undefined || next.startsWith('--')) {
			throw new Error(`--${rawKey} requires a value`);
		}
		values.set(rawKey, next);
		index += 1;
	}

	return {
		fileCount: parsePositiveInteger(values.get('file-count') ?? '1000', 'file-count'),
		gondolinRepo:
			values.get('gondolin-repo') ??
			process.env.GONDOLIN_REPO ??
			path.resolve(os.homedir(), 'Documents/dev/open-source/vm/gondolin'),
		imagePath: values.get('image-path') ?? null,
		jsonOut: values.get('json-out') ?? null,
		largeMiB: parsePositiveInteger(values.get('large-mib') ?? '32', 'large-mib'),
		samples: parsePositiveInteger(values.get('samples') ?? '3', 'samples'),
		startTimeoutMs: parsePositiveInteger(
			values.get('start-timeout-ms') ?? '30000',
			'start-timeout-ms',
		),
		warmupSamples: parseNonNegativeInteger(values.get('warmup-samples') ?? '1', 'warmup-samples'),
	};
}

function parsePositiveInteger(rawValue: string, name: string): number {
	const value = Number.parseInt(rawValue, 10);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`--${name} must be a positive integer, got ${rawValue}`);
	}
	return value;
}

function parseNonNegativeInteger(rawValue: string, name: string): number {
	const value = Number.parseInt(rawValue, 10);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`--${name} must be a non-negative integer, got ${rawValue}`);
	}
	return value;
}

async function loadGondolinModules(gondolinRepo: string): Promise<GondolinModules> {
	const hostSourceDir = path.join(gondolinRepo, 'host/src');
	const nodeModule = await import(
		pathToFileURL(path.join(hostSourceDir, 'vfs/node/index.ts')).href
	);
	const vmModule = await import(pathToFileURL(path.join(hostSourceDir, 'vm/core.ts')).href);

	return {
		RealFSProvider: getModuleExport(
			nodeModule,
			'RealFSProvider',
		) as GondolinModules['RealFSProvider'],
		VM: getModuleExport(vmModule, 'VM') as VmConstructor,
	};
}

function getModuleExport(moduleNamespace: object, exportName: string): unknown {
	if (!Object.hasOwn(moduleNamespace, exportName)) {
		throw new Error(`Gondolin module is missing export ${exportName}`);
	}
	return moduleNamespace[exportName as keyof typeof moduleNamespace];
}

function createHostDirectory(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCommand(vm: ManagedBenchmarkVm, command: string): Promise<string> {
	const result = await vm.exec(['/bin/sh', '-lc', command]);
	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${command}\n${result.stdout}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

async function runTimedCommand(vm: ManagedBenchmarkVm, command: string): Promise<number> {
	const start = performance.now();
	const result = await vm.exec(['/bin/sh', '-lc', command]);
	const elapsedMs = performance.now() - start;
	if (result.exitCode !== 0) {
		throw new Error(
			[
				`exit code ${result.exitCode}`,
				'--- command ---',
				command,
				'--- stdout ---',
				result.stdout,
				'--- stderr ---',
				result.stderr,
			].join('\n'),
		);
	}
	return elapsedMs;
}

function resolveLayoutPaths(layout: WorkerGitLayout): {
	readonly gitDir: string;
	readonly repoDir: string;
	readonly separateGitDir: boolean;
} {
	switch (layout) {
		case 'full-rootfs':
			return {
				gitDir: '/worker-rootfs/repo/.git',
				repoDir: '/worker-rootfs/repo',
				separateGitDir: false,
			};
		case 'full-realfs':
			return {
				gitDir: '/worker-realfs/repo/.git',
				repoDir: '/worker-realfs/repo',
				separateGitDir: false,
			};
		case 'rootfs-worktree-realfs-gitdir':
			return {
				gitDir: '/gitdirs/rootfs-worktree.git',
				repoDir: '/worker-rootfs-gitdir/repo',
				separateGitDir: true,
			};
		default: {
			const exhaustiveLayout: never = layout;
			throw new Error(`Unsupported worker git layout: ${String(exhaustiveLayout)}`);
		}
	}
}

async function prepareRepo(props: {
	readonly layout: WorkerGitLayout;
	readonly vm: ManagedBenchmarkVm;
}): Promise<void> {
	const paths = resolveLayoutPaths(props.layout);
	const gitInitCommand = paths.separateGitDir
		? `git init --separate-git-dir=${JSON.stringify(paths.gitDir)} ${JSON.stringify(paths.repoDir)}`
		: `mkdir -p ${JSON.stringify(paths.repoDir)} && git -C ${JSON.stringify(paths.repoDir)} init`;
	await runCommand(
		props.vm,
		[
			`rm -rf ${JSON.stringify(paths.repoDir)} ${JSON.stringify(paths.gitDir)}`,
			`mkdir -p ${JSON.stringify(path.dirname(paths.gitDir))} ${JSON.stringify(path.dirname(paths.repoDir))}`,
			gitInitCommand,
			`${gitForPaths(paths)} config user.email worker-bench@example.invalid`,
			`${gitForPaths(paths)} config user.name worker-bench`,
			`${gitForPaths(paths)} config commit.gpgsign false`,
		].join('\n'),
	);
}

function gitForPaths(paths: { readonly gitDir: string; readonly repoDir: string }): string {
	return `git --git-dir=${JSON.stringify(paths.gitDir)} --work-tree=${JSON.stringify(paths.repoDir)}`;
}

async function runWorkerGitSample(props: {
	readonly fileCount: number;
	readonly largeMiB: number;
	readonly layout: WorkerGitLayout;
	readonly sampleIndex: number;
	readonly sampleKind: 'sample' | 'warmup';
	readonly vm: ManagedBenchmarkVm;
}): Promise<WorkerGitSample> {
	await prepareRepo({ layout: props.layout, vm: props.vm });
	const paths = resolveLayoutPaths(props.layout);
	const repo = JSON.stringify(paths.repoDir);
	const git = gitForPaths(paths);
	const modifiedFileCount = Math.min(100, props.fileCount);
	const smallWriteMs = await runTimedCommand(
		props.vm,
		[
			`repo=${repo}`,
			`file_count=${String(props.fileCount)}`,
			'mkdir -p "$repo/src"',
			'i=0',
			'while [ "$i" -lt "$file_count" ]; do',
			'  sub="$repo/src/$(printf "%02d" $((i % 40)))"',
			'  mkdir -p "$sub"',
			'  printf "worker-git-benchmark-%06d\\n" "$i" > "$sub/file-$i.txt"',
			'  i=$((i + 1))',
			'done',
			'test "$(find "$repo/src" -type f | wc -l | tr -d " ")" = "$file_count"',
		].join('\n'),
	);
	const smallReadMs = await runTimedCommand(
		props.vm,
		[
			`repo=${repo}`,
			`file_count=${String(props.fileCount)}`,
			'count=0',
			'for file in "$repo"/src/*/*.txt; do',
			'  cat "$file" >/dev/null',
			'  count=$((count + 1))',
			'done',
			'test "$count" = "$file_count"',
		].join('\n'),
	);
	const gitAddInitialMs = await runTimedCommand(
		props.vm,
		`${git} add src && ${git} commit -m initial >/dev/null`,
	);
	const gitStatusCleanMs = await runTimedCommand(
		props.vm,
		`test -z "$(${git} status --porcelain)"`,
	);
	const modifyFilesMs = await runTimedCommand(
		props.vm,
		[
			`repo=${repo}`,
			`limit=${String(modifiedFileCount)}`,
			'i=0',
			'while [ "$i" -lt "$limit" ]; do',
			'  printf "modified-%06d\\n" "$i" >> "$repo/src/$(printf "%02d" $((i % 40)))/file-$i.txt"',
			'  i=$((i + 1))',
			'done',
		].join('\n'),
	);
	const gitStatusDirtyMs = await runTimedCommand(
		props.vm,
		`test "$(${git} status --porcelain | wc -l | tr -d " ")" = "${String(modifiedFileCount)}"`,
	);
	const gitDiffMs = await runTimedCommand(props.vm, `${git} diff -- src >/dev/null`);
	const gitAddModifiedMs = await runTimedCommand(props.vm, `${git} add src`);
	const gitCommitMs = await runTimedCommand(props.vm, `${git} commit -m modified >/dev/null`);
	const largeWriteMs = await runTimedCommand(
		props.vm,
		[
			`repo=${repo}`,
			`large_mib=${String(props.largeMiB)}`,
			'mkdir -p "$repo/build"',
			'dd if=/dev/zero of="$repo/build/blob.bin" bs=1048576 count="$large_mib" >/dev/null 2>&1',
			'expected_bytes=$((large_mib * 1048576))',
			'test "$(wc -c < "$repo/build/blob.bin" | tr -d " ")" = "$expected_bytes"',
		].join('\n'),
	);
	await props.vm.exec(['/bin/sh', '-lc', `rm -rf ${repo} ${JSON.stringify(paths.gitDir)}`]);
	return {
		gitAddInitialMs,
		gitAddModifiedMs,
		gitCommitMs,
		gitDiffMs,
		gitStatusCleanMs,
		gitStatusDirtyMs,
		largeWriteMs,
		modifyFilesMs,
		smallReadMs,
		smallWriteMs,
	};
}

async function benchmarkLayout(props: {
	readonly fileCount: number;
	readonly largeMiB: number;
	readonly layout: WorkerGitLayout;
	readonly samples: number;
	readonly vm: ManagedBenchmarkVm;
	readonly warmupSamples: number;
}): Promise<WorkerGitLayoutResult> {
	try {
		for (let index = 0; index < props.warmupSamples; index += 1) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential warmups avoid I/O contention
			await runWorkerGitSample({
				fileCount: props.fileCount,
				largeMiB: props.largeMiB,
				layout: props.layout,
				sampleIndex: index,
				sampleKind: 'warmup',
				vm: props.vm,
			});
		}
		const samples: WorkerGitSample[] = [];
		for (let index = 0; index < props.samples; index += 1) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential samples avoid I/O contention
			const sample = await runWorkerGitSample({
				fileCount: props.fileCount,
				largeMiB: props.largeMiB,
				layout: props.layout,
				sampleIndex: index,
				sampleKind: 'sample',
				vm: props.vm,
			});
			samples.push(sample);
		}
		return {
			layout: props.layout,
			ok: true,
			samples,
			summary: summarizeWorkerGitSamples(samples),
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			layout: props.layout,
			ok: false,
		};
	}
}

function summarizeWorkerGitSamples(samples: readonly WorkerGitSample[]): WorkerGitSummary {
	return {
		gitAddInitialMs: summarizeValues(samples.map((sample) => sample.gitAddInitialMs)),
		gitAddModifiedMs: summarizeValues(samples.map((sample) => sample.gitAddModifiedMs)),
		gitCommitMs: summarizeValues(samples.map((sample) => sample.gitCommitMs)),
		gitDiffMs: summarizeValues(samples.map((sample) => sample.gitDiffMs)),
		gitStatusCleanMs: summarizeValues(samples.map((sample) => sample.gitStatusCleanMs)),
		gitStatusDirtyMs: summarizeValues(samples.map((sample) => sample.gitStatusDirtyMs)),
		largeWriteMs: summarizeValues(samples.map((sample) => sample.largeWriteMs)),
		modifyFilesMs: summarizeValues(samples.map((sample) => sample.modifyFilesMs)),
		smallReadMs: summarizeValues(samples.map((sample) => sample.smallReadMs)),
		smallWriteMs: summarizeValues(samples.map((sample) => sample.smallWriteMs)),
	};
}

function summarizeValues(values: readonly number[]): DurationSummary {
	const sortedValues = values.toSorted((left, right) => left - right);
	const min = sortedValues[0];
	const median = sortedValues[Math.floor(sortedValues.length / 2)];
	const max = sortedValues[sortedValues.length - 1];
	if (min === undefined || median === undefined || max === undefined) {
		throw new Error('Cannot summarize an empty value list.');
	}
	return { max, median, min };
}

async function runBenchmark(options: WorkerGitOptions): Promise<WorkerGitOutput> {
	const gondolin = await loadGondolinModules(options.gondolinRepo);
	const hostRealFsDirectory = createHostDirectory('agent-vm-worker-git-realfs-');
	const hostGitDirDirectory = createHostDirectory('agent-vm-worker-git-gitdirs-');

	let vm: ManagedBenchmarkVm | null = null;
	try {
		vm = await gondolin.VM.create({
			rootfs: { mode: 'cow' },
			...(options.imagePath === null
				? {}
				: {
						sandbox: {
							imagePath: options.imagePath,
						},
					}),
			startTimeoutMs: options.startTimeoutMs,
			vfs: {
				mounts: {
					'/gitdirs': new gondolin.RealFSProvider(hostGitDirDirectory),
					'/worker-realfs': new gondolin.RealFSProvider(hostRealFsDirectory),
				},
			},
		});
		const environment = {
			df: await runCommand(vm, 'df -T / /worker-realfs /gitdirs /tmp 2>/dev/null || true'),
			host: {
				arch: os.arch(),
				node: process.version,
				platform: os.platform(),
				release: os.release(),
			},
			mounts: await runCommand(
				vm,
				"mount | grep -E ' / | /tmp | /worker-realfs | /gitdirs ' || true",
			),
			uname: await runCommand(vm, 'uname -a'),
		};
		const layouts = [
			'full-rootfs',
			'full-realfs',
			'rootfs-worktree-realfs-gitdir',
		] as const satisfies readonly WorkerGitLayout[];
		const results: WorkerGitLayoutResult[] = [];
		for (const layout of layouts) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential layouts avoid I/O contention
			const result = await benchmarkLayout({
				fileCount: options.fileCount,
				largeMiB: options.largeMiB,
				layout,
				samples: options.samples,
				vm,
				warmupSamples: options.warmupSamples,
			});
			results.push(result);
		}
		return {
			benchmark: {
				fileCount: options.fileCount,
				gondolinRepo: options.gondolinRepo,
				imagePath: options.imagePath,
				largeMiB: options.largeMiB,
				samples: options.samples,
				startedAt: new Date().toISOString(),
				startTimeoutMs: options.startTimeoutMs,
				warmupSamples: options.warmupSamples,
			},
			environment,
			results,
		};
	} finally {
		if (vm !== null) {
			await vm.close();
		}
		fs.rmSync(hostRealFsDirectory, { force: true, recursive: true });
		fs.rmSync(hostGitDirDirectory, { force: true, recursive: true });
	}
}

function printSummary(output: WorkerGitOutput): void {
	process.stdout.write('Gondolin worker Git benchmark\n');
	process.stdout.write(`  fileCount: ${String(output.benchmark.fileCount)}\n`);
	process.stdout.write(`  largeMiB:  ${String(output.benchmark.largeMiB)}\n`);
	process.stdout.write(`  samples:   ${String(output.benchmark.samples)}\n`);
	if (output.benchmark.imagePath !== null) {
		process.stdout.write(`  imagePath: ${output.benchmark.imagePath}\n`);
	}
	for (const result of output.results) {
		process.stdout.write(`\n${result.layout}\n`);
		if (!result.ok) {
			process.stdout.write(`  ERROR: ${result.error}\n`);
			continue;
		}
		process.stdout.write(
			[
				`  smallWrite=${formatDurationRange(result.summary.smallWriteMs)}`,
				`smallRead=${formatDurationRange(result.summary.smallReadMs)}`,
				`largeWrite=${formatDurationRange(result.summary.largeWriteMs)}`,
			].join(' ') + '\n',
		);
		process.stdout.write(
			[
				`  gitAddInitial=${formatDurationRange(result.summary.gitAddInitialMs)}`,
				`gitStatusClean=${formatDurationRange(result.summary.gitStatusCleanMs)}`,
				`gitStatusDirty=${formatDurationRange(result.summary.gitStatusDirtyMs)}`,
				`gitDiff=${formatDurationRange(result.summary.gitDiffMs)}`,
			].join(' ') + '\n',
		);
		process.stdout.write(
			[
				`  modifyFiles=${formatDurationRange(result.summary.modifyFilesMs)}`,
				`gitAddModified=${formatDurationRange(result.summary.gitAddModifiedMs)}`,
				`gitCommit=${formatDurationRange(result.summary.gitCommitMs)}`,
			].join(' ') + '\n',
		);
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const output = await runBenchmark(options);
	printSummary(output);
	if (options.jsonOut !== null) {
		fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
		fs.writeFileSync(options.jsonOut, `${JSON.stringify(output, null, 2)}\n`);
		process.stdout.write(`\nwrote JSON results to ${options.jsonOut}\n`);
	}
}

await main();
