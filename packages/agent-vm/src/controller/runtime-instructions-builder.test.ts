import { describe, expect, it } from 'vitest';

import { buildRuntimeInstructions } from './runtime-instructions-builder.js';

describe('buildRuntimeInstructions', () => {
	it('describes workspace, agent-visible runtime files, controller tools, resources, and auth hints', () => {
		const runtime = buildRuntimeInstructions({
			resolvedResources: [
				{
					name: 'pg',
					host: 'pg.local',
					port: 5432,
					envVars: ['DATABASE_URL'],
					outputPath: '/agent-vm/resources/portal',
				},
			],
			runtimeAuthHints: [
				{
					kind: 'service-token',
					secret: 'GITHUB_TOKEN',
					service: 'github',
					hosts: ['api.github.com'],
					tools: ['gh'],
				},
				{
					kind: 'service-token',
					secret: 'NPM_AUTH_TOKEN',
					service: 'npm',
					hosts: ['registry.npmjs.org'],
					tools: ['npm', 'pnpm', 'yarn'],
				},
				{
					kind: 'service-token',
					secret: 'PYPI_TOKEN',
					service: 'pypi-private',
					hosts: ['pypi.example.test'],
					tools: ['uv'],
				},
				{
					kind: 'service-token',
					secret: 'MAVEN_TOKEN',
					service: 'maven-private',
					hosts: ['maven.example.test'],
					tools: ['mvn'],
				},
			],
			taskId: 'task-123',
			workspaceDir: '/workspace',
		});

		expect(runtime.runtimeInstructions).toContain('Runtime instructions');
		expect(runtime.runtimeInstructions).toContain('/workspace/AGENTS.md');
		expect(runtime.runtimeInstructions).toContain('/workspace/CLAUDE.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/agents.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/CLAUDE.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/resources/portal');
		expect(runtime.runtimeInstructions).toContain('pg.local:5432');
		expect(runtime.runtimeInstructions).toContain('DATABASE_URL');
		expect(runtime.runtimeInstructions).toContain('git-push');
		expect(runtime.runtimeInstructions).toContain('github');
		expect(runtime.runtimeInstructions).toContain('gh');
		expect(runtime.runtimeInstructions).toContain('NPM_AUTH_TOKEN');
		expect(runtime.runtimeInstructions).toContain('registry.npmjs.org');
		expect(runtime.runtimeInstructions).toContain(
			'You MUST configure each tool below before running any command that uses it.',
		);
		expect(runtime.runtimeInstructions).toContain(
			`printf '//registry.npmjs.org/:_authToken=\${NPM_AUTH_TOKEN}\\n' > "$HOME/.npmrc"`,
		);
		expect(runtime.runtimeInstructions).toContain('npm, pnpm, and yarn-classic');
		expect(runtime.runtimeInstructions).toContain('If you must use yarn-berry');
		expect(runtime.runtimeInstructions).toContain('GH_TOKEN="$GITHUB_TOKEN" gh pr create');
		expect(runtime.runtimeInstructions).toContain(
			'UV_INDEX_URL="https://__token__:$PYPI_TOKEN@pypi.example.test/simple"',
		);
		expect(runtime.runtimeInstructions).not.toContain('PIP_INDEX_URL');
		expect(runtime.runtimeInstructions).not.toContain('poetry config');
		expect(runtime.runtimeInstructions).not.toContain('TWINE_PASSWORD');
		expect(runtime.runtimeInstructions).toContain(
			'Before using these tools, you MUST configure your toolchain to read the placeholder env var $MAVEN_TOKEN.',
		);
		expect(runtime.agentRuntimeFiles['agents.md']).toContain('/agent-vm/runtime-instructions.md');
		expect(runtime.agentRuntimeFiles['agents.md']).toContain('pg.local:5432');
		expect(runtime.agentRuntimeFiles['agents.md']).not.toContain('$NPM_AUTH_TOKEN');
		expect(runtime.workspaceAgentsMd).toContain('/agent-vm/agents.md');
	});
});
