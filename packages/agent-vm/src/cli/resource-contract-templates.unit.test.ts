import { describe, expect, it } from 'vitest';

import {
	buildDockerComposeTemplate,
	buildRepoResourcesAgentsTemplate,
	buildRepoResourcesDeclarationTemplate,
	buildRepoResourcesReadmeTemplate,
	buildRepoResourcesTemplate,
	buildRunSetupShellTemplate,
	GENERATED_MARKER,
} from './resource-contract-templates.js';

describe('resource contract templates', () => {
	it('builds a repo-resources.ts contract with describe and finalize functions', () => {
		const source = buildRepoResourcesTemplate();

		expect(source).toContain('/// <reference path="./repo-resources.d.ts" />');
		expect(source).toContain('export function describeRepoResources');
		expect(source).toContain('export async function finalizeRepoResourceSetup');
		expect(source).not.toContain('@agent-vm/agent-vm');
		expect(source).not.toContain('resources-post-hook');
	});

	it('builds generated declaration support with inline types and no package import', () => {
		const declaration = buildRepoResourcesDeclarationTemplate();

		expect(declaration).toContain(GENERATED_MARKER);
		expect(declaration).toContain('interface RepoResourcesDescription');
		expect(declaration).toContain('interface FinalizeRepoResourceSetupInput');
		expect(declaration).toContain('interface RepoResourcesFinal');
		expect(declaration).toContain('Describe-time contract exported');
		expect(declaration).not.toContain('@agent-vm/agent-vm');
	});

	it('builds the setup shell entrypoint without describe or hook ids', () => {
		const script = buildRunSetupShellTemplate();

		expect(script).toContain('RESOURCE_OUTPUT_DIR');
		expect(script).toContain('COMPOSE_PROJECT_NAME');
		expect(script).not.toContain('resource_name=');
		expect(script).not.toContain('${1:?');
		expect(script).not.toContain('REPO_COMPONENTS');
		expect(script).not.toContain('describe)');
		expect(script).not.toContain('hookId');
	});

	it('builds a docker compose template', () => {
		expect(buildDockerComposeTemplate()).toContain('services:');
	});

	it('builds generated agent instructions with the resource mental model', () => {
		const agents = buildRepoResourcesAgentsTemplate();

		expect(agents).toContain(
			'repo-resources.ts is the contract the controller loads and validates',
		);
		expect(agents).toContain('Run agent-vm resources update');
		expect(agents).toContain('Put schema-shaped logic in TypeScript');
		expect(agents).toContain('run-setup.sh receives COMPOSE_PROJECT_NAME');
		expect(agents).toContain('run-setup.sh is called once per requested repo');
		expect(agents).toContain('Do not use resources-post-hook.ts');
	});

	it('builds generated README docs that explain TS vs shell responsibilities', () => {
		const readme = buildRepoResourcesReadmeTemplate();

		expect(readme).toContain('repo-resources.ts is the contract the controller actually speaks to');
		expect(readme).toContain('finalizeRepoResourceSetup(input)');
		expect(readme).toContain('receives resolved binding and target information');
		expect(readme).toContain('run-setup.sh is called once per requested repo');
		expect(readme).toContain('COMPOSE_PROJECT_NAME');
		expect(readme).toContain('If you need resolved host/port values');
		expect(readme).toContain('Do not publish host ports');
	});
});
