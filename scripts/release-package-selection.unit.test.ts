import { describe, expect, it } from 'vitest';

import { releaseTarballName, selectReleasePackages } from './release-package-selection.ts';

const repositoryUrl = 'git+https://github.com/ShravanSunder/agent-vm.git';

describe('npm release package selection', () => {
	it('selects public packages from both scopes and excludes private or unrelated packages', () => {
		const selectedPackages = selectReleasePackages([
			{
				directoryName: 'agent-vm',
				manifest: {
					name: '@agent-vm/agent-vm',
					version: '0.0.153',
					repository: { url: repositoryUrl, directory: 'packages/agent-vm' },
				},
			},
			{
				directoryName: 'tool-access',
				manifest: {
					name: '@agent-collaboration/tool-access',
					version: '0.0.153',
					repository: { url: repositoryUrl, directory: 'packages/tool-access' },
				},
			},
			{ directoryName: 'private-vm', manifest: { name: '@agent-vm/private-vm', private: true } },
			{
				directoryName: 'private-tool',
				manifest: { name: '@agent-collaboration/private-tool', private: true },
			},
			{ directoryName: 'unrelated', manifest: { name: '@another-scope/example' } },
			{ directoryName: 'unnamed', manifest: {} },
		]);

		expect(selectedPackages.map((releasePackage) => releasePackage.name)).toEqual([
			'@agent-vm/agent-vm',
			'@agent-collaboration/tool-access',
		]);
	});

	it('uses pnpm scoped tarball names for both scopes', () => {
		expect(releaseTarballName('@agent-vm/agent-vm', '0.0.153')).toBe(
			'agent-vm-agent-vm-0.0.153.tgz',
		);
		expect(releaseTarballName('@agent-collaboration/tool-access', '0.0.153')).toBe(
			'agent-collaboration-tool-access-0.0.153.tgz',
		);
	});

	it.each([
		undefined,
		'github:ShravanSunder/agent-vm',
		{ directory: 'packages/agent-vm' },
		{ url: 'git+https://github.com/someone/other.git', directory: 'packages/agent-vm' },
		{ url: repositoryUrl },
		{ url: repositoryUrl, directory: 'packages/tool-access' },
	])(
		'rejects incorrect repository metadata before returning any selected packages: %j',
		(repository) => {
			expect(() =>
				selectReleasePackages([
					{
						directoryName: 'managed-vm',
						manifest: {
							name: '@agent-vm/managed-vm',
							version: '0.0.153',
							repository: { url: repositoryUrl, directory: 'packages/managed-vm' },
						},
					},
					{
						directoryName: 'agent-vm',
						manifest: { name: '@agent-vm/agent-vm', version: '0.0.153', repository },
					},
				]),
			).toThrow('@agent-vm/agent-vm: repository');
		},
	);
});
