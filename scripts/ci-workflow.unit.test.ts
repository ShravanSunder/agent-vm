import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function readRepositoryFile(relativePath: string): Promise<string> {
	return await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('CI workflow topology', () => {
	it('keeps every required proof lane behind one aggregate check', async () => {
		const workflow = await readRepositoryFile('.github/workflows/ci.yml');

		for (const jobName of [
			'quality:',
			'tests:',
			'e2e-inventory:',
			'e2e-image-cache:',
			'e2e-fast:',
			'e2e-vm:',
			'e2e-vm-mediation:',
			'check:',
		]) {
			expect(workflow).toContain(`  ${jobName}`);
		}

		for (const command of [
			'pnpm run test:e2e:host-docker',
			'pnpm run test:e2e:host',
			'--shard=1/4',
			'--shard=2/4',
			'--shard=3/4',
			'--shard=4/4',
			'--exclude packages/agent-vm/src/integration-tests/managed-gateway-image-boot.vm.e2e.test.ts',
			'packages/agent-vm/src/integration-tests/managed-gateway-image-boot.vm.e2e.test.ts',
			'pnpm run test:e2e:vm-mediation',
			'managed-gateway-test-group: core',
			'managed-gateway-test-group: inputs',
			'managed-gateway-test-group: termination',
			'AGENT_VM_MANAGED_GATEWAY_TEST_GROUP: ${{ matrix.managed-gateway-test-group }}',
		]) {
			expect(workflow).toContain(command);
		}

		expect(workflow).toContain('needs: e2e-image-cache');
		expect(workflow).toContain('if: always()');
		expect(workflow).toContain('if [[ "${result##*=}" != success ]]');
		expect(workflow).toContain('AGENT_VM_E2E_CACHE_DIR: /tmp/agent-vm-e2e-cache');
		expect(workflow).toContain("AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1'");
		expect(workflow).toContain('e2e-vm-mediation=${E2E_VM_MEDIATION_RESULT}');
		expect(workflow).toContain('id: e2e-image-cache-key');
		expect(workflow).toContain('steps.e2e-image-cache-key.outputs.hash');
		expect(workflow).toContain('lookup-only: true');
	});

	it('keys prepared images from all package build inputs and prepares both image families', async () => {
		const [workflow, preparationScript] = await Promise.all([
			readRepositoryFile('.github/workflows/ci.yml'),
			readRepositoryFile('scripts/prepare-e2e-image-cache.ts'),
		]);

		for (const cacheInput of [
			'.github/actions/setup-agent-vm/action.yml',
			'pnpm-workspace.yaml',
			'packages/**/src/**',
			'packages/**/tsconfig*.json',
			'packages/**/tsdown.config.ts',
			'packages/**/README*',
			'packages/**/LICENSE*',
			'packages/**/LICENCE*',
			'packages/**/openclaw.plugin.json',
			'packages/**/contract-fixtures/**',
			'packages/**/sdk-validate.mjs',
			'packages/agent-vm/managed-images.json',
			'vm-images/**',
		]) {
			expect(workflow).toContain(cacheInput);
		}

		const cacheKeyExpressions = [...workflow.matchAll(/E2E_IMAGE_INPUT_HASH:\s*([^\n]+)/gu)].map(
			(match) => match[1],
		);
		expect(cacheKeyExpressions).toHaveLength(2);
		expect(cacheKeyExpressions[0]).toBe(cacheKeyExpressions[1]);

		expect(workflow).toContain('permissions:\n  contents: read');
		expect(workflow).toContain('persist-credentials: false');
		expect(preparationScript).toContain('useLocalOpenClawPluginGatewayImage');

		expect(workflow).toContain('Restore prepared OpenClaw image cache');
		expect(workflow).toContain('Restore prepared Worker image cache');
		expect(workflow).toContain('Save prepared OpenClaw image cache');
		expect(workflow).toContain('Save prepared Worker image cache');
		expect(workflow).not.toContain('restore-keys:');
		expect(preparationScript).toContain('scaffoldOpenClawE2eProject');
		expect(preparationScript).toContain('scaffoldWorkerE2eProject');
		expect(preparationScript).toContain('removeE2eTempRoot');
		expect(preparationScript).toContain('agent-vm-gateway-e2e-plugin-project-');
	});
});
