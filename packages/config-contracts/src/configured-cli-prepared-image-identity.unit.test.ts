import { describe, expect, it } from 'vitest';

import {
	CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX,
	decodeConfiguredCliPreparedImageIdentity,
	encodeConfiguredCliPreparedImageIdentity,
} from './controller-configured-cli.js';

describe('configured CLI prepared image identity', () => {
	it('round trips the strict provider-local reference and fingerprint', () => {
		const identity = encodeConfiguredCliPreparedImageIdentity({
			fingerprint: 'sha256:prepared-image',
			imageReference: '/cache/images/prepared-image',
			schemaVersion: 1,
		});

		expect(identity).toMatch(/^agent-vm-prepared-image:v1:[A-Za-z0-9_-]+$/u);
		expect(decodeConfiguredCliPreparedImageIdentity(identity)).toEqual({
			fingerprint: 'sha256:prepared-image',
			imageReference: '/cache/images/prepared-image',
			schemaVersion: 1,
		});
	});

	it.each([
		['authored recipe path', '/images/runner/build-config.json'],
		['empty payload', CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX],
		['non-base64url payload', `${CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX}not+base64`],
		[
			'unknown schema version',
			`${CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX}${Buffer.from(
				JSON.stringify({ fingerprint: 'fingerprint', imageReference: '/image', schemaVersion: 2 }),
			).toString('base64url')}`,
		],
		[
			'extra field',
			`${CONFIGURED_CLI_PREPARED_IMAGE_IDENTITY_PREFIX}${Buffer.from(
				JSON.stringify({
					extra: true,
					fingerprint: 'fingerprint',
					imageReference: '/image',
					schemaVersion: 1,
				}),
			).toString('base64url')}`,
		],
	] as const)('rejects %s', (_label, identity) => {
		expect(() => decodeConfiguredCliPreparedImageIdentity(identity)).toThrow();
	});
});
