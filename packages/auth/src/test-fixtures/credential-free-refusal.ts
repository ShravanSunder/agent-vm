import { expect } from 'vitest';
import { z } from 'zod';

/** Refusal bodies cannot release token or client credentials, including nested Gateway result fields. */
export function expectNoIssuedCredentials(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) expectNoIssuedCredentials(item);
		return;
	}
	const object = z.record(z.string(), z.unknown()).safeParse(value);
	if (!object.success) return;
	for (const [key, child] of Object.entries(object.data)) {
		expect(
			[
				'access_token',
				'accessToken',
				'refresh_token',
				'refreshToken',
				'id_token',
				'idToken',
				'client_id',
				'client_secret',
				'clientId',
				'clientSecret',
			].includes(key),
		).toBe(false);
		expectNoIssuedCredentials(child);
	}
}
