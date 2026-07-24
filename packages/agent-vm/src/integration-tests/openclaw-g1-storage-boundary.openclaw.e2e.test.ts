import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { type ManagedVmCreateRequest, type ManagedVmMount } from '@agent-vm/managed-vm';
import {
	fakeUpstreamNamespace,
	startFakeUpstreamMcpServer,
} from '@agent-vm/mcp-portal/testing/fake-upstream-mcp-server';
import { describe, expect, it } from 'vitest';

import {
	canRunManagedVmE2e,
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	startE2eControllerRuntime,
	startE2eGatewayZone,
	useLocalOpenClawGatewayImagePackages,
	writeOpenClawMcpPortalE2eConfigs,
	type E2eHarnessRuntime,
} from './e2e-harness.js';

const architecture = currentE2eArchitecture();
const runOpenClawG1StorageBoundary =
	process.env.AGENT_VM_OPENCLAW_E2E === '1' && (await canRunManagedVmE2e({ architecture }));
const describeOpenClawG1StorageBoundary = runOpenClawG1StorageBoundary ? describe : describe.skip;

const agentId = 'g1-single-agent';
const gatewayToken = 'g1-storage-boundary-gateway-token';
const githubToken = 'g1-storage-boundary-github-token';
const perplexityToken = 'unused-g1-storage-boundary-token';

interface AuthoredTreeSnapshotEntry {
	readonly contentSha256: string | null;
	readonly gid: number;
	readonly kind: 'directory' | 'file' | 'symbolic-link';
	readonly mode: number;
	readonly modifiedAtNs: string;
	readonly relativePath: string;
	readonly size: string;
	readonly uid: number;
}

async function snapshotAuthoredTree(
	rootPath: string,
): Promise<readonly AuthoredTreeSnapshotEntry[]> {
	const entries: AuthoredTreeSnapshotEntry[] = [];
	const visit = async (relativePath: string): Promise<void> => {
		const absolutePath = relativePath.length === 0 ? rootPath : path.join(rootPath, relativePath);
		const metadata = await lstat(absolutePath, { bigint: true });
		const kind = metadata.isDirectory()
			? 'directory'
			: metadata.isFile()
				? 'file'
				: metadata.isSymbolicLink()
					? 'symbolic-link'
					: undefined;
		if (kind === undefined) {
			throw new Error(`Unsupported authored config-tree entry: ${absolutePath}`);
		}
		const content =
			kind === 'file'
				? await readFile(absolutePath)
				: kind === 'symbolic-link'
					? Buffer.from(await readlink(absolutePath), 'utf8')
					: undefined;
		entries.push({
			contentSha256:
				content === undefined ? null : createHash('sha256').update(content).digest('hex'),
			gid: Number(metadata.gid),
			kind,
			mode: Number(metadata.mode & 0o777n),
			modifiedAtNs: metadata.mtimeNs.toString(),
			relativePath: relativePath.length === 0 ? '.' : relativePath,
			size: metadata.size.toString(),
			uid: Number(metadata.uid),
		});
		if (kind !== 'directory') return;
		await Promise.all(
			(await readdir(absolutePath))
				.toSorted()
				.map(
					async (childName) =>
						await visit(relativePath.length === 0 ? childName : path.join(relativePath, childName)),
				),
		);
	};
	await visit('');
	return entries.toSorted((leftEntry, rightEntry) =>
		leftEntry.relativePath.localeCompare(rightEntry.relativePath),
	);
}

function hostSourcePathFromMount(mount: ManagedVmMount): string | undefined {
	switch (mount.kind) {
		case 'host-directory':
		case 'shadow':
			return mount.hostPath;
		case 'owned-host-directory':
		case 'owned-filtered-workspace':
			return mount.directory.identity.canonicalPath;
		case 'finalizable-memory':
		case 'memory':
			return undefined;
	}
}

function isSameOrDescendantPath(candidatePath: string, rootPath: string): boolean {
	const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function assertForbiddenHostRootsAbsentFromManagedVmRequest(options: {
	readonly authoredConfigurationParentPath: string;
	readonly controllerStateDirectoryPath: string;
	readonly request: ManagedVmCreateRequest;
}): void {
	const forbiddenHostRoots = [
		path.resolve(options.authoredConfigurationParentPath),
		path.resolve(options.controllerStateDirectoryPath),
	];
	for (const [guestPath, mount] of Object.entries(options.request.mounts)) {
		const sourcePath = hostSourcePathFromMount(mount);
		if (sourcePath === undefined) continue;
		for (const forbiddenHostRoot of forbiddenHostRoots) {
			expect(
				isSameOrDescendantPath(sourcePath, forbiddenHostRoot) ||
					isSameOrDescendantPath(forbiddenHostRoot, sourcePath),
				`managed VM mount '${guestPath}' must not source forbidden host root '${forbiddenHostRoot}'`,
			).toBe(false);
		}
	}
	const serializedNonSecretRequestInputs = JSON.stringify({
		allowedHosts: options.request.allowedHosts,
		environment: options.request.environment,
		imageReference: options.request.imageReference,
		mountGuestPaths: Object.keys(options.request.mounts),
		resources: options.request.resources,
		rootfsMode: options.request.rootfsMode,
		runtimeRootfsSize: options.request.runtimeRootfsSize,
		sessionLabel: options.request.sessionLabel,
		sshEgress: options.request.sshEgress,
		tcpHosts: options.request.tcpHosts,
	});
	for (const forbiddenHostRoot of forbiddenHostRoots) {
		expect(serializedNonSecretRequestInputs).not.toContain(forbiddenHostRoot);
	}
}

describeOpenClawG1StorageBoundary('G1: single-agent OpenClaw storage boundary', () => {
	it('keeps controller state and the authored config parent outside the Gateway while Tool Portal attaches through private UDS', async () => {
		const repoRoot = path.resolve(process.cwd());
		const upstreamHost = 'g1-upstream.vm.host';
		const authoredParentSentinelName = 'g1-authored-parent-sentinel.txt';
		const controllerStateSentinelName = 'g1-controller-state-sentinel.txt';
		const gatewayStateSentinelName = 'g1-gateway-state-sentinel.txt';
		const zoneFilesSentinelName = 'g1-zone-files-sentinel.txt';
		const upstreamServer = await startFakeUpstreamMcpServer();
		let harness: E2eHarnessRuntime | undefined;
		let project: Awaited<ReturnType<typeof scaffoldOpenClawE2eProject>> | undefined;
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;

		try {
			project = await scaffoldOpenClawE2eProject({
				agents: [agentId],
				architecture,
				prefix: 'openclaw-g1-storage-boundary-e2e-',
				zoneId: 'g1-storage-boundary',
			});
			const zone = project.systemConfig.zones[0];
			if (zone === undefined || zone.gateway.type !== 'openclaw') {
				throw new Error('G1 storage proof requires an OpenClaw zone.');
			}
			zone.egressHosts = [...zone.egressHosts, { audience: 'gateway', host: upstreamHost }];
			const toolPortalConfigDir = path.dirname(zone.gateway.config);
			zone.toolPortal = {
				configDir: toolPortalConfigDir,
				surfaceEligibilityByProfile: {
					smoke: { [fakeUpstreamNamespace]: ['mcp', 'protected_uds'] },
				},
			};
			const controllerRecordDirectory = path.join(
				project.systemConfig.controllerStateDir,
				'zones',
				zone.id,
			);
			await Promise.all([
				mkdir(controllerRecordDirectory, { recursive: true }),
				mkdir(zone.gateway.stateDir, { recursive: true }),
				mkdir(path.join(zone.gateway.zoneFilesDir, 'agents', agentId), { recursive: true }),
			]);
			const authoredParentSentinelPath = path.join(toolPortalConfigDir, authoredParentSentinelName);
			await Promise.all([
				writeFile(authoredParentSentinelPath, 'operator-authored parent sentinel\n', {
					encoding: 'utf8',
					mode: 0o640,
				}),
				writeFile(
					path.join(controllerRecordDirectory, controllerStateSentinelName),
					'controller-authority-host-only\n',
					{ encoding: 'utf8', mode: 0o600 },
				),
				writeFile(
					path.join(zone.gateway.stateDir, gatewayStateSentinelName),
					'gateway-state-visible\n',
					'utf8',
				),
				writeFile(
					path.join(zone.gateway.zoneFilesDir, zoneFilesSentinelName),
					'zone-files-visible\n',
					'utf8',
				),
			]);
			await writeOpenClawMcpPortalE2eConfigs({
				agentId,
				configDir: toolPortalConfigDir,
				namespace: fakeUpstreamNamespace,
				upstreamUrl: `http://${upstreamHost}:${String(upstreamServer.port)}/mcp`,
			});
			const authoredTreeBefore = await snapshotAuthoredTree(toolPortalConfigDir);
			await useLocalOpenClawGatewayImagePackages({
				profileName: zone.gateway.imageProfile,
				projectRoot: project.tempRoot,
				repoRoot,
				systemConfig: project.systemConfig,
			});
			await prepareGatewayE2eProjectImages({ project });
			let gatewayVm: Awaited<ReturnType<typeof startE2eGatewayZone>>['vm'] | undefined;
			harness = await startE2eControllerRuntime({
				secrets: {
					GITHUB_TOKEN: githubToken,
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
					PERPLEXITY_API_KEY: perplexityToken,
				},
				startGatewayZone: async (startOptions) => {
					const result = await startE2eGatewayZone(startOptions, {
						onManagedVmCreateRequest: (request) => {
							managedVmCreateRequest = request;
						},
					});
					if (result.executionModel !== 'managed-gateway') {
						throw new Error('G1 storage proof requires managed Gateway image boot.');
					}
					gatewayVm = result.vm;
					return result;
				},
				startOptions: {
					systemConfig: project.systemConfig,
					zoneIds: [zone.id],
				},
				tcpHostsOverride: {
					[`${upstreamHost}:${String(upstreamServer.port)}`]: `127.0.0.1:${String(upstreamServer.port)}`,
				},
			});
			const gatewayIngress = harness.runtime.zones[0]?.gateway?.ingress;
			if (gatewayIngress === undefined || gatewayVm === undefined) {
				throw new Error(
					`G1 OpenClaw startup did not publish the managed Gateway: ${JSON.stringify(harness.runtime.zones[0])}`,
				);
			}
			if (managedVmCreateRequest === undefined) {
				throw new Error('G1 OpenClaw startup did not expose the managed VM create request.');
			}
			assertForbiddenHostRootsAbsentFromManagedVmRequest({
				authoredConfigurationParentPath: toolPortalConfigDir,
				controllerStateDirectoryPath: project.systemConfig.controllerStateDir,
				request: managedVmCreateRequest,
			});

			const mountBoundaryProbe = await gatewayVm.exec(`
set -eu
test "$(cat /home/openclaw/.openclaw/state/${gatewayStateSentinelName})" = "gateway-state-visible"
test "$(cat /zone/${zoneFilesSentinelName})" = "zone-files-visible"
for managed_root in /home/openclaw/.openclaw /zone /agent-vm /run/agent-vm; do
  if [ -e "$managed_root" ]; then
    forbidden_matches="$(find "$managed_root" \\( -name '${controllerStateSentinelName}' -o -name '${authoredParentSentinelName}' \\) -print)"
    test -z "$forbidden_matches"
  fi
done
printf 'g1-mount-boundary-ok\\n'
`);
			expect(mountBoundaryProbe).toMatchObject({ exitCode: 0 });
			expect(mountBoundaryProbe.stdout.trim()).toBe('g1-mount-boundary-ok');

			const attachmentEvidence = await gatewayVm.exec([
				'cat',
				'/run/agent-vm/gateway-runtime/tool-portal.readiness.json',
			]);
			expect(attachmentEvidence.exitCode).toBe(0);
			const parsedAttachmentEvidence: unknown = JSON.parse(attachmentEvidence.stdout);
			expect(parsedAttachmentEvidence).toMatchObject({
				uds: { attachment: { status: 'attached' } },
			});
			const bootInputBoundaryProbe = await gatewayVm.exec([
				'node',
				'--input-type=module',
				'--eval',
				`import { readdir, readFile } from 'node:fs/promises';
const root = '/run/agent-vm/managed-gateway';
const forbiddenValues = ${JSON.stringify([
					path.resolve(project.systemConfig.controllerStateDir),
					path.resolve(toolPortalConfigDir),
				])};
const visit = async (directoryPath) => {
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const entryPath = directoryPath + '/' + entry.name;
    if (entry.isDirectory()) await visit(entryPath);
    else if (entry.isFile()) {
      const content = await readFile(entryPath, 'utf8');
      for (const forbiddenValue of forbiddenValues) {
        if (content.includes(forbiddenValue)) throw new Error('forbidden host authority path in boot input');
      }
    } else throw new Error('unexpected managed Gateway boot input member');
  }
};
await visit(root);
console.log('g1-boot-input-boundary-ok');`,
			]);
			expect(bootInputBoundaryProbe).toMatchObject({ exitCode: 0 });
			expect(bootInputBoundaryProbe.stdout.trim()).toBe('g1-boot-input-boundary-ok');

			expect(await snapshotAuthoredTree(toolPortalConfigDir)).toEqual(authoredTreeBefore);
			expect(await readFile(authoredParentSentinelPath, 'utf8')).toBe(
				'operator-authored parent sentinel\n',
			);
		} finally {
			await harness?.close();
			await upstreamServer.close();
			if (project !== undefined) {
				await removeE2eTempRoot(project.tempRoot);
			}
		}
	}, 900_000);
});
