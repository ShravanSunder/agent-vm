/* oxlint-disable typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-type-assertion -- dynamic imports and child JSON cross a local Gondolin checkout boundary */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	assertExpectedMountToken,
	formatDurationRange,
	type BenchmarkSampleSummary,
	type BenchmarkSampleTiming,
	summarizeBenchmarkSamples,
} from '../../packages/agent-vm/src/perf/gondolin-vfs-benchmark-support.ts';

type RootfsMode = 'cow' | 'memory' | 'readonly';
type BenchmarkPathKind =
	| 'rootfs'
	| 'guest-tmpfs'
	| 'gondolin-memory-vfs'
	| 'gondolin-realfs'
	| 'workspace-realfs-node-modules'
	| 'workspace-shadow-node-modules';

interface BenchmarkOptions {
	readonly childTimeoutMs: number;
	readonly fileCount: number;
	readonly gondolinRepo: string;
	readonly imagePath: string | null;
	readonly jsonOut: string | null;
	readonly largeMiB: number;
	readonly requireCleanGondolin: boolean;
	readonly rootfsModes: readonly RootfsMode[];
	readonly samples: number;
	readonly startTimeoutMs: number;
	readonly warmupSamples: number;
}

interface BenchmarkCase {
	readonly directory: string;
	readonly expectWritable: boolean;
	readonly expectedMountToken: string | null;
	readonly kind: BenchmarkPathKind;
	readonly label: string;
}

interface BenchmarkSuccess extends BenchmarkSampleSummary {
	readonly ok: true;
	readonly kind: BenchmarkPathKind;
	readonly label: string;
	readonly mountInfo: string;
	readonly samples: readonly BenchmarkSampleTiming[];
}

interface BenchmarkFailure {
	readonly ok: false;
	readonly kind: BenchmarkPathKind;
	readonly label: string;
	readonly error: string;
	readonly mountInfo: string;
}

type BenchmarkResult = BenchmarkFailure | BenchmarkSuccess;

type RootfsModeResult =
	| {
			readonly ok: true;
			readonly rootfsMode: RootfsMode;
			readonly environment: BenchmarkEnvironment;
			readonly results: readonly BenchmarkResult[];
	  }
	| {
			readonly ok: false;
			readonly rootfsMode: RootfsMode;
			readonly error: string;
			readonly stderr?: string;
			readonly stdout?: string;
	  };

interface BenchmarkEnvironment {
	readonly df: string;
	readonly gondolinGit: GondolinGitMetadata;
	readonly gondolinRepo: string;
	readonly host: {
		readonly arch: string;
		readonly node: string;
		readonly platform: string;
		readonly release: string;
	};
	readonly mounts: string;
	readonly rootfsMode: RootfsMode;
	readonly uname: string;
}

interface BenchmarkOutput {
	readonly benchmark: {
		readonly fileCount: number;
		readonly childTimeoutMs: number;
		readonly gondolinGit: GondolinGitMetadata;
		readonly gondolinRepo: string;
		readonly imagePath: string | null;
		readonly largeMiB: number;
		readonly samples: number;
		readonly startedAt: string;
		readonly startTimeoutMs: number;
		readonly warmupSamples: number;
	};
	readonly results: readonly RootfsModeResult[];
}

interface GondolinGitMetadata {
	readonly branch: string | null;
	readonly dirty: boolean;
	readonly error?: string;
	readonly head: string | null;
	readonly status: string;
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
		readonly rootfs: { readonly mode: RootfsMode };
		readonly sandbox?: { readonly imagePath?: string };
		readonly startTimeoutMs: number;
		readonly vfs: {
			readonly mounts: Record<string, VirtualProvider>;
		};
	}): Promise<ManagedBenchmarkVm>;
}

type VirtualProvider = object;

interface GondolinModules {
	readonly MemoryProvider: new () => VirtualProvider;
	readonly RealFSProvider: new (hostPath: string) => VirtualProvider;
	readonly ShadowProvider: new (
		backend: VirtualProvider,
		options: {
			readonly shouldShadow: (entryPath: string) => boolean;
			readonly writeMode: 'tmpfs';
		},
	) => VirtualProvider;
	readonly VM: VmConstructor;
	readonly createShadowPathPredicate: (paths: readonly string[]) => (entryPath: string) => boolean;
}

const childResultPrefix = 'AGENT_VM_GONDOLIN_BENCH_RESULT=';

function writeLine(line = ''): void {
	process.stdout.write(`${line}\n`);
}

function parseCliArgs(argv: readonly string[]): BenchmarkOptions & {
	readonly childMode: RootfsMode | null;
} {
	const values = new Map<string, string>();
	const flags = new Set<string>();

	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
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
			flags.add(rawKey);
			continue;
		}
		values.set(rawKey, next);
		index += 1;
	}

	const gondolinRepo =
		values.get('gondolin-repo') ?? process.env.GONDOLIN_REPO ?? findDefaultGondolinRepo();
	const rootfsModes = parseRootfsModes(values.get('rootfs-modes') ?? 'cow,memory,readonly');
	const childModeValue = values.get('child-mode') ?? null;

	return {
		childMode: childModeValue === null ? null : parseRootfsMode(childModeValue),
		childTimeoutMs: parsePositiveInteger(
			values.get('child-timeout-ms') ?? '600000',
			'child-timeout-ms',
		),
		fileCount: parsePositiveInteger(values.get('file-count') ?? '2000', 'file-count'),
		gondolinRepo,
		imagePath: values.get('image-path') ?? null,
		jsonOut: values.get('json-out') ?? null,
		largeMiB: parsePositiveInteger(values.get('large-mib') ?? '32', 'large-mib'),
		requireCleanGondolin: flags.has('require-clean-gondolin'),
		rootfsModes: flags.has('no-readonly')
			? rootfsModes.filter((rootfsMode) => rootfsMode !== 'readonly')
			: rootfsModes,
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

function parseRootfsModes(rawValue: string): readonly RootfsMode[] {
	const modes = rawValue
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0)
		.map(parseRootfsMode);
	if (modes.length === 0) {
		throw new Error('--rootfs-modes must include at least one mode');
	}
	return modes;
}

function parseRootfsMode(value: string): RootfsMode {
	if (value === 'cow' || value === 'memory' || value === 'readonly') {
		return value;
	}
	throw new Error(`unsupported rootfs mode: ${value}`);
}

function findDefaultGondolinRepo(): string {
	const candidates = [
		path.resolve(process.cwd(), '../gondolin'),
		path.resolve(process.cwd(), '../../open-source/vm/gondolin'),
		path.resolve(os.homedir(), 'Documents/dev/open-source/vm/gondolin'),
	];
	const match = candidates.find((candidate) =>
		fs.existsSync(path.join(candidate, 'host/src/vm/core.ts')),
	);
	if (match !== undefined) {
		return match;
	}
	throw new Error(
		'Could not find a Gondolin checkout. Pass --gondolin-repo /path/to/gondolin or set GONDOLIN_REPO.',
	);
}

async function loadGondolinModules(gondolinRepo: string): Promise<GondolinModules> {
	const hostSourceDir = path.join(gondolinRepo, 'host/src');
	const nodeModule = await import(
		pathToFileURL(path.join(hostSourceDir, 'vfs/node/index.ts')).href
	);
	const shadowModule = await import(pathToFileURL(path.join(hostSourceDir, 'vfs/shadow.ts')).href);
	const vmModule = await import(pathToFileURL(path.join(hostSourceDir, 'vm/core.ts')).href);

	return {
		MemoryProvider: getModuleExport(
			nodeModule,
			'MemoryProvider',
		) as GondolinModules['MemoryProvider'],
		RealFSProvider: getModuleExport(
			nodeModule,
			'RealFSProvider',
		) as GondolinModules['RealFSProvider'],
		ShadowProvider: getModuleExport(
			shadowModule,
			'ShadowProvider',
		) as GondolinModules['ShadowProvider'],
		VM: getModuleExport(vmModule, 'VM') as VmConstructor,
		createShadowPathPredicate: getModuleExport(
			shadowModule,
			'createShadowPathPredicate',
		) as GondolinModules['createShadowPathPredicate'],
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

function runGit(
	gondolinRepo: string,
	args: readonly string[],
): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string } {
	const result = spawnSync('git', ['-C', gondolinRepo, ...args], {
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		const stderr = result.stderr.trim();
		const errorMessage =
			stderr.length > 0 ? stderr : (result.error?.message ?? 'git command failed');
		return {
			error: errorMessage,
			ok: false,
		};
	}
	return {
		ok: true,
		stdout: result.stdout.trim(),
	};
}

function readGondolinGitMetadata(gondolinRepo: string): GondolinGitMetadata {
	const head = runGit(gondolinRepo, ['rev-parse', 'HEAD']);
	const branch = runGit(gondolinRepo, ['rev-parse', '--abbrev-ref', 'HEAD']);
	const status = runGit(gondolinRepo, ['status', '--short']);
	const error = [head, branch, status]
		.filter((result) => !result.ok)
		.map((result) => result.error)
		.join('; ');

	return {
		branch: branch.ok ? branch.stdout : null,
		dirty: status.ok ? status.stdout.length > 0 : true,
		...(error.length > 0 ? { error } : {}),
		head: head.ok ? head.stdout : null,
		status: status.ok ? status.stdout : '',
	};
}

async function runCommand(vm: ManagedBenchmarkVm, command: string): Promise<string> {
	const result = await vm.exec(['/bin/sh', '-lc', command]);
	if (result.exitCode !== 0) {
		throw new Error(`Command failed: ${command}\n${result.stderr}`);
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

async function getMountInfo(vm: ManagedBenchmarkVm, directory: string): Promise<string> {
	const quotedDirectory = JSON.stringify(directory);
	return await runCommand(
		vm,
		[
			`mkdir -p ${quotedDirectory} 2>/dev/null || true`,
			`df -T ${quotedDirectory} 2>/dev/null || true`,
			`mount | grep " ${directory.split('/')[1] ? `/${directory.split('/')[1]}` : directory} " || true`,
		].join('; '),
	);
}

async function benchmarkCase(props: {
	readonly benchmarkCase: BenchmarkCase;
	readonly fileCount: number;
	readonly largeMiB: number;
	readonly samples: number;
	readonly vm: ManagedBenchmarkVm;
	readonly warmupSamples: number;
}): Promise<BenchmarkResult> {
	const mountInfo = await getMountInfo(props.vm, props.benchmarkCase.directory);
	try {
		assertExpectedMountToken({
			label: props.benchmarkCase.label,
			mountInfo,
			token: props.benchmarkCase.expectedMountToken,
		});
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			kind: props.benchmarkCase.kind,
			label: props.benchmarkCase.label,
			mountInfo,
			ok: false,
		};
	}

	if (!props.benchmarkCase.expectWritable) {
		const caseDirectory = `${props.benchmarkCase.directory}-${Date.now()}`;
		const quotedDirectory = JSON.stringify(caseDirectory);
		const result = await props.vm.exec([
			'/bin/sh',
			'-lc',
			`mkdir -p ${quotedDirectory} 2>/dev/null && echo writable > ${quotedDirectory}/probe.txt`,
		]);
		return {
			error:
				result.exitCode === 0
					? 'expected readonly path to reject writes, but write succeeded'
					: `write rejected as expected: ${result.stderr.trim() || result.stdout.trim()}`,
			kind: props.benchmarkCase.kind,
			label: props.benchmarkCase.label,
			mountInfo,
			ok: false,
		};
	}

	try {
		for (let index = 0; index < props.warmupSamples; index += 1) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential warmups avoid I/O contention
			await runBenchmarkSample({
				benchmarkCase: props.benchmarkCase,
				fileCount: props.fileCount,
				largeMiB: props.largeMiB,
				sampleIndex: index,
				sampleKind: 'warmup',
				vm: props.vm,
			});
		}
		const samples: BenchmarkSampleTiming[] = [];
		for (let index = 0; index < props.samples; index += 1) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential samples avoid I/O contention
			const sample = await runBenchmarkSample({
				benchmarkCase: props.benchmarkCase,
				fileCount: props.fileCount,
				largeMiB: props.largeMiB,
				sampleIndex: index,
				sampleKind: 'sample',
				vm: props.vm,
			});
			samples.push(sample);
		}
		const summary = summarizeBenchmarkSamples(samples);

		return {
			...summary,
			kind: props.benchmarkCase.kind,
			label: props.benchmarkCase.label,
			mountInfo,
			ok: true,
			samples,
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			kind: props.benchmarkCase.kind,
			label: props.benchmarkCase.label,
			mountInfo,
			ok: false,
		};
	}
}

async function runBenchmarkSample(props: {
	readonly benchmarkCase: BenchmarkCase;
	readonly fileCount: number;
	readonly largeMiB: number;
	readonly sampleIndex: number;
	readonly sampleKind: 'sample' | 'warmup';
	readonly vm: ManagedBenchmarkVm;
}): Promise<BenchmarkSampleTiming> {
	const caseDirectory = [
		props.benchmarkCase.directory,
		Date.now().toString(),
		props.sampleKind,
		String(props.sampleIndex),
	].join('-');
	const quotedDirectory = JSON.stringify(caseDirectory);
	try {
		const smallWriteMs = await runTimedCommand(
			props.vm,
			[
				`dir=${quotedDirectory}`,
				`file_count=${String(props.fileCount)}`,
				'mkdir -p "$dir"',
				'i=0',
				'while [ "$i" -lt "$file_count" ]; do',
				'  sub="$dir/$(printf "%02d" $((i % 40)))"',
				'  mkdir -p "$sub"',
				'  printf "agent-vm-vfs-benchmark-%06d\\n" "$i" > "$sub/file-$i.txt"',
				'  i=$((i + 1))',
				'done',
				'test "$(find "$dir" -type f | wc -l | tr -d " ")" = "$file_count"',
			].join('\n'),
		);
		const smallReadMs = await runTimedCommand(
			props.vm,
			[
				`dir=${quotedDirectory}`,
				`file_count=${String(props.fileCount)}`,
				'count=0',
				'for file in "$dir"/*/*.txt; do',
				'  cat "$file" >/dev/null',
				'  count=$((count + 1))',
				'done',
				'test "$count" = "$file_count"',
			].join('\n'),
		);
		const largeWriteMs = await runTimedCommand(
			props.vm,
			[
				`dir=${quotedDirectory}`,
				`large_mib=${String(props.largeMiB)}`,
				'rm -f "$dir/blob.bin"',
				'dd if=/dev/zero of="$dir/blob.bin" bs=1048576 count="$large_mib" >/dev/null 2>&1',
				'expected_bytes=$((large_mib * 1048576))',
				'test "$(wc -c < "$dir/blob.bin" | tr -d " ")" = "$expected_bytes"',
			].join('\n'),
		);
		return {
			largeWriteMs,
			smallReadMs,
			smallWriteMs,
		};
	} finally {
		await props.vm.exec(['/bin/sh', '-lc', `rm -rf ${quotedDirectory}`]);
	}
}

async function runRootfsMode(
	options: BenchmarkOptions,
	rootfsMode: RootfsMode,
): Promise<RootfsModeResult> {
	const gondolin = await loadGondolinModules(options.gondolinRepo);
	const hostRealFsDirectory = createHostDirectory('agent-vm-realfs-bench-');
	const hostWorkspaceDirectory = createHostDirectory('agent-vm-workspace-bench-');
	fs.mkdirSync(path.join(hostWorkspaceDirectory, 'node_modules'), { recursive: true });
	fs.writeFileSync(path.join(hostWorkspaceDirectory, 'package.json'), '{"private":true}\n');

	const workspaceBaseProvider = new gondolin.RealFSProvider(hostWorkspaceDirectory);
	const shadowedWorkspaceProvider = new gondolin.ShadowProvider(workspaceBaseProvider, {
		shouldShadow: gondolin.createShadowPathPredicate(['/node_modules']),
		writeMode: 'tmpfs',
	});

	let vm: ManagedBenchmarkVm | null = null;
	try {
		vm = await gondolin.VM.create({
			rootfs: { mode: rootfsMode },
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
					'/memory-vfs': new gondolin.MemoryProvider(),
					'/realfs': new gondolin.RealFSProvider(hostRealFsDirectory),
					'/workspace-realfs': new gondolin.RealFSProvider(hostWorkspaceDirectory),
					'/workspace-shadow': shadowedWorkspaceProvider,
				},
			},
		});

		const environment = await collectEnvironment({
			gondolinRepo: options.gondolinRepo,
			rootfsMode,
			vm,
		});
		const rootfsWritable = rootfsMode !== 'readonly';
		const cases: readonly BenchmarkCase[] = [
			{
				directory: '/opt/agent-vm-rootfs-bench',
				expectWritable: rootfsWritable,
				expectedMountToken: 'ext4',
				kind: 'rootfs',
				label: 'rootfs-opt',
			},
			{
				directory: '/tmp/agent-vm-tmpfs-bench',
				expectWritable: true,
				expectedMountToken: 'tmpfs',
				kind: 'guest-tmpfs',
				label: 'guest-tmpfs',
			},
			{
				directory: '/memory-vfs/bench',
				expectWritable: true,
				expectedMountToken: 'fuse.sandboxfs',
				kind: 'gondolin-memory-vfs',
				label: 'gondolin-memory-vfs',
			},
			{
				directory: '/realfs/bench',
				expectWritable: true,
				expectedMountToken: 'fuse.sandboxfs',
				kind: 'gondolin-realfs',
				label: 'gondolin-realfs',
			},
			{
				directory: '/workspace-realfs/node_modules/bench',
				expectWritable: true,
				expectedMountToken: 'fuse.sandboxfs',
				kind: 'workspace-realfs-node-modules',
				label: 'workspace-realfs-node-modules',
			},
			{
				directory: '/workspace-shadow/node_modules/bench',
				expectWritable: true,
				expectedMountToken: 'fuse.sandboxfs',
				kind: 'workspace-shadow-node-modules',
				label: 'workspace-shadow-node-modules',
			},
		];

		const results: BenchmarkResult[] = [];
		for (const currentCase of cases) {
			// These cases intentionally run sequentially. Running file benchmarks in
			// parallel would turn the result into an I/O contention benchmark.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const result = await benchmarkCase({
				benchmarkCase: currentCase,
				fileCount: options.fileCount,
				largeMiB: options.largeMiB,
				samples: options.samples,
				vm,
				warmupSamples: options.warmupSamples,
			});
			results.push(result);
		}

		return {
			environment,
			ok: true,
			results,
			rootfsMode,
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			ok: false,
			rootfsMode,
		};
	} finally {
		if (vm !== null) {
			await vm.close();
		}
		fs.rmSync(hostRealFsDirectory, { force: true, recursive: true });
		fs.rmSync(hostWorkspaceDirectory, { force: true, recursive: true });
	}
}

async function collectEnvironment(props: {
	readonly gondolinRepo: string;
	readonly rootfsMode: RootfsMode;
	readonly vm: ManagedBenchmarkVm;
}): Promise<BenchmarkEnvironment> {
	const uname = await runCommand(props.vm, 'uname -a');
	const df = await runCommand(
		props.vm,
		'df -T / /opt /tmp /memory-vfs /realfs /workspace-realfs /workspace-shadow 2>/dev/null || true',
	);
	const mounts = await runCommand(
		props.vm,
		"mount | grep -E ' / | /opt | /tmp | /memory-vfs | /realfs | /workspace-realfs | /workspace-shadow ' || true",
	);

	return {
		df,
		gondolinGit: readGondolinGitMetadata(props.gondolinRepo),
		gondolinRepo: props.gondolinRepo,
		host: {
			arch: os.arch(),
			node: process.version,
			platform: os.platform(),
			release: os.release(),
		},
		mounts,
		rootfsMode: props.rootfsMode,
		uname,
	};
}

function runChildProcessForMode(
	options: BenchmarkOptions,
	rootfsMode: RootfsMode,
): RootfsModeResult {
	const scriptPath = fileURLToPath(import.meta.url);
	const child = spawnSync(
		process.execPath,
		[
			scriptPath,
			'--child-mode',
			rootfsMode,
			'--gondolin-repo',
			options.gondolinRepo,
			...(options.imagePath === null ? [] : ['--image-path', options.imagePath]),
			'--child-timeout-ms',
			String(options.childTimeoutMs),
			'--file-count',
			String(options.fileCount),
			'--large-mib',
			String(options.largeMiB),
			'--samples',
			String(options.samples),
			'--warmup-samples',
			String(options.warmupSamples),
			'--start-timeout-ms',
			String(options.startTimeoutMs),
		],
		{
			encoding: 'utf8',
			env: process.env,
			timeout: options.childTimeoutMs,
		},
	);

	const stdout = child.stdout ?? '';
	const stderr = child.stderr ?? '';
	const resultLine = stdout.split('\n').find((line) => line.startsWith(childResultPrefix));
	if (resultLine !== undefined) {
		return JSON.parse(resultLine.slice(childResultPrefix.length)) as RootfsModeResult;
	}

	return {
		error:
			child.error instanceof Error
				? child.error.message
				: `child exited without a benchmark result; status=${String(child.status)}`,
		ok: false,
		rootfsMode,
		stderr,
		stdout,
	};
}

async function runParent(
	options: BenchmarkOptions,
	gondolinGit: GondolinGitMetadata,
): Promise<BenchmarkOutput> {
	const results = options.rootfsModes.map((rootfsMode) =>
		runChildProcessForMode(options, rootfsMode),
	);
	return {
		benchmark: {
			childTimeoutMs: options.childTimeoutMs,
			fileCount: options.fileCount,
			gondolinGit,
			gondolinRepo: options.gondolinRepo,
			imagePath: options.imagePath,
			largeMiB: options.largeMiB,
			samples: options.samples,
			startedAt: new Date().toISOString(),
			startTimeoutMs: options.startTimeoutMs,
			warmupSamples: options.warmupSamples,
		},
		results,
	};
}

function printHumanSummary(output: BenchmarkOutput): void {
	writeLine('Gondolin VFS/rootfs benchmark');
	writeLine(`  fileCount:      ${String(output.benchmark.fileCount)}`);
	writeLine(`  largeMiB:       ${String(output.benchmark.largeMiB)}`);
	writeLine(`  samples:        ${String(output.benchmark.samples)}`);
	writeLine(`  warmups:        ${String(output.benchmark.warmupSamples)}`);
	writeLine(`  childTimeoutMs: ${String(output.benchmark.childTimeoutMs)}`);
	writeLine(`  startTimeoutMs: ${String(output.benchmark.startTimeoutMs)}`);
	writeLine(
		`  Gondolin:       ${output.benchmark.gondolinGit.branch ?? 'unknown'} ${output.benchmark.gondolinGit.head ?? 'unknown'}`,
	);
	writeLine(`  dirty:          ${output.benchmark.gondolinGit.dirty ? 'yes' : 'no'}`);
	if (output.benchmark.imagePath !== null) {
		writeLine(`  imagePath:      ${output.benchmark.imagePath}`);
	}
	for (const rootfsResult of output.results) {
		writeLine();
		writeLine(`rootfs.mode=${rootfsResult.rootfsMode}`);
		if (!rootfsResult.ok) {
			writeLine(`  ERROR: ${rootfsResult.error}`);
			continue;
		}
		for (const result of rootfsResult.results) {
			if (!result.ok) {
				writeLine(`  ${result.label}: ERROR ${result.error}`);
				continue;
			}
			writeLine(
				[
					`  ${result.label}:`,
					`smallWrite=${formatDurationRange({ max: result.smallWriteMsMax, median: result.smallWriteMs, min: result.smallWriteMsMin })}`,
					`smallRead=${formatDurationRange({ max: result.smallReadMsMax, median: result.smallReadMs, min: result.smallReadMsMin })}`,
					`largeWrite=${formatDurationRange({ max: result.largeWriteMsMax, median: result.largeWriteMs, min: result.largeWriteMsMin })}`,
				].join(' '),
			);
		}
	}
}

async function main(): Promise<void> {
	const options = parseCliArgs(process.argv.slice(2));
	const gondolinGit = readGondolinGitMetadata(options.gondolinRepo);
	if (options.requireCleanGondolin && gondolinGit.dirty) {
		throw new Error(
			`Gondolin checkout at ${options.gondolinRepo} is dirty. Commit/stash changes or omit --require-clean-gondolin.`,
		);
	}
	if (options.childMode !== null) {
		const result = await runRootfsMode(options, options.childMode);
		writeLine(`${childResultPrefix}${JSON.stringify(result)}`);
		return;
	}

	const output = await runParent(options, gondolinGit);
	printHumanSummary(output);

	if (options.jsonOut !== null) {
		fs.mkdirSync(path.dirname(options.jsonOut), { recursive: true });
		fs.writeFileSync(options.jsonOut, `${JSON.stringify(output, null, 2)}\n`);
		writeLine();
		writeLine(`wrote JSON results to ${options.jsonOut}`);
	}
}

await main();
