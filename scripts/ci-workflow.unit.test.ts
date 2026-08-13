import fs from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const managedGatewayCiTags = [
	'managed-gateway-startup',
	'managed-gateway-degraded-input',
	'managed-gateway-lifecycle',
] as const;

async function readRepositoryFile(relativePath: string): Promise<string> {
	return await fs.readFile(path.join(process.cwd(), relativePath), 'utf8');
}

function isManagedGatewayTestDeclaration(callExpression: ts.CallExpression): boolean {
	if (ts.isIdentifier(callExpression.expression)) {
		return callExpression.expression.text === 'it';
	}
	if (!ts.isCallExpression(callExpression.expression)) {
		return false;
	}
	const eachExpression = callExpression.expression.expression;
	return (
		ts.isPropertyAccessExpression(eachExpression) &&
		ts.isIdentifier(eachExpression.expression) &&
		eachExpression.expression.text === 'it' &&
		eachExpression.name.text === 'each'
	);
}

function readManagedGatewayTestTags(sourceText: string): readonly (readonly string[])[] {
	const sourceFile = ts.createSourceFile(
		'managed-gateway-image-boot.vm.e2e.test.ts',
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const testTags: string[][] = [];

	function visit(node: ts.Node): void {
		if (ts.isCallExpression(node) && isManagedGatewayTestDeclaration(node)) {
			const optionsArgument = node.arguments[1];
			if (optionsArgument === undefined || !ts.isObjectLiteralExpression(optionsArgument)) {
				testTags.push([]);
			} else {
				const tagsProperty = optionsArgument.properties.find(
					(property): property is ts.PropertyAssignment =>
						ts.isPropertyAssignment(property) &&
						ts.isIdentifier(property.name) &&
						property.name.text === 'tags',
				);
				if (tagsProperty === undefined || !ts.isArrayLiteralExpression(tagsProperty.initializer)) {
					testTags.push([]);
				} else {
					testTags.push(
						tagsProperty.initializer.elements.flatMap((element) =>
							ts.isStringLiteral(element) ? [element.text] : [],
						),
					);
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return testTags;
}

describe('CI workflow topology', () => {
	it('keeps every required proof lane behind one aggregate check', async () => {
		const [workflow, vitestConfig, managedGatewayTest] = await Promise.all([
			readRepositoryFile('.github/workflows/ci.yml'),
			readRepositoryFile('vitest.config.ts'),
			readRepositoryFile(
				'packages/agent-vm/src/integration-tests/managed-gateway-image-boot.vm.e2e.test.ts',
			),
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
			'pnpm run test:e2e:vm -- --shard=${{ matrix.shard }}',
			'pnpm run test:e2e:vm-managed-gateway',
			'--tags-filter=managed-gateway-startup',
			'--tags-filter=managed-gateway-degraded-input',
			'--tags-filter=managed-gateway-lifecycle',
			"AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE: '1'",
		]) {
			expect(workflow).toContain(command);
		}
		for (const managedGatewayTag of managedGatewayCiTags) {
			expect(vitestConfig).toContain(`name: '${managedGatewayTag}'`);
			expect(workflow).toContain(
				`pnpm run test:e2e:vm-managed-gateway --tags-filter=${managedGatewayTag}`,
			);
			expect(workflow).not.toContain(
				`pnpm run test:e2e:vm-managed-gateway -- --tags-filter=${managedGatewayTag}`,
			);
		}
		const managedGatewayTestTags = readManagedGatewayTestTags(managedGatewayTest);
		expect(managedGatewayTestTags.length).toBeGreaterThan(0);
		for (const testTags of managedGatewayTestTags) {
			expect(testTags).toHaveLength(1);
			expect(managedGatewayCiTags).toContain(testTags[0]);
		}
		expect(new Set(managedGatewayTestTags.flat())).toEqual(new Set(managedGatewayCiTags));
		expect(workflow.match(/lane: e2e-vm-managed-gateway/gu)).toHaveLength(1);
		expect(workflow).not.toContain('managed-gateway-test-group:');
		expect(workflow).not.toContain('AGENT_VM_MANAGED_GATEWAY_TEST_GROUP');
		expect(managedGatewayTest).not.toContain('AGENT_VM_MANAGED_GATEWAY_TEST_GROUP');
		expect(managedGatewayTest).not.toContain('shouldRegisterManagedGatewayTest');
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
		expect(workflow).toContain('      - name: Restore prepared Worker image cache');
		expect(workflow).not.toContain('\n          - name: Restore prepared Worker image cache\n');
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
