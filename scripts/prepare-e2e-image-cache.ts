import {
	currentE2eArchitecture,
	prepareGatewayE2eProjectImages,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
	scaffoldWorkerE2eProject,
	useLocalOpenClawPluginGatewayImage,
} from '../packages/agent-vm/src/integration-tests/e2e-harness.js';

async function main(): Promise<void> {
	process.env.AGENT_VM_E2E_CACHE_DIR ??= '/tmp/agent-vm-e2e-cache';
	process.env.AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES = '1';
	process.env.AGENT_VM_GONDOLIN_E2E = '1';

	let openClawTempRoot: string | undefined;
	let openClawPluginTempRoot: string | undefined;
	let workerTempRoot: string | undefined;
	try {
		const openClawProject = await scaffoldOpenClawE2eProject({
			agents: ['main'],
			architecture: currentE2eArchitecture(),
			prefix: 'agent-vm-gateway-e2e-project-',
			zoneId: 'ci-image-cache',
		});
		openClawTempRoot = openClawProject.tempRoot;
		const openClawPluginProject = await scaffoldOpenClawE2eProject({
			agents: ['main'],
			architecture: currentE2eArchitecture(),
			prefix: 'agent-vm-gateway-e2e-plugin-project-',
			zoneId: 'ci-plugin-image-cache',
		});
		openClawPluginTempRoot = openClawPluginProject.tempRoot;
		const workerProject = await scaffoldWorkerE2eProject({
			architecture: currentE2eArchitecture(),
			prefix: 'worker-loop-e2e-',
			zoneId: 'ci-worker-image-cache',
		});
		workerTempRoot = workerProject.tempRoot;
		await prepareGatewayE2eProjectImages({ imageFamilies: ['gateway'], project: openClawProject });
		const pluginProfileName = openClawPluginProject.zone.gateway.imageProfile;
		await useLocalOpenClawPluginGatewayImage({
			profileName: pluginProfileName,
			projectRoot: openClawPluginProject.tempRoot,
			repoRoot: process.cwd(),
			systemConfig: openClawPluginProject.systemConfig,
		});
		await prepareGatewayE2eProjectImages({ project: openClawPluginProject });
		await prepareGatewayE2eProjectImages({ imageFamilies: ['gateway'], project: workerProject });
		process.stdout.write(`Prepared E2E image cache at ${process.env.AGENT_VM_E2E_CACHE_DIR}\n`);
	} finally {
		await Promise.all([
			...(openClawTempRoot === undefined ? [] : [removeE2eTempRoot(openClawTempRoot)]),
			...(openClawPluginTempRoot === undefined ? [] : [removeE2eTempRoot(openClawPluginTempRoot)]),
			...(workerTempRoot === undefined ? [] : [removeE2eTempRoot(workerTempRoot)]),
		]);
	}
}

await main();
