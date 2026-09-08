import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	createOperationFolderGuestAccess,
	loadOperationFolderGuestProgram,
} from '../controller/files/operation-folder-guest-access.js';
import { shouldRunLiveVmE2e } from './live-vm-e2e-gates.js';
import { fileRelayPythonExecutable } from './managed-file-relay-test-fixture.js';
import {
	startManagedGatewayImageBootFixture,
	type ManagedGatewayImageBootFixture,
} from './managed-gateway-image-boot-test-fixture.js';

const describeLiveFolderGuards = shouldRunLiveVmE2e() ? describe : describe.skip;
const proofRoot = '/var/tmp/agent-vm-folder-guard-proof';

describeLiveFolderGuards('operation folder guards on real Linux VM rootfs', () => {
	let fixture: ManagedGatewayImageBootFixture;
	beforeAll(async () => {
		fixture = await startManagedGatewayImageBootFixture({
			sessionLabel: 'operation-folder-guards',
		});
		const setup = await fixture.vm.exec(
			[
				fileRelayPythonExecutable,
				'-c',
				[
					'import os,pathlib,socket,stat,sys',
					'root=pathlib.Path(sys.argv[1]); root.mkdir(mode=0o700)',
					'work=root/"work"; work.mkdir(mode=0o700)',
					'(root/"outside").write_bytes(b"outside-secret-sentinel")',
					'(work/"regular").write_bytes(bytes([0,255,128,1]))',
					'(work/"leaf-link").symlink_to("../outside")',
					'(work/"parent-link").symlink_to("..")',
					'(work/"internal-link").symlink_to("regular")',
					'(work/"directory").mkdir()',
					'os.mkfifo(work/"fifo")',
					'os.mknod(work/"device",stat.S_IFCHR|0o600,os.makedev(1,3))',
					'os.chdir(work)',
					'endpoint=socket.socket(socket.AF_UNIX); endpoint.bind("socket"); endpoint.close()',
				].join('\n'),
				proofRoot,
			],
			{ signal: AbortSignal.timeout(30_000) },
		);
		expect(setup.exitCode).toBe(0);
	});
	afterAll(async () => {
		await fixture?.close();
	});

	it.each([
		'../outside',
		`${proofRoot}/outside`,
		'directory/../../outside',
		'leaf-link',
		'parent-link/outside',
		'internal-link',
		'directory',
		'fifo',
		'socket',
		'device',
	])('rejects %s without emitting source bytes, then remains usable', async (selectedPath) => {
		// Arrange: this invokes the real fixed reader through the neutral VM adapter.
		const files = createOperationFolderGuestAccess({
			vm: fixture.vm,
			root: `${proofRoot}/work`,
			program: await loadOperationFolderGuestProgram(),
			pythonExecutable: fileRelayPythonExecutable,
			signal: AbortSignal.timeout(5_000),
		});
		// Act / Assert: a block or timeout is not accepted as successful rejection.
		await expect(files.read(selectedPath)[Symbol.asyncIterator]().next()).rejects.toMatchObject({
			name: 'Error',
			reason: expect.stringMatching(/^(invalid-path|integrity-mismatch)$/u),
		});
		const received: number[] = [];
		for await (const chunk of files.read('regular')) received.push(...chunk);
		expect(received).toEqual([0, 255, 128, 1]);
		const sentinel = await fixture.vm.exec(
			[
				fileRelayPythonExecutable,
				'-c',
				'import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_bytes()==b"outside-secret-sentinel"',
				`${proofRoot}/outside`,
			],
			{ signal: AbortSignal.timeout(5_000) },
		);
		expect(sentinel.exitCode).toBe(0);
	});
});
