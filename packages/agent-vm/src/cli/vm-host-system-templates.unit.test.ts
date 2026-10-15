import { describe, expect, it } from 'vitest';

import {
	renderVmHostSystemDockerfile,
	renderVmHostSystemReadme,
	renderVmHostSystemStartScript,
	renderVmHostSystemSystemdUnit,
} from './vm-host-system-templates.js';

const renderOptions = {
	managedVmBackendPackageSpec: '@earendil-works/gondolin@0.9.1',
	imageArchitecture: 'x86_64',
} as const satisfies Parameters<typeof renderVmHostSystemDockerfile>[0];

describe('vm-host-system templates', () => {
	it('installs and preflights Python for native image publication', () => {
		const dockerfile = renderVmHostSystemDockerfile(renderOptions);
		const startScript = renderVmHostSystemStartScript({ zoneId: 'coding-agent' });

		expect(dockerfile).toMatch(/qemu-system-x86.*python3/u);
		expect(startScript).toMatch(/for cmd in .*python3/u);
	});
	it('uses published helpers without provisioning a host compiler', () => {
		const dockerfile = renderVmHostSystemDockerfile(renderOptions);

		expect(dockerfile).not.toMatch(/ziglang\.org|\/opt\/zig|\/usr\/local\/bin\/zig/u);
		expect(dockerfile).toContain('@earendil-works/gondolin@0.9.1');
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
		expect(dockerfile).not.toMatch(/ziglang\.org|\/opt\/zig/u);
	});

	it('does not bake generated Git SHA metadata into the host image', () => {
		const dockerfile = renderVmHostSystemDockerfile(renderOptions);

		expect(dockerfile).not.toContain('ARG GIT_SHA');
		expect(dockerfile).not.toContain('gitSha');
	});

	it('requires genuine normal-build commands without requiring Zig at startup', () => {
		const startScript = renderVmHostSystemStartScript({ zoneId: 'coding-agent' });

		const requiredCommands = startScript.match(/^for cmd in (.+); do$/mu)?.[1]?.split(' ');
		expect(requiredCommands).toEqual([
			'mke2fs',
			'docker',
			'agent-vm',
			'cpio',
			'lz4',
			'qemu-img',
			'qemu-system-x86_64',
			'python3',
		]);
		expect(startScript).toContain('agent-vm build --config /etc/agent-vm/system.json');
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
		expect(readme).toContain('does not install or require Zig');
	});
});
