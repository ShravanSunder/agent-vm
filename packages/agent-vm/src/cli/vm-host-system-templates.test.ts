import { describe, expect, it } from 'vitest';

import {
	renderVmHostSystemDockerfile,
	renderVmHostSystemReadme,
	renderVmHostSystemStartScript,
	renderVmHostSystemSystemdUnit,
} from './vm-host-system-templates.js';

const renderOptions = {
	gondolinPackageSpec: '@earendil-works/gondolin@0.8.0',
	imageArchitecture: 'x86_64',
	zigVersion: '0.15.2',
} as const satisfies Parameters<typeof renderVmHostSystemDockerfile>[0];

describe('vm-host-system templates', () => {
	it('substitutes zig version and gondolin package into the Dockerfile', () => {
		const dockerfile = renderVmHostSystemDockerfile(renderOptions);

		expect(dockerfile).toContain('zig-x86_64-linux-0.15.2');
		expect(dockerfile).toContain('@earendil-works/gondolin@0.8.0');
		expect(dockerfile).toContain('image pull alpine-base:latest --arch x86_64');
		expect(dockerfile).toContain(
			'mkdir -p /var/agent-vm/state /var/agent-vm/runtime /var/agent-vm/cache',
		);
		expect(dockerfile).not.toContain('/var/agent-vm/workspace');
	});

	it('uses the selected image architecture for Gondolin warmup', () => {
		const dockerfile = renderVmHostSystemDockerfile({
			...renderOptions,
			imageArchitecture: 'aarch64',
		});

		expect(dockerfile).toContain('image pull alpine-base:latest --arch aarch64');
	});

	it('includes the ARG GIT_SHA guard without a default', () => {
		const dockerfile = renderVmHostSystemDockerfile(renderOptions);

		expect(dockerfile).toMatch(/ARG GIT_SHA\b(?!=)/u);
		expect(dockerfile).toContain('GIT_SHA build-arg required');
	});

	it('substitutes zone id into the start script exec line', () => {
		const startScript = renderVmHostSystemStartScript({ zoneId: 'coding-agent' });

		expect(startScript).toContain('--zone coding-agent');
	});

	it('includes the required variable checks', () => {
		const startScript = renderVmHostSystemStartScript({ zoneId: 'coding-agent' });

		expect(startScript).toMatch(/OPENAI_API_KEY\s+GITHUB_TOKEN/u);
	});

	it('renders the systemd unit without placeholders', () => {
		const unit = renderVmHostSystemSystemdUnit();

		expect(unit).toContain('ExecStart=/usr/local/bin/start.sh');
		expect(unit).toContain('Requires=docker.service');
	});

	it('renders the README with the zone and project path', () => {
		const readme = renderVmHostSystemReadme({ zoneId: 'coding-agent' });

		expect(readme).toContain('vm-host-system');
		expect(readme).toContain('coding-agent');
	});
});
