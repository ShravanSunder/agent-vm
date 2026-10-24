import type { PersonProofVerification } from '@agent-collaboration/tool-access/contracts';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import type { AuthTarget } from '#auth/native-owner-cli/auth-target';
import { ownerManagementToken } from '#auth/native-owner-cli/owner-cli-login';

const doubles = vi.hoisted(() => ({
	readFile: vi.fn(),
	verify: vi.fn<(token: string) => Promise<PersonProofVerification>>(),
	browser: vi.fn<(url: string) => Promise<void>>(),
	createServer: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
	readFile: doubles.readFile,
}));
vi.mock('node:http', () => ({ createServer: doubles.createServer }));
vi.mock('@agent-collaboration/tool-access/contracts', async (importOriginal) => ({
	...(await importOriginal<typeof import('@agent-collaboration/tool-access/contracts')>()),
	createPersonTokenVerifier: () => ({ verify: doubles.verify }),
}));
vi.mock('#auth/native-owner-cli/auth-target', async (importOriginal) => ({
	...(await importOriginal<typeof import('#auth/native-owner-cli/auth-target')>()),
	requirePrivateRuntimePath: async (file: string): Promise<string> => file,
}));

const now = 1_800_000_000_000;
const target = {
	issuer: 'https://sign-in.invalid',
	managementAudience: 'https://portal.invalid/management',
	gatewayUrl: 'https://portal.invalid',
	organizationId: '11111111-1111-4111-8111-111111111111',
	ownerCliClientId: 'owner-cli-local',
	ownerCliRedirectUri: 'http://127.0.0.1/callback',
	tokenCachePath: '/private/runtime/owner-token.json',
} satisfies AuthTarget;

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	doubles.readFile.mockResolvedValue(
		JSON.stringify({
			issuer: target.issuer,
			audience: target.managementAudience,
			clientId: target.ownerCliClientId,
			token: 'cached-owner-proof',
			expiresAt: now + 60_000,
		}),
	);
	// The browser throws at authorization entry, so no real listener, timer wait or code exchange is needed.
	doubles.createServer.mockReturnValue({
		on: (): void => {},
		once: (): void => {},
		listen: (_options: unknown, ready: () => void): void => ready(),
		address: () => ({ port: 45678 }),
		closeAllConnections: (): void => {},
		close: (closed: () => void): void => closed(),
	});
	doubles.browser.mockRejectedValue(new Error('authorization reached'));
});
afterEach(() => vi.useRealTimers());

it('fails closed on unavailable verification without opening a browser or loopback listener', async () => {
	doubles.verify.mockResolvedValue({ kind: 'unavailable', reason: 'keys-unreachable' });
	await expect(
		ownerManagementToken({ target, now: () => now, browser: doubles.browser }),
	).rejects.toThrow('Sign-in service unavailable');
	expect(doubles.createServer).not.toHaveBeenCalled();
	expect(doubles.browser).not.toHaveBeenCalled();
});

it('continues to authorization for an invalid cached proof', async () => {
	doubles.verify.mockResolvedValue({ kind: 'refused', reason: 'bad-signature' });
	await expect(
		ownerManagementToken({ target, now: () => now, browser: doubles.browser }),
	).rejects.toThrow('authorization reached');
	expect(doubles.createServer).toHaveBeenCalledOnce();
	expect(doubles.browser).toHaveBeenCalledOnce();
	const url = new URL(doubles.browser.mock.calls[0]?.[0] ?? 'invalid:');
	expect(url.pathname).toBe('/sign-in');
	expect(url.searchParams.has('authorize')).toBe(true);
});
