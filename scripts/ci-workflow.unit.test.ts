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
			'pnpm run test:e2e:vm -- --shard=1/2',
			'pnpm run test:e2e:vm -- --shard=2/2',
			'pnpm run test:e2e:vm-mediation',
		]) {
			expect(workflow).toContain(command);
		}

		expect(workflow).toContain('needs: e2e-image-cache');
		expect(workflow).toContain('if: always()');
		expect(workflow).toContain('if [[ "${result##*=}" != success ]]');
		expect(workflow).toContain('AGENT_VM_E2E_CACHE_DIR: /tmp/agent-vm-e2e-cache');
		expect(workflow).toContain("AGENT_VM_E2E_SKIP_WORKSPACE_BUILD: '1'");
		expect(workflow).toContain('e2e-vm-mediation=${E2E_VM_MEDIATION_RESULT}');
	});

	it('keys prepared images from all package build inputs and prepares both image families', async () => {
		const [workflow, preparationScript] = await Promise.all([
			readRepositoryFile('.github/workflows/ci.yml'),
			readRepositoryFile('scripts/prepare-e2e-image-cache.ts'),
		]);

		for (const cacheInput of [
			'packages/**/src/**',
			'packages/**/tsconfig*.json',
			'packages/**/tsdown.config.ts',
			'packages/**/openclaw.plugin.json',
			'packages/**/contract-fixtures/**',
			'packages/**/sdk-validate.mjs',
			'packages/agent-vm/managed-images.json',
			'vm-images/**',
		]) {
			expect(workflow).toContain(cacheInput);
		}

		expect(workflow).toContain('Restore prepared OpenClaw image cache');
		expect(workflow).toContain('Restore prepared Worker image cache');
		expect(workflow).toContain('Save prepared OpenClaw image cache');
		expect(workflow).toContain('Save prepared Worker image cache');
		expect(workflow).not.toContain('restore-keys:');
		expect(preparationScript).toContain('scaffoldOpenClawE2eProject');
		expect(preparationScript).toContain('scaffoldWorkerE2eProject');
		expect(preparationScript).toContain('removeE2eTempRoot');
	});
});
