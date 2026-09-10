import { compileOAuthPolicy, configuredGoogleOperationKey } from '@agent-vm/config-contracts';
import {
	managedGoogleReadyPreflightSchema,
	type GogFileInputSnapshot,
	type ManagedGoogleReadyPreflight,
} from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import { resolveManagedGoogleFilePreflight } from './managed-google-file-preflight.js';

type PreflightProps = Parameters<typeof resolveManagedGoogleFilePreflight>[0];
function arrange(): {
	readonly compiled: PreflightProps['compiled'];
	readonly request: PreflightProps['request'];
	readonly current: ManagedGoogleReadyPreflight;
	readonly fileInputs: GogFileInputSnapshot;
	readonly readFileInputs: ReturnType<typeof vi.fn<PreflightProps['readFileInputs']>>;
	readonly resolvePolicy: ReturnType<typeof vi.fn<PreflightProps['resolvePolicy']>>;
} {
	const input = createOAuthPolicyCompilerTestInput();
	const descriptor = input.catalog.operations[0];
	if (descriptor === undefined) throw new Error('Missing descriptor.');
	const compiled = compileOAuthPolicy({
		...input,
		catalog: {
			...input.catalog,
			operations: [
				{ ...descriptor, positionals: { minimum: 1, maximum: 1, fileInputs: [0] } },
				...input.catalog.operations.slice(1),
			],
		},
	});
	const commandSet =
		compiled.commandSetsByConfiguredOperation[
			configuredGoogleOperationKey('shared', 'google', 'gog')
		];
	if (commandSet === undefined) throw new Error('Missing command set.');
	const current = managedGoogleReadyPreflightSchema.parse({
		kind: 'ready',
		disposition: 'ask',
		binding: {
			accountId: '33333333-3333-4333-8333-333333333333',
			authorizationId: '44444444-4444-4444-8444-444444444444',
			applicationId: 'gmail-app',
			generation: 1,
			authorizationMetadataRevision: 1,
			overrideRevision: 1,
			defaultsRevision: 'a'.repeat(64),
			configRevision: 'config',
			clientBindingRevision: 'client',
			catalogVersion: 'catalog',
			commandTableRevision: commandSet.revision,
			operationId: 'gmail.search',
			gmailWriteAllowed: false,
		},
		display: {
			accountId: '33333333-3333-4333-8333-333333333333',
			authorizationId: '44444444-4444-4444-8444-444444444444',
			accountAlias: 'Test',
			applicationLabel: 'Gmail',
			authorizationMetadataRevision: 1,
		},
	});
	const fileInputs = {
		leaseId: 'lease',
		leafGeneration: 'leaf',
		vmId: 'vm',
		files: [{ relativePath: 'input.pdf', byteLength: 4, sha256: 'a'.repeat(64) }],
	};
	const readFileInputs = vi.fn(async () => fileInputs);
	const resolvePolicy = vi.fn(() => current);
	return {
		compiled,
		current,
		fileInputs,
		readFileInputs,
		resolvePolicy,
		request: {
			agentId: 'sun',
			profileId: 'shared',
			namespaceId: 'google',
			operationName: 'gog',
			input: {
				accountId: current.binding.accountId,
				argv: ['gmail', 'search', './input.pdf'],
				reason: 'Read input',
			},
		},
	};
}

describe('managed Google file preflight', () => {
	it('adds only descriptor-selected, normalized input identities to the existing preflight', async () => {
		// Arrange
		const fixture = arrange();
		// Act
		const result = await resolveManagedGoogleFilePreflight(fixture);
		// Assert
		expect(result).toEqual({ ...fixture.current, fileInputs: fixture.fileInputs });
		expect(fixture.readFileInputs).toHaveBeenCalledExactlyOnceWith(['input.pdf']);
	});
	it('rechecks policy after asynchronous hashing before returning authority', async () => {
		// Arrange
		const fixture = arrange();
		fixture.readFileInputs.mockImplementation(async () => {
			fixture.current.binding.overrideRevision += 1;
			return fixture.fileInputs;
		});
		// Act / Assert
		expect(await resolveManagedGoogleFilePreflight(fixture)).toEqual({ kind: 'unavailable' });
	});
	it('fails closed when source identity does not match selected paths', async () => {
		// Arrange
		const fixture = arrange();
		const file = fixture.fileInputs.files[0];
		if (file === undefined) throw new Error('Expected input file.');
		fixture.readFileInputs.mockResolvedValue({
			...fixture.fileInputs,
			files: [{ ...file, relativePath: 'other.pdf' }],
		});
		// Act / Assert
		expect(await resolveManagedGoogleFilePreflight(fixture)).toEqual({ kind: 'unavailable' });
	});
});
