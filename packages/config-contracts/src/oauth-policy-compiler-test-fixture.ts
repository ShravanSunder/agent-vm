import { createOAuthConfigTestInput } from './oauth-config-test-fixture.js';

const oauthConfig = createOAuthConfigTestInput();
const mandatoryArgvPrefix: string[] = [];
const googleOperation = {
	kind: 'configured_cli',
	authorization: { kind: 'oauth_account' },
	executablePath: '/usr/local/bin/gog',
	mandatoryArgvPrefix,
	safeHelp: 'Read Gmail.',
	commands: [{ path: ['gmail', 'search'], flagRules: [] }],
	calls: { source: 'managed_google_policy', deny: [] },
	stdin: { kind: 'none' },
	timeout: { kind: 'quick' },
	output: {
		modelVisibleStderr: 'fixed_safe_summary',
		overflow: 'truncate',
		stdoutMaxBytes: 4096,
		stderrMaxBytes: 1024,
	},
	executionTarget: {
		kind: 'ephemeral_managed_vm',
		imageReference: 'vm-images/google',
		guestCwd: '/work',
		environment: { kind: 'empty' },
		allowedHosts: ['gmail.googleapis.com'],
		credentialProjection: {
			kind: 'http_mediation',
			environment: { GOG_ACCESS_TOKEN: { kind: 'oauth_access_token' } },
		},
	},
};
const lifecycle = ['list', 'begin', 'status', 'cancel', 'reauthorize', 'disconnect'];
const toolPortalConfig = {
	schemaVersion: 1,
	mode: 'managed',
	agents: {
		sun: {
			profile: 'shared',
			googlePolicyDefaults: {
				kind: 'collection',
				collectionId: 'read-only-assistant',
				version: '1',
			},
		},
		ember: {
			profile: 'shared',
			googlePolicyDefaults: {
				kind: 'explicit',
				applications: { 'gmail-app': { gmail: { read: 'ask', write: 'deny' } } },
			},
		},
	},
	profiles: {
		shared: {
			namespaces: {
				google: {
					tools: { allow: '*' },
					calls: { source: 'managed_google_policy' },
					backend: { kind: 'controller_execution', operations: { gog: googleOperation } },
				},
				oauth_authorization: {
					tools: { allow: lifecycle },
					calls: { requiresApproval: { allow: [] }, withoutApproval: { allow: lifecycle } },
					backend: {
						kind: 'controller_execution',
						operations: Object.fromEntries(
							lifecycle.map((name) => [name, { kind: 'registered_action' }]),
						),
					},
				},
			},
		},
	},
};
const catalog = {
	catalogVersion: oauthConfig.providers.google.catalogVersion,
	gogBuildIdentity: oauthConfig.providers.google.gogBuildIdentity,
	families: {
		communications: { allowedHosts: ['gmail.googleapis.com'] },
		documents: { allowedHosts: ['www.googleapis.com'] },
		youtube: { allowedHosts: ['youtube.googleapis.com'] },
	},
	groups: [
		{
			groupId: 'gmail.read',
			familyId: 'communications',
			serviceId: 'gmail',
			effect: 'read',
			label: 'Read Gmail',
			warning: 'Read messages.',
			scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
			operationIds: ['gmail.search', 'gmail.send'],
		},
		{
			groupId: 'gmail.write',
			familyId: 'communications',
			serviceId: 'gmail',
			effect: 'write',
			label: 'Write Gmail',
			warning: 'Includes sending and read authority.',
			scopes: ['https://www.googleapis.com/auth/gmail.modify'],
			operationIds: ['gmail.send'],
		},
	],
	operations: [
		{
			operationId: 'gmail.search',
			familyId: 'communications',
			paths: [
				['gmail', 'search'],
				['mail', 'search'],
			],
			requirements: [{ serviceId: 'gmail', effects: ['read'] }],
			sendsMail: false,
			positionals: { minimum: 1, maximum: 64 },
			flags: [],
		},
		{
			operationId: 'gmail.send',
			familyId: 'communications',
			paths: [['gmail', 'send']],
			requirements: [{ serviceId: 'gmail', effects: ['read', 'write'] }],
			sendsMail: true,
			positionals: { minimum: 0, maximum: 0 },
			flags: [],
		},
	],
	ceilingPresets: {
		'all-supported': {
			communications: ['gmail.read', 'gmail.write'],
			documents: [],
			youtube: [],
		},
	},
	collections: {
		'read-only-assistant': {
			version: '1',
			label: 'Read-only assistant',
			summary: 'Read only.',
			rationale: 'Start narrow.',
			selections: { communications: ['gmail.read'], documents: [], youtube: [] },
			defaults: {
				communications: { gmail: { read: 'allow', write: 'deny' } },
				documents: {},
				youtube: {},
			},
		},
	},
};

const fixtureInput = { oauthConfig, toolPortalConfig, catalog };
export function createOAuthPolicyCompilerTestInput(): typeof fixtureInput {
	return structuredClone(fixtureInput);
}
