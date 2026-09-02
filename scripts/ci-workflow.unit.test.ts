import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function readRepositoryFile(relativePath: string): Promise<string> {
	return await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
}

describe('CI workflow topology', () => {
	it('keeps every required proof lane behind one aggregate check', async () => {
		const [workflow, hermesPythonTestScript] = await Promise.all([
			readRepositoryFile('.github/workflows/ci.yml'),
			readRepositoryFile('scripts/run-hermes-python-tests.sh'),
		]);

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
			'pnpm run test:e2e:vm --shard=${{ matrix.shard }}',
			'pnpm run test:e2e:hermes --shard=${{ matrix.hermesShard }}',
			'pnpm run test:e2e:worker',
			"AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE: '1'",
		]) {
			expect(workflow).toContain(command);
		}
		for (const command of [
			'mise exec -- pnpm run test:e2e:vm --shard=${{ matrix.shard }}',
			'mise exec -- pnpm run test:e2e:hermes --shard=${{ matrix.hermesShard }}',
			'mise exec -- pnpm run test:e2e:worker',
		]) {
			expect(workflow).toContain(command);
		}
		expect(hermesPythonTestScript).toContain('python/agent-vm-agent-portal-sdk/pyproject.toml');
		expect(hermesPythonTestScript).toContain('python/agent-vm-hermes-adapter/pyproject.toml');
		expect(hermesPythonTestScript).toContain(
			'metadata.version("agent-vm-agent-portal-sdk") == sdk_project["project"]["version"]',
		);
		expect(hermesPythonTestScript).toContain(
			'metadata.version("agent-vm-hermes-adapter") == adapter_project["project"]["version"]',
		);
		expect(hermesPythonTestScript).not.toMatch(
			/metadata\.version\("agent-vm-(?:agent-portal-sdk|hermes-adapter)"\) == "\d+\.\d+\.\d+"/u,
		);
		expect(workflow.match(/lane: hermes-shard-/gu)).toHaveLength(5);
		expect(workflow.match(/lane: worker/gu)).toHaveLength(1);
		expect(workflow).not.toContain('test:e2e:vm-managed-gateway');
		expect(workflow).not.toContain('managed-gateway-startup');
		expect(workflow).not.toContain('managed-gateway-degraded-input');
		expect(workflow).not.toContain('managed-gateway-lifecycle');
		for (const shard of ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']) {
			expect(workflow).toContain(`shard: ${shard}`);
		}
		for (const hermesShard of ['1/5', '2/5', '3/5', '4/5', '5/5']) {
			expect(workflow).toContain(`hermesShard: ${hermesShard}`);
		}
		expect(workflow).not.toContain('pnpm run test:e2e:vm -- --shard=');
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
		expect(workflow).toContain('name: Set up uv for Hermes image preparation');
		expect(workflow).toContain('uses: astral-sh/setup-uv@38f3f104447c67c051c4a08e39b64a148898af3a');
		expect(workflow).toContain("version: '0.11.31'");
		expect(workflow).toContain("lookup-only: 'true'");
		expect(workflow).toContain(
			'      - parallel:\n          - name: Restore prepared Hermes image cache',
		);
		expect(workflow).toContain('      - name: Restore prepared Worker image cache');
		expect(workflow).not.toContain('\n          - name: Restore prepared Worker image cache\n');
		expect(workflow).toContain('          - name: Set up Agent VM workspace');
		expect(workflow).toContain('          - name: Set up uv for VM proof');
		expect(workflow).toContain(
			'          - name: Set up uv for VM proof\n' +
				'            uses: astral-sh/setup-uv@38f3f104447c67c051c4a08e39b64a148898af3a # v9.0.0\n' +
				'            with:\n' +
				"              version: '0.11.31'\n" +
				'              enable-cache: false',
		);
		expect(workflow).toContain('          - name: Set up pinned VM toolchain');
		expect(workflow).toContain('uses: jdx/mise-action@c2a87611a18de5b3828c5652fe268e992400cb5c');
		expect(workflow).toContain(
			'          - name: Set up Python workspace\n' +
				"            if: matrix.lane == 'host'\n" +
				'            uses: ./.github/actions/setup-python-workspace',
		);
		expect(workflow).not.toContain('\n      - name: Set up Agent VM workspace\n');
		const parallelPreparationStart = workflow.indexOf(
			'      - parallel:\n          - name: Restore prepared Hermes image cache',
		);
		const workspaceSetupPosition = workflow.indexOf(
			'          - name: Set up Agent VM workspace',
			parallelPreparationStart,
		);
		const workerCacheRestorePosition = workflow.indexOf(
			'      - name: Restore prepared Worker image cache',
			parallelPreparationStart,
		);
		const cacheHitBarrierPosition = workflow.indexOf(
			'      - name: Require prepared image caches',
			parallelPreparationStart,
		);
		const vmPreparationBlock = workflow.slice(parallelPreparationStart, cacheHitBarrierPosition);
		expect(parallelPreparationStart).toBeGreaterThanOrEqual(0);
		expect(cacheHitBarrierPosition).toBeGreaterThan(parallelPreparationStart);
		expect(workspaceSetupPosition).toBeGreaterThan(parallelPreparationStart);
		expect(workerCacheRestorePosition).toBeGreaterThan(workspaceSetupPosition);
		expect(workerCacheRestorePosition).toBeLessThan(cacheHitBarrierPosition);
		expect(cacheHitBarrierPosition).toBeGreaterThan(workspaceSetupPosition);
		expect(vmPreparationBlock).toContain(
			'\n      - name: Set up system packages\n        uses: ./.github/actions/setup-system-packages',
		);
		expect(vmPreparationBlock).not.toContain('\n          - name: Set up system packages\n');
		expect(vmPreparationBlock).toContain('\n      - name: Require native VM acceleration');
		expect(vmPreparationBlock).toContain("        if: matrix.hermesShard != ''");
		expect(vmPreparationBlock).toContain('test -c /dev/kvm');
		expect(vmPreparationBlock).toContain('sudo chmod 0666 /dev/kvm');
		expect(vmPreparationBlock).toContain('test -r /dev/kvm');
		expect(vmPreparationBlock).toContain('test -w /dev/kvm');
	});

	it('keys and prepares the retained Hermes and Worker image families', async () => {
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
				/agent-vm-e2e-images-v1-hermes-\$\{\{ runner\.os \}\}-\$\{\{ inputs\.input-hash \}\}/gu,
			),
		).toHaveLength(1);

		expect(workflow).toContain('permissions:\n  contents: read');
		expect(workflow).toContain('persist-credentials: false');
		expect(preparationScript).toContain('materializeLocalHermesGatewayImagePackages');
		expect(preparationScript.match(/imageFamilies: \['gateway'\]/gu)).toHaveLength(2);
		expect(preparationScript.match(/imageFamilies: \['toolVm'\]/gu)).toHaveLength(1);
		expect(preparationScript).toMatch(
			/prepareGatewayE2eProjectImages\(\{\s+imageFamilies: \['gateway'\],\s+project: workerProject,/u,
		);

		expect(cacheAction).toContain('Restore prepared Hermes image cache');
		expect(cacheAction).toContain('Restore prepared Worker image cache');
		expect(cacheAction).toContain('lookup-only: ${{ inputs.lookup-only }}');
		expect(cacheAction).not.toContain('    - parallel:');
		expect(workflow).toContain('Save prepared Hermes image cache');
		expect(workflow).toContain('Save prepared Worker image cache');
		expect(cacheAction).toMatch(
			/\/tmp\/agent-vm-e2e-cache\/hermes\n\s+\/tmp\/agent-vm-e2e-cache\/local-package-tarballs/u,
		);
		expect(
			`${cacheAction}\n${workflow}`.match(
				/\/tmp\/agent-vm-e2e-cache\/hermes\n\s+\/tmp\/agent-vm-e2e-cache\/local-package-tarballs/gu,
			),
		).toHaveLength(2);
		expect(cacheAction).not.toContain('restore-keys:');
		expect(setupAction).not.toContain('    - parallel:');
		expect(setupAction).not.toContain('Install Zig');
		expect(setupAction).not.toContain('ziglang.org');
		expect(preparationScript).toContain('scaffoldHermesE2eProject');
		expect(preparationScript).toContain('scaffoldWorkerE2eProject');
		expect(preparationScript).toContain('removeE2eTempRoot');
		expect(preparationScript).toContain('agent-vm-hermes-e2e-cache-');
		expect(`${workflow}\n${cacheAction}\n${preparationScript}`.toLowerCase()).not.toContain(
			'openclaw',
		);
	});
});
