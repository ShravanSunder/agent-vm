import { describe, expect, it } from 'vitest';

import {
	captureOwnedProcess,
	observeOwnedRunnerExit,
	parseOwnedProcessStat,
	ProcessReadFailure,
	type OwnedProcessIo,
	type OwnedProcessCapture,
} from './probe-e2e-image-boot-process.ts';

const ownerPid = 501;
function statBytes(
	props: {
		readonly pid?: number;
		readonly parentPid?: number;
		readonly startTime?: string;
		readonly command?: string;
	} = {},
): Uint8Array {
	const fields = Array.from({ length: 20 }, () => '0');
	fields[0] = 'S';
	fields[1] = String(props.parentPid ?? ownerPid);
	fields[19] = props.startTime ?? '123456789';
	return Buffer.from(
		String(props.pid ?? 42) +
			' (' +
			(props.command ?? 'qemu process') +
			') ' +
			fields.join(' ') +
			'\n',
	);
}
function argumentsBytes(argumentsList: readonly string[]): Uint8Array {
	return Buffer.from(argumentsList.join('\0') + '\0');
}
const selectedKernel = '/owned/image/vmlinuz-virt';
const selectedInitrd = '/owned/image/initramfs.cpio.lz4';
const normalArguments = [
	'/usr/bin/qemu-system-x86_64',
	'-accel',
	'kvm',
	'-machine',
	'microvm',
	'-cpu',
	'host',
	'-serial',
	'stdio',
	'-kernel',
	selectedKernel,
	'-initrd',
	selectedInitrd,
	'-append',
	'console=ttyS0 initramfs_async=1',
];
function fixture(
	props: {
		readonly platform?: string;
		readonly before?: Uint8Array;
		readonly after?: Uint8Array;
		readonly command?: Uint8Array;
		readonly cmdFailure?: boolean;
		readonly statFailure?: 'missing' | 'read-failed';
	} = {},
): { readonly io: OwnedProcessIo; readonly paths: string[] } {
	const paths: string[] = [];
	let statCount = 0;
	return {
		paths,
		io: {
			platform: props.platform ?? 'linux',
			ownerPid,
			async realpath(filePath) {
				return filePath;
			},
			async readBounded(filePath) {
				paths.push(filePath);
				if (filePath.endsWith('/stat')) {
					if (props.statFailure !== undefined) throw new ProcessReadFailure(props.statFailure);
					statCount += 1;
					return statCount === 1 ? (props.before ?? statBytes()) : (props.after ?? statBytes());
				}
				if (props.cmdFailure) throw new ProcessReadFailure('read-failed');
				return props.command ?? argumentsBytes(normalArguments);
			},
		},
	};
}
async function capture(
	data: ReturnType<typeof fixture>,
	getHostPid: () => number | null = () => 42,
): Promise<OwnedProcessCapture> {
	return await captureOwnedProcess({
		io: data.io,
		pid: 42,
		getHostPid,
		selectedKernel,
		selectedInitrd,
	});
}
describe('owned QEMU proc observation', () => {
	it('reads a stable own-child identity and emits only actual closed argument categories', async () => {
		const result = await capture(fixture());
		expect(result.observation).toEqual({
			status: 'observed',
			accelerator: 'kvm',
			machine: 'microvm',
			cpu: 'host',
			serial: 'stdio',
			console: 'ttyS0',
			kernelMatchesSelectedAsset: true,
			initrdMatchesSelectedAsset: true,
			qemuExecutable: 'qemu-system-x86_64',
		});
		expect(result.identity).toEqual({ pid: 42, parentPid: 501, startTime: '123456789' });
	});
	it('parses the last closing parenthesis and preserves large start ticks as an identity string', () => {
		expect(
			parseOwnedProcessStat(
				statBytes({ command: 'name ) with ( brackets', startTime: '18446744073709551615' }),
			),
		).toEqual({ pid: 42, parentPid: 501, startTime: '18446744073709551615' });
	});
	it.each([0, -1, 1.5, Number.NaN])(
		'rejects invalid public PID %s without any proc access',
		async (pid) => {
			const data = fixture();
			const result = await captureOwnedProcess({
				io: data.io,
				pid,
				getHostPid: () => pid,
				selectedKernel,
				selectedInitrd,
			});
			expect(result.observation).toEqual({ status: 'missing' });
			expect(data.paths).toEqual([]);
		},
	);
	it('keeps non-Linux process observation unsupported without probing the host', async () => {
		const data = fixture({ platform: 'darwin' });
		expect((await capture(data)).observation).toEqual({ status: 'unsupported' });
		expect(data.paths).toEqual([]);
	});
	it.each([
		{ before: statBytes({ parentPid: 999 }) },
		{ before: statBytes({ pid: 99 }) },
		{ after: statBytes({ startTime: '987654321' }) },
		{ after: statBytes({ parentPid: 999 }) },
	])('refuses an unowned or changed process identity %#', async (props) => {
		const result = await capture(fixture(props));
		expect(result.observation).toEqual({ status: 'changed' });
		expect(result.identity).toBeNull();
	});
	it('rechecks the public PID after bounded reads and refuses a reused or cleared handle', async () => {
		const results = await Promise.all(
			[99, null].map(async (pid) => await capture(fixture(), () => pid)),
		);
		for (const result of results) {
			expect(result.observation).toEqual({ status: 'changed' });
			expect(result.identity).toBeNull();
		}
	});
	it('keeps identity evidence when optional cmdline projection cannot be read', async () => {
		const result = await capture(fixture({ cmdFailure: true }));
		expect(result.observation).toEqual({ status: 'read-failed' });
		expect(result.identity).toEqual({ pid: 42, parentPid: 501, startTime: '123456789' });
	});
	it.each([
		{ command: Buffer.from('not-nul-terminated'), status: 'malformed' },
		{ command: new Uint8Array(65537), status: 'over-limit' },
		{ command: argumentsBytes([...normalArguments, '-accel', 'tcg']), status: 'malformed' },
		{
			command: argumentsBytes(['/wrapper', ...Array.from({ length: 257 }, () => '-unknown')]),
			status: 'over-limit',
		},
		{ command: new Uint8Array([0xff, 0]), status: 'malformed' },
	])(
		'closes malformed or capped argv %# without losing valid ownership',
		async ({ command, status }) => {
			const result = await capture(fixture({ command }));
			expect(result.observation).toEqual({ status });
			expect(result.identity).not.toBeNull();
		},
	);
	it('maps unknown arguments and wrappers to other without echoing them', async () => {
		const result = await capture(
			fixture({
				command: argumentsBytes([
					'/private/fixture-wrapper',
					'-accel',
					'fixture-private',
					'-machine',
					'fixture-machine',
					'-cpu',
					'fixture-cpu',
					'-serial',
					'fixture-serial',
					'-kernel',
					'/private/fixture-kernel',
					'-append',
					'token=fixture-private console=private-console',
				]),
			}),
		);
		expect(result.observation).toEqual({
			status: 'observed',
			accelerator: 'other',
			machine: 'other',
			cpu: 'other',
			serial: 'other',
			console: 'other',
			kernelMatchesSelectedAsset: false,
			initrdMatchesSelectedAsset: null,
			qemuExecutable: 'other',
		});
		expect(JSON.stringify(result.observation)).not.toContain('fixture-');
		expect(JSON.stringify(result.observation)).not.toContain('/private/');
	});
	it.each(['ttyAMA0', 'hvc0', 'ttyS0'] as const)(
		'observes the literal console token %s',
		async (consoleToken) => {
			const args = [...normalArguments];
			args[args.length - 1] = 'console=' + consoleToken + ',115200';
			expect((await capture(fixture({ command: argumentsBytes(args) }))).observation).toMatchObject(
				{ console: consoleToken },
			);
		},
	);
	it('does not infer a console or accelerator from source defaults when flags are absent', async () => {
		expect(
			(await capture(fixture({ command: argumentsBytes(['/usr/bin/qemu-system-x86_64']) })))
				.observation,
		).toMatchObject({
			accelerator: 'other',
			machine: 'other',
			cpu: 'other',
			serial: 'other',
			console: 'absent',
			kernelMatchesSelectedAsset: null,
			initrdMatchesSelectedAsset: null,
		});
	});
	it('reports malformed stat and stat read failure as unavailable ownership', async () => {
		const results = await Promise.all([
			capture(fixture({ before: Buffer.from('bad stat') })),
			capture(fixture({ statFailure: 'read-failed' })),
		]);
		for (const result of results) expect(result.identity).toBeNull();
	});
});
describe('runner exit is separate from close resolution', () => {
	const identity = { pid: 42, parentPid: 501, startTime: '123456789' };
	it.each([
		{ data: fixture(), expected: 'still-observed' },
		{ data: fixture({ before: statBytes({ startTime: '987654321' }) }), expected: 'exited' },
		{ data: fixture({ statFailure: 'missing' }), expected: 'exited' },
		{ data: fixture({ statFailure: 'read-failed' }), expected: 'unknown' },
		{ data: fixture({ before: Buffer.from('bad') }), expected: 'unknown' },
	])('projects post-close identity observation %#', async ({ data, expected }) => {
		expect(await observeOwnedRunnerExit(identity, data.io)).toBe(expected);
	});
	it('never calls an uncaptured runner exited', async () => {
		expect(await observeOwnedRunnerExit(null, fixture().io)).toBe('unknown');
	});
});
