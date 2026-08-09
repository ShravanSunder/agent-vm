import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	scaffoldWorkerE2eProject,
} from '../packages/agent-vm/src/integration-tests/e2e-harness.js';

async function main(): Promise<void> {
	process.env.AGENT_VM_E2E_CACHE_DIR ??= '/tmp/agent-vm-e2e-cache';
	process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = '1';
	process.env.AGENT_VM_GONDOLIN_E2E = '1';

	let openClawTempRoot: string | undefined;
	let workerTempRoot: string | undefined;
	try {
		const openClawProject = await scaffoldOpenClawE2eProject({
			agents: ['main'],
			architecture: currentE2eArchitecture(),
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'ci-image-cache',
		});
		openClawTempRoot = openClawProject.tempRoot;
		const workerProject = await scaffoldWorkerE2eProject({
			architecture: currentE2eArchitecture(),
			prefix: 'worker-loop-e2e-',
			zoneId: 'ci-worker-image-cache',
		});
		workerTempRoot = workerProject.tempRoot;
		await Promise.all([
			prepareGatewayE2eProjectImages({ project: openClawProject }),
			prepareGatewayE2eProjectImages({ project: workerProject }),
		]);
		process.stdout.write(`Prepared E2E image cache at ${process.env.AGENT_VM_E2E_CACHE_DIR}\n`);
	} finally {
		await Promise.all([
			...(openClawTempRoot === undefined ? [] : [removeE2eTempRoot(openClawTempRoot)]),
			...(workerTempRoot === undefined ? [] : [removeE2eTempRoot(workerTempRoot)]),
		]);
	}
}

await main();
