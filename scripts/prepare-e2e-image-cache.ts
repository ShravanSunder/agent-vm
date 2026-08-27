import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldWorkerE2eProject,
} from '../packages/agent-vm/src/integration-tests/e2e-harness.js';
import {
	scaffoldHermesE2eProject,
	useLocalHermesGatewayImagePackages,
} from '../packages/agent-vm/src/integration-tests/hermes-e2e-harness.js';

async function main(): Promise<void> {
	process.env.AGENT_VM_E2E_CACHE_DIR ??= '/tmp/agent-vm-e2e-cache';
	process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = '1';
	process.env.AGENT_VM_GONDOLIN_E2E = '1';

	let hermesTempRoot: string | undefined;
	let workerTempRoot: string | undefined;
	try {
		const architecture = currentE2eArchitecture();
		const hermesProject = await scaffoldHermesE2eProject({
			agents: ['main'],
			architecture,
			prefix: 'agent-vm-hermes-e2e-cache-',
			zoneId: 'ci-hermes-image-cache',
		});
		hermesTempRoot = hermesProject.tempRoot;
		const workerProject = await scaffoldWorkerE2eProject({
			architecture,
			prefix: 'worker-loop-e2e-',
			zoneId: 'ci-worker-image-cache',
		});
		workerTempRoot = workerProject.tempRoot;
		await useLocalHermesGatewayImagePackages({
			architecture,
			profileName: hermesProject.zone.gateway.imageProfile,
			projectRoot: hermesProject.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: hermesProject.systemConfig,
		});
		await prepareGatewayE2eProjectImages({
			imageFamilies: ['gateway'],
			project: hermesProject,
		});
		await prepareGatewayE2eProjectImages({
			imageFamilies: ['toolVm'],
			project: hermesProject,
		});
		await prepareGatewayE2eProjectImages({
			imageFamilies: ['gateway'],
			project: workerProject,
		});
		process.stdout.write(`Prepared E2E image cache at ${process.env.AGENT_VM_E2E_CACHE_DIR}\n`);
	} finally {
		await Promise.all([
			...(hermesTempRoot === undefined ? [] : [removeE2eTempRoot(hermesTempRoot)]),
			...(workerTempRoot === undefined ? [] : [removeE2eTempRoot(workerTempRoot)]),
		]);
	}
}

await main();
