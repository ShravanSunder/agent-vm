import { describe, expect, test } from 'vitest';

import {
	createCompositeSecretResolver,
	createOpCliSecretResolver,
	createSecretResolver,
	createStaticSecretResolver,
	resolveServiceAccountToken,
	type MediatedSecretSpec,
	type SecretRef,
	type SecretResolver,
} from './index.js';

describe('@agent-vm/secrets package exports', () => {
	test('owns shared secret contracts and resolver factories', () => {
		const secretRef = {
			ref: 'TEST_SECRET',
			source: 'environment',
		} satisfies SecretRef;
		const secretSpec = {
			hosts: ['api.example.com'],
			value: 'secret-value',
		} satisfies MediatedSecretSpec;
		const resolver = {
			resolve: async () => secretSpec.value,
			resolveAll: async () => ({ token: secretSpec.value }),
		} satisfies SecretResolver;

		expect(secretRef.source).toBe('environment');
		expect(secretSpec.hosts).toEqual(['api.example.com']);
		expect(resolver.resolve).toBeTypeOf('function');
		expect(createCompositeSecretResolver).toBeTypeOf('function');
		expect(createSecretResolver).toBeTypeOf('function');
		expect(createOpCliSecretResolver).toBeTypeOf('function');
		expect(createStaticSecretResolver).toBeTypeOf('function');
		expect(resolveServiceAccountToken).toBeTypeOf('function');
	});
});
