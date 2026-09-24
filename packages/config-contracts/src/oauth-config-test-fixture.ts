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

const syntheticConfig = {
	browser: {
		identity: {
			kind: 'cloudflare-access' as const,
			issuer: 'https://identity.example.test',
			audience: 'synthetic-access-application',
		},
		listener: {
			kind: 'loopback_http' as const,
			port: 18_900,
		},
		publicBaseUrl: 'https://permissions.example.test',
	},
	owners: {
		owner: {
			label: 'Test owner',
			subject: 'user_test_owner',
			allowedAgentIds: ['sun', 'ember'],
		},
	},
	policyEditors: {
		editor: { subject: 'user_test_owner', editableAgentIds: ['sun', 'ember'] },
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
	schemaVersion: 3 as const,
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
