import {
	createGogOperationResolver,
	type GogCommandDescriptorInput,
	type GogOperationResolution,
	type GoogleCatalogFamilyId,
	type GoogleOperationEffect,
} from '@agent-vm/oauth-broker-contracts';

type CommandFlag = GogCommandDescriptorInput['flags'][number];

function textFlag(name: string, required = false): CommandFlag {
	return { name: `--${name}`, aliases: [], kind: 'text', required };
}
function switchFlag(name: string): CommandFlag {
	return { name: `--${name}`, aliases: [], kind: 'switch', required: false };
}
function choiceFlag(name: string, choices: readonly string[]): CommandFlag {
	return { name: `--${name}`, aliases: [], kind: 'choice', choices, required: false };
}
function outputFileFlag(): CommandFlag {
	return {
		name: '--out',
		aliases: [],
		kind: 'file-path',
		direction: 'output',
		pathKind: 'file',
		required: true,
	};
}
function resultLimit(maximum = 500, aliases: readonly string[] = ['--limit']): CommandFlag {
	return { name: '--max', aliases, kind: 'integer', minimum: 1, maximum, required: false };
}

const rootAliases: Readonly<Record<string, readonly string[]>> = {
	gmail: ['gmail', 'mail', 'email'],
	calendar: ['calendar', 'cal'],
	contacts: ['contacts', 'contact'],
	drive: ['drive', 'drv'],
	docs: ['docs', 'doc'],
	sheets: ['sheets', 'sheet'],
	slides: ['slides', 'slide'],
	forms: ['forms', 'form'],
	youtube: ['youtube', 'yt'],
};

function operation(props: {
	readonly path: readonly string[];
	readonly familyId: GoogleCatalogFamilyId;
	readonly serviceId: string;
	readonly effects: readonly GoogleOperationEffect[];
	readonly minimum: number;
	readonly maximum: number;
	readonly flags?: readonly CommandFlag[];
	readonly fileInputs?: readonly number[];
	readonly sendsMail?: boolean;
}): GogCommandDescriptorInput {
	const root = props.path[0];
	if (root === undefined || !Object.hasOwn(rootAliases, root))
		throw new Error('Unknown Gog service root.');
	return {
		operationId: props.path.join('.'),
		familyId: props.familyId,
		paths: (rootAliases[root] ?? []).map((alias) => [alias].concat(props.path.slice(1))),
		requirements: [{ serviceId: props.serviceId, effects: props.effects }],
		positionals: {
			minimum: props.minimum,
			maximum: props.maximum,
			...(props.fileInputs === undefined ? {} : { fileInputs: props.fileInputs }),
		},
		sendsMail: props.sendsMail ?? false,
		flags: [
			{ name: '--json', aliases: ['-j'], kind: 'switch', required: false },
			...(props.flags ?? []),
		],
	};
}

// Audited Go structs and Run methods at gogcli v0.38.1, commit
// 324f656a4949c3adbf8e1f18066d3965757ed9db, internal/cmd/{gmail*,calendar*,
// contacts*,drive*,docs*,sheets*,slides*,forms*,youtube*}. Unsupported flag
// combinations and helpers remain unadvertised and denied, not prefix-admitted.
const descriptors: readonly GogCommandDescriptorInput[] = [
	// Plain Files.Create upload at the pinned drive_upload.go. Replacement,
	// conversion and MIME overrides have separate effects and are not admitted.
	operation({
		path: ['drive', 'upload'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['write'],
		minimum: 1,
		maximum: 1,
		fileInputs: [0],
		flags: [textFlag('name'), textFlag('parent')],
	}),
	// Pinned drive_download.go and export_via_drive.go write a file and return
	// its actual path/size. No stdout payload, implicit destination, overwrite
	// or experimental --tab export (a separate host/authority path) is admitted.
	operation({
		path: ['drive', 'download'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [
			outputFileFlag(),
			choiceFlag('format', ['pdf', 'csv', 'xlsx', 'pptx', 'txt', 'png', 'docx', 'md', 'html']),
		],
	}),
	operation({
		path: ['docs', 'export'],
		familyId: 'documents',
		serviceId: 'docs',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [outputFileFlag(), choiceFlag('format', ['pdf', 'docx', 'txt', 'md', 'html'])],
	}),
	operation({
		path: ['sheets', 'export'],
		familyId: 'documents',
		serviceId: 'sheets',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [outputFileFlag(), choiceFlag('format', ['pdf', 'xlsx', 'csv'])],
	}),
	operation({
		path: ['slides', 'export'],
		familyId: 'documents',
		serviceId: 'slides',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [outputFileFlag(), choiceFlag('format', ['pdf', 'pptx'])],
	}),
	operation({
		path: ['gmail', 'search'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read'],
		minimum: 1,
		maximum: 64,
		flags: [resultLimit(), textFlag('page'), switchFlag('all'), switchFlag('oldest')],
	}),
	operation({
		path: ['gmail', 'get'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [
			choiceFlag('format', ['full', 'metadata', 'raw']),
			textFlag('headers'),
			switchFlag('sanitize-content'),
		],
	}),
	operation({
		path: ['gmail', 'drafts', 'list'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read'],
		minimum: 0,
		maximum: 0,
		flags: [resultLimit(), textFlag('page')],
	}),
	operation({
		path: ['gmail', 'drafts', 'get'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
	}),
	// Compose reads send-as settings; do not bypass a denied helper Read.
	operation({
		path: ['gmail', 'drafts', 'create'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read', 'write'],
		minimum: 0,
		maximum: 0,
		flags: [
			textFlag('subject', true),
			textFlag('body', true),
			textFlag('to'),
			textFlag('cc'),
			textFlag('bcc'),
		],
	}),
	operation({
		path: ['gmail', 'drafts', 'send'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['write'],
		minimum: 1,
		maximum: 1,
		sendsMail: true,
	}),
	operation({
		path: ['gmail', 'drafts', 'delete'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['write'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['gmail', 'send'],
		familyId: 'communications',
		serviceId: 'gmail',
		effects: ['read', 'write'],
		minimum: 0,
		maximum: 0,
		sendsMail: true,
		flags: [
			textFlag('to', true),
			textFlag('subject', true),
			textFlag('body', true),
			textFlag('cc'),
			textFlag('bcc'),
		],
	}),
	operation({
		path: ['calendar', 'events'],
		familyId: 'communications',
		serviceId: 'calendar',
		effects: ['read'],
		minimum: 0,
		maximum: 1,
		flags: [
			resultLimit(),
			textFlag('page'),
			textFlag('from'),
			textFlag('to'),
			textFlag('query'),
			switchFlag('today'),
			switchFlag('week'),
		],
	}),
	operation({
		path: ['calendar', 'create'],
		familyId: 'communications',
		serviceId: 'calendar',
		effects: ['read', 'write'],
		minimum: 1,
		maximum: 1,
		flags: [
			textFlag('summary', true),
			textFlag('from', true),
			textFlag('to', true),
			textFlag('description'),
			textFlag('location'),
			textFlag('attendees'),
			switchFlag('all-day'),
			choiceFlag('send-updates', ['all', 'externalOnly', 'none']),
		],
	}),
	operation({
		path: ['calendar', 'delete'],
		familyId: 'communications',
		serviceId: 'calendar',
		effects: ['read', 'write'],
		minimum: 2,
		maximum: 2,
	}),
	operation({
		path: ['contacts', 'list'],
		familyId: 'communications',
		serviceId: 'contacts',
		effects: ['read'],
		minimum: 0,
		maximum: 0,
		flags: [resultLimit(), textFlag('page')],
	}),
	operation({
		path: ['contacts', 'search'],
		familyId: 'communications',
		serviceId: 'contacts',
		effects: ['read'],
		minimum: 1,
		maximum: 64,
		flags: [resultLimit()],
	}),
	operation({
		path: ['contacts', 'create'],
		familyId: 'communications',
		serviceId: 'contacts',
		effects: ['write'],
		minimum: 0,
		maximum: 0,
		flags: [
			textFlag('given', true),
			textFlag('family'),
			textFlag('email'),
			textFlag('phone'),
			textFlag('org'),
		],
	}),
	operation({
		path: ['contacts', 'delete'],
		familyId: 'communications',
		serviceId: 'contacts',
		effects: ['write'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['drive', 'ls'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['read'],
		minimum: 0,
		maximum: 0,
		flags: [
			resultLimit(),
			textFlag('page'),
			textFlag('query'),
			textFlag('parent'),
			switchFlag('all'),
		],
	}),
	operation({
		path: ['drive', 'get'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [textFlag('fields')],
	}),
	operation({
		path: ['drive', 'search'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['read'],
		minimum: 1,
		maximum: 64,
		flags: [resultLimit(), textFlag('page'), textFlag('parent'), switchFlag('raw-query')],
	}),
	// The permanent-delete flag is deliberately absent. This exact shape trashes.
	operation({
		path: ['drive', 'delete'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['write'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['drive', 'move'],
		familyId: 'documents',
		serviceId: 'drive',
		effects: ['read', 'write'],
		minimum: 1,
		maximum: 1,
		flags: [textFlag('parent', true)],
	}),
	operation({
		path: ['docs', 'info'],
		familyId: 'documents',
		serviceId: 'docs',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['docs', 'cat'],
		familyId: 'documents',
		serviceId: 'docs',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [textFlag('tab'), switchFlag('all-tabs'), switchFlag('chips')],
	}),
	operation({
		path: ['docs', 'write'],
		familyId: 'documents',
		serviceId: 'docs',
		effects: ['read', 'write'],
		minimum: 1,
		maximum: 1,
		flags: [textFlag('text', true), switchFlag('append'), switchFlag('replace'), textFlag('tab')],
	}),
	operation({
		path: ['sheets', 'get'],
		familyId: 'documents',
		serviceId: 'sheets',
		effects: ['read'],
		minimum: 2,
		maximum: 2,
		flags: [
			choiceFlag('dimension', ['ROWS', 'COLUMNS']),
			choiceFlag('render', ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA']),
		],
	}),
	operation({
		path: ['sheets', 'update'],
		familyId: 'documents',
		serviceId: 'sheets',
		effects: ['read', 'write'],
		minimum: 3,
		maximum: 128,
		flags: [choiceFlag('input', ['RAW', 'USER_ENTERED'])],
	}),
	operation({
		path: ['slides', 'info'],
		familyId: 'documents',
		serviceId: 'slides',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['slides', 'insert-text'],
		familyId: 'documents',
		serviceId: 'slides',
		effects: ['write'],
		minimum: 3,
		maximum: 3,
		flags: [switchFlag('replace')],
	}),
	operation({
		path: ['forms', 'get'],
		familyId: 'documents',
		serviceId: 'forms',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
	}),
	operation({
		path: ['forms', 'create'],
		familyId: 'documents',
		serviceId: 'forms',
		effects: ['write'],
		minimum: 0,
		maximum: 0,
		flags: [textFlag('title', true), textFlag('description')],
	}),
	operation({
		path: ['forms', 'responses', 'list'],
		familyId: 'documents',
		serviceId: 'forms',
		effects: ['read'],
		minimum: 1,
		maximum: 1,
		flags: [resultLimit(500, []), textFlag('page'), textFlag('filter')],
	}),
	operation({
		path: ['youtube', 'channels', 'list'],
		familyId: 'youtube',
		serviceId: 'youtube',
		effects: ['read'],
		minimum: 0,
		maximum: 0,
		flags: [{ ...switchFlag('mine'), required: true }, resultLimit(50), textFlag('page')],
	}),
	operation({
		path: ['youtube', 'playlists', 'create'],
		familyId: 'youtube',
		serviceId: 'youtube',
		effects: ['write'],
		minimum: 0,
		maximum: 0,
		flags: [
			textFlag('title', true),
			textFlag('description'),
			choiceFlag('privacy', ['public', 'unlisted', 'private']),
		],
	}),
];

const resolveOperation = createGogOperationResolver(descriptors);
export function getGoogleGogCommandDescriptors(): readonly GogCommandDescriptorInput[] {
	return structuredClone(descriptors);
}
export function resolveGoogleGogOperation(argv: readonly string[]): GogOperationResolution {
	return resolveOperation(argv);
}
