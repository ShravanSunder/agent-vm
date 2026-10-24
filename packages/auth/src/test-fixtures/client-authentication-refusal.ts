import { expect } from 'vitest';

/** RFC6749 section5.2: failed Authorization-header client authentication challenges without issuing proof. */
export async function expectBasicClientAuthenticationRefusal(response: Response): Promise<void> {
	expect(response.status).toBe(401);
	expect(response.headers.get('www-authenticate')).toBe('Basic');
	const body: unknown = await response.json();
	expect(body).toMatchObject({ error: 'invalid_client' });
	expect(body).not.toHaveProperty('access_token');
	expect(body).not.toHaveProperty('refresh_token');
}
