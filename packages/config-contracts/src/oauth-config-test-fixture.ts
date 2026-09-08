import type {
	GoogleOAuthApplicationConfig,
	GoogleOAuthApplicationId,
	OAuthConfig,
} from './oauth-config.js';

function createGoogleApplicationConfig(
	applicationId: GoogleOAuthApplicationId,
	catalogFamilyId: 'communications' | 'documents' | 'youtube',
): GoogleOAuthApplicationConfig {
	return {
		catalogFamilyId,
		clientCredentials: {
			ref: `op://agent-vm-testing/${applicationId}/client-json`,
			source: '1password' as const,
		},
		clientKind: 'web' as const,
		description: 'Synthetic OAuth application.',
		label: applicationId,
		projectId: 'synthetic-project',
	};
}

const agent = {
	applications: {
		'gmail-app': {
			ceiling: { kind: 'explicit' as const, groupIds: ['gmail.read', 'gmail.write'] },
		},
	},
};
const syntheticConfig = {
	agents: { sun: structuredClone(agent), ember: structuredClone(agent) },
	browser: {
		identity: {
			kind: 'clerk' as const,
			issuer: 'https://identity.example.test',
			fixedLoginReturnOrigin: 'https://auth.claw.askluna.xyz:18900',
			hostedSignInUrl: 'https://identity.example.test/sign-in',
			publishableKey: `pk_test_${Buffer.from('identity.example.test$').toString('base64')}`,
			secretKey: { ref: 'op://agent-vm-testing/clerk/secret-key', source: '1password' as const },
		},
		listener: {
			certificatePath: '/tmp/oauth-test/tls.crt',
			kind: 'tailscale_https' as const,
			port: 18900 as const,
			privateKeyPath: '/tmp/oauth-test/tls.key',
		},
		network: { admittedTailnetLogins: ['network-person@example.test'] },
		publicBaseUrl: 'https://auth.claw.askluna.xyz:18900',
	},
	owners: {
		owner: {
			label: 'Test owner',
			clerkUserId: 'user_test_owner',
			allowedAgentIds: ['sun', 'ember'],
		},
	},
	policyEditors: {
		editor: { clerkUserId: 'user_test_owner', editableAgentIds: ['sun', 'ember'] },
	},
	providers: {
		google: {
			applications: {
				'gmail-app': createGoogleApplicationConfig('gmail-app', 'communications'),
				'workspace-app': createGoogleApplicationConfig('workspace-app', 'documents'),
				'youtube-app': createGoogleApplicationConfig('youtube-app', 'youtube'),
			},
			catalogVersion: 'google-gog-v0.38.1-v1',
			gogBuildIdentity: { version: '0.38.1', commit: '324f656a4949c3adbf8e1f18066d3965757ed9db' },
			kind: 'google' as const,
			projects: { 'synthetic-project': { publishingStatus: 'testing' as const } },
		},
	},
	schemaVersion: 2 as const,
	storage: {
		keyEncryptionKey: {
			ref: 'op://agent-vm-testing/oauth/wrapping-key',
			source: '1password' as const,
		},
	},
	zoneId: 'test-zone',
} satisfies OAuthConfig;

export function createOAuthConfigTestInput(): typeof syntheticConfig {
	return structuredClone(syntheticConfig);
}
