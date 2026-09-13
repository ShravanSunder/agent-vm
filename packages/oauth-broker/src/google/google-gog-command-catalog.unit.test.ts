import { describe, expect, it } from 'vitest';

import {
	getGoogleGogCommandDescriptors,
	resolveGoogleGogOperation,
} from './google-gog-command-catalog.js';

describe('pinned Google Gog command inventory', () => {
	it('classifies a plain Drive upload input without admitting replace or conversion helpers', () => {
		// Arrange / Act
		const result = resolveGoogleGogOperation([
			'drive',
			'upload',
			'./reports/input.pdf',
			'--name',
			'Report',
			'--json',
		]);
		// Assert
		expect(result).toMatchObject({
			kind: 'oauth',
			operationId: 'drive.upload',
			requirements: [{ serviceId: 'drive', effects: ['write'] }],
			files: { inputs: ['reports/input.pdf'], outputs: [] },
		});
		for (const extra of [
			'--replace=other-file',
			'--convert',
			'--convert-to=doc',
			'--mime-type=application/vnd.google-apps.document',
		]) {
			expect(resolveGoogleGogOperation(['drive', 'upload', './input.pdf', extra])).toEqual({
				kind: 'denied',
			});
		}
		for (const input of ['/workspace/input.pdf', '../input.pdf', '-', './']) {
			expect(resolveGoogleGogOperation(['drive', 'upload', input])).toEqual({ kind: 'denied' });
		}
	});
	it.each([
		{ root: 'drive', command: 'download', format: 'pdf' },
		{ root: 'docs', command: 'export', format: 'docx' },
		{ root: 'sheets', command: 'export', format: 'xlsx' },
		{ root: 'slides', command: 'export', format: 'pptx' },
	])(
		'classifies explicit $root file outputs without predicting the exported filename',
		({ root, command, format }) => {
			// Arrange
			const argv = [
				root,
				command,
				'document-id',
				'--out',
				'./reports/result.input',
				'--format',
				format,
				'--json',
			];
			const original = [...argv];
			// Act
			const result = resolveGoogleGogOperation(argv);
			// Assert
			expect(result).toMatchObject({
				kind: 'oauth',
				operationId: `${root}.${command}`,
				requirements: [{ serviceId: root, effects: ['read'] }],
				files: { inputs: [], outputs: [{ relativePath: 'reports/result.input', kind: 'file' }] },
			});
			expect(argv).toEqual(original);
			for (const destination of ['-', '/tmp/result.pdf', '../result.pdf', './', '~/result.pdf']) {
				expect(
					resolveGoogleGogOperation([root, command, 'document-id', '--out', destination]),
				).toEqual({ kind: 'denied' });
			}
			expect(resolveGoogleGogOperation([root, command, 'document-id'])).toEqual({ kind: 'denied' });
			expect(resolveGoogleGogOperation([...argv, '--overwrite'])).toEqual({ kind: 'denied' });
			expect(resolveGoogleGogOperation([...argv, '--tab', 'other-host-export'])).toEqual({
				kind: 'denied',
			});
		},
	);

	it.each([
		{ argv: ['gmail', 'search', 'in:inbox', '--max=5'], service: 'gmail', effects: ['read'] },
		{ argv: ['mail', 'get', 'message'], service: 'gmail', effects: ['read'] },
		{
			argv: ['gmail', 'drafts', 'create', '--subject=test', '--body=hello'],
			service: 'gmail',
			effects: ['read', 'write'],
		},
		{ argv: ['gmail', 'drafts', 'send', 'draft-id'], service: 'gmail', effects: ['write'] },
		{ argv: ['calendar', 'events', 'primary'], service: 'calendar', effects: ['read'] },
		{
			argv: [
				'calendar',
				'create',
				'primary',
				'--summary=test',
				'--from=2026-09-05T10:00:00Z',
				'--to=2026-09-05T11:00:00Z',
			],
			service: 'calendar',
			effects: ['read', 'write'],
		},
		{ argv: ['contacts', 'list'], service: 'contacts', effects: ['read'] },
		{ argv: ['contacts', 'create', '--given=Example'], service: 'contacts', effects: ['write'] },
		{ argv: ['drive', 'ls'], service: 'drive', effects: ['read'] },
		{ argv: ['drive', 'delete', 'file-id'], service: 'drive', effects: ['write'] },
		{ argv: ['docs', 'cat', 'document'], service: 'docs', effects: ['read'] },
		{
			argv: ['docs', 'write', 'document', '--text=hello'],
			service: 'docs',
			effects: ['read', 'write'],
		},
		{ argv: ['sheets', 'get', 'spreadsheet', 'Sheet1!A1'], service: 'sheets', effects: ['read'] },
		{
			argv: ['sheets', 'update', 'spreadsheet', 'Sheet1!A1', 'example'],
			service: 'sheets',
			effects: ['read', 'write'],
		},
		{ argv: ['slides', 'info', 'deck'], service: 'slides', effects: ['read'] },
		{
			argv: ['slides', 'insert-text', 'deck', 'shape', 'text'],
			service: 'slides',
			effects: ['write'],
		},
		{ argv: ['forms', 'get', 'form'], service: 'forms', effects: ['read'] },
		{ argv: ['forms', 'create', '--title=Example'], service: 'forms', effects: ['write'] },
		{ argv: ['forms', 'responses', 'list', 'form'], service: 'forms', effects: ['read'] },
		{ argv: ['youtube', 'channels', 'list', '--mine'], service: 'youtube', effects: ['read'] },
		{
			argv: ['youtube', 'playlists', 'create', '--title=Example'],
			service: 'youtube',
			effects: ['write'],
		},
	])('classifies qualified argv $argv', ({ argv, service, effects }) => {
		// Arrange / Act
		const result = resolveGoogleGogOperation(argv);
		// Assert
		expect(result).toMatchObject({
			kind: 'oauth',
			requirements: [{ serviceId: service, effects }],
		});
	});

	it.each(
		[
			['gmail', 'search', 'query', '--from-contact=someone'],
			['gmail', 'send', '--to=person@example.test', '--subject=test', '--body=hi', '--track'],
			['drive', 'delete', 'file', '--permanent'],
			['docs', 'write', 'document', '--text=hi', '--batch=existing-batch'],
			['calendar', 'create', 'primary', '--with-zoom'],
			['youtube', 'comments', 'delete', 'comment'],
			['api', 'gmail.users.messages.send'],
			['gmail', 'settings', 'delegates', 'create'],
		].map((argv) => ({ argv })),
	)('denies unqualified side effects $argv', ({ argv }) => {
		// Arrange / Act / Assert
		expect(resolveGoogleGogOperation(argv)).toEqual({ kind: 'denied' });
	});

	it('marks admitted send paths independently of their read/write policy', () => {
		// Arrange / Act / Assert
		expect(resolveGoogleGogOperation(['gmail', 'drafts', 'send', 'draft'])).toMatchObject({
			sendsMail: true,
		});
		expect(
			resolveGoogleGogOperation(['gmail', 'drafts', 'create', '--subject=test', '--body=hi']),
		).toMatchObject({ sendsMail: false });
	});

	it('provides only exact leaf paths for the compiler, not a blanket Gmail namespace', () => {
		// Arrange / Act
		const descriptors = getGoogleGogCommandDescriptors();
		// Assert
		expect(descriptors.length).toBeGreaterThan(20);
		expect(
			descriptors.every((descriptor) => descriptor.paths.every((path) => path.length >= 2)),
		).toBe(true);
	});
});
