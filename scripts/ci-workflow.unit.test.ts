import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function readRepositoryFile(relativePath: string): Promise<string> {
	return await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('CI workflow topology', () => {
	it('keeps every required proof lane behind one aggregate check', async () => {
		const workflow = await readRepositoryFile('.github/workflows/ci.yml');

		for (const jobName of ['validation:', 'e2e-image-cache:', 'e2e-host:', 'e2e-vm:', 'check:']) {
			expect(workflow).toContain(`  ${jobName}`);
		}

		for (const command of [
			'pnpm check',
			'pnpm test:unit',
			'pnpm test:integration',
			'pnpm python:test:host',
			'pnpm python:test:hermes',
			'pnpm test:e2e:inventory',
			'pnpm run test:e2e:${{ matrix.lane }}',
			'pnpm run test:e2e:vm -- --shard=${{ matrix.shard }}',
			'pnpm run test:e2e:vm-managed-gateway',
			'managed-gateway-test-group: core',
			'managed-gateway-test-group: input-missing-tool-portal',
			'managed-gateway-test-group: input-missing-framework',
			'managed-gateway-test-group: input-read-only-environment',
			'managed-gateway-test-group: termination-tool-portal',
			'managed-gateway-test-group: termination-openclaw',
			'managed-gateway-test-group: worker-stock',
			'AGENT_VM_MANAGED_GATEWAY_TEST_GROUP: ${{ matrix.managed-gateway-test-group }}',
			"AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE: '1'",
		]) {
			expect(workflow).toContain(command);
		}
		for (const managedGatewayGroup of [
			'core',
			'input-missing-tool-portal',
			'input-missing-framework',
			'input-read-only-environment',
			'termination-tool-portal',
			'termination-openclaw',
			'worker-stock',
		]) {
			expect(workflow).toContain(`managed-gateway-test-group: ${managedGatewayGroup}`);
		}
		for (const shard of ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']) {
			expect(workflow).toContain(`shard: ${shard}`);
		}
		for (const hostLane of ['host-docker', 'host', 'vm-mediation']) {
			expect(workflow).toContain(`- ${hostLane}`);
		}
		expect(workflow).not.toContain(
			'--exclude packages/agent-vm/src/integration-tests/managed-gateway-image-boot.vm.e2e.test.ts',
		);

		expect(workflow).toContain('needs: e2e-image-cache');
		expect(workflow).toContain('if: always()');
		expect(workflow).toContain('if [[ "${result##*=}" != success ]]');
		expect(workflow).toContain('AGENT_VM_E2E_CACHE_DIR: /tmp/agent-vm-e2e-cache');
		expect(workflow).toContain("AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1'");
		expect(workflow).toContain('e2e-host=${E2E_HOST_RESULT}');
		expect(workflow).toContain('uses: ./.github/actions/restore-e2e-image-cache');
		expect(workflow).toContain('uses: ./.github/actions/resolve-e2e-image-cache-key');
		expect(workflow).toContain("lookup-only: 'true'");
		expect(workflow).toContain(
			'      - parallel:\n          - name: Restore prepared OpenClaw image cache',
		);
		expect(workflow).toContain('          - name: Restore prepared Worker image cache');
		expect(workflow).toContain('          - name: Set up Agent VM workspace');
		expect(workflow).toContain(
			'          - name: Set up Python workspace\n' +
				"            if: matrix.lane == 'host'\n" +
				'            uses: ./.github/actions/setup-python-workspace',
		);
		expect(workflow).not.toContain('\n      - name: Set up Agent VM workspace\n');
		const parallelPreparationStart = workflow.indexOf(
			'      - parallel:\n          - name: Restore prepared OpenClaw image cache',
		);
		const workspaceSetupPosition = workflow.indexOf(
			'          - name: Set up Agent VM workspace',
			parallelPreparationStart,
		);
		const cacheHitBarrierPosition = workflow.indexOf(
			'      - name: Require prepared image caches',
			parallelPreparationStart,
		);
		expect(parallelPreparationStart).toBeGreaterThanOrEqual(0);
		expect(cacheHitBarrierPosition).toBeGreaterThan(parallelPreparationStart);
		expect(workspaceSetupPosition).toBeGreaterThan(parallelPreparationStart);
		expect(workspaceSetupPosition).toBeLessThan(cacheHitBarrierPosition);
		expect(cacheHitBarrierPosition).toBeGreaterThan(workspaceSetupPosition);
	});

	it('keys prepared images from all package build inputs and prepares both image families', async () => {
		const [workflow, cacheAction, cacheKeyAction, setupAction, preparationScript] =
			await Promise.all([
				readRepositoryFile('.github/workflows/ci.yml'),
				readRepositoryFile('.github/actions/restore-e2e-image-cache/action.yml'),
				readRepositoryFile('.github/actions/resolve-e2e-image-cache-key/action.yml'),
				readRepositoryFile('.github/actions/setup-agent-vm/action.yml'),
				readRepositoryFile('scripts/prepare-e2e-image-cache.ts'),
			]);

		for (const cacheInput of [
			'.github/actions/setup-agent-vm/action.yml',
			'.github/actions/setup-python-workspace/action.yml',
			'.github/actions/setup-system-packages/action.yml',
			'.github/actions/restore-e2e-image-cache/action.yml',
			'.github/actions/resolve-e2e-image-cache-key/action.yml',
			'pnpm-workspace.yaml',
			'.node-version',
			'.npmrc',
			'.pnpmfile.cjs',
			'mise.toml',
			'packages/**/src/**',
			'packages/**/type-tests/**',
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
			expect(cacheKeyAction).toContain(cacheInput);
		}

		expect(workflow).not.toContain('E2E_IMAGE_INPUT_HASH');
		expect(cacheAction).not.toContain('E2E_IMAGE_INPUT_HASH');
		expect(cacheKeyAction.match(/E2E_IMAGE_INPUT_HASH:\s*([^\n]+)/gu)).toHaveLength(1);
		expect(
			cacheAction.match(
				/agent-vm-e2e-images-v2-openclaw-\$\{\{ runner\.os \}\}-\$\{\{ inputs\.input-hash \}\}/gu,
			),
		).toHaveLength(1);

		expect(workflow).toContain('permissions:\n  contents: read');
		expect(workflow).toContain('persist-credentials: false');
		expect(preparationScript).toContain('useLocalOpenClawPluginGatewayImage');
		expect(preparationScript).toContain(
			"imageFamilies: ['gateway'],\n\t\t\tproject: openClawPluginProject",
		);

		expect(cacheAction).toContain('Restore prepared OpenClaw image cache');
		expect(cacheAction).toContain('Restore prepared Worker image cache');
		expect(cacheAction).toContain('lookup-only: ${{ inputs.lookup-only }}');
		expect(cacheAction).not.toContain('    - parallel:');
		expect(workflow).toContain('Save prepared OpenClaw image cache');
		expect(workflow).toContain('Save prepared Worker image cache');
		expect(cacheAction).toMatch(
			/\/tmp\/agent-vm-e2e-cache\/openclaw\n\s+\/tmp\/agent-vm-e2e-cache\/local-package-tarballs/u,
		);
		expect(
			`${cacheAction}\n${workflow}`.match(
				/\/tmp\/agent-vm-e2e-cache\/openclaw\n\s+\/tmp\/agent-vm-e2e-cache\/local-package-tarballs/gu,
			),
		).toHaveLength(2);
		expect(cacheAction).not.toContain('agent-vm-e2e-images-v1-openclaw');
		expect(cacheAction).not.toContain('restore-keys:');
		expect(setupAction).not.toContain('    - parallel:');
		expect(setupAction).not.toContain('Install Zig');
		expect(setupAction).not.toContain('ziglang.org');
		expect(preparationScript).toContain('scaffoldOpenClawE2eProject');
		expect(preparationScript).toContain('scaffoldWorkerE2eProject');
		expect(preparationScript).toContain('removeE2eTempRoot');
		expect(preparationScript).toContain('agent-vm-gateway-e2e-plugin-project-');
	});
});
