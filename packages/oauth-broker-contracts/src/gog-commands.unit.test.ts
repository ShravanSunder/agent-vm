import { describe, expect, it } from 'vitest';

import { createGogOperationResolver } from './gog-commands.js';

const descriptor = {
	operationId: 'gmail.get',
	familyId: 'communications',
	paths: [
		['gmail', 'get'],
		['mail', 'get'],
	],
	requirements: [{ serviceId: 'gmail', effects: ['read'] }],
	sendsMail: false,
	positionals: { minimum: 1, maximum: 1 },
	flags: [
		{
			name: '--format',
			aliases: [],
			kind: 'choice',
			choices: ['full', 'metadata', 'raw'],
			required: false,
		},
		{ name: '--json', aliases: ['-j'], kind: 'switch', required: false },
		{
			name: '--max',
			aliases: ['--limit'],
			kind: 'integer',
			minimum: 1,
			maximum: 100,
			required: false,
		},
	],
} as const;

describe('finite Gog command resolution', () => {
	it('classifies explicit relative outputs and rejects CLI-default destinations', () => {
		// Arrange
		const resolve = createGogOperationResolver([
			{
				...descriptor,
				flags: [
					{
						name: '--out',
						aliases: ['--output'],
						kind: 'file-path',
						direction: 'output',
						pathKind: 'file',
						required: true,
					},
				],
			},
		]);
		const argv = ['gmail', 'get', 'one', '--output=./reports/report.pdf'];
		// Act / Assert
		expect(resolve(argv)).toMatchObject({
			files: { inputs: [], outputs: [{ relativePath: 'reports/report.pdf', kind: 'file' }] },
		});
		for (const output of ['-', '/tmp/file', '../file', '~/.config/file', './folder/']) {
			expect(resolve(['gmail', 'get', 'one', '--out', output])).toEqual({ kind: 'denied' });
		}
		expect(resolve(['gmail', 'get', 'one'])).toEqual({ kind: 'denied' });
		expect(argv.at(-1)).toBe('--output=./reports/report.pdf');
	});

	it('classifies input positions without confusing flag values or later literal arguments', () => {
		// Arrange
		const resolve = createGogOperationResolver([
			{
				...descriptor,
				positionals: { minimum: 1, maximum: 1, fileInputs: [0] },
			},
		]);
		// Act / Assert
		expect(resolve(['gmail', 'get', '--format=metadata', './reports/input.pdf'])).toMatchObject({
			files: { inputs: ['reports/input.pdf'], outputs: [] },
		});
		expect(resolve(['gmail', 'get', '--', './reports/input.pdf'])).toMatchObject({
			files: { inputs: ['reports/input.pdf'], outputs: [] },
		});
		expect(resolve(['gmail', 'get', '/workspace/input.pdf'])).toEqual({ kind: 'denied' });
		expect(resolve(['gmail', 'get', '../input.pdf'])).toEqual({ kind: 'denied' });
	});

	it('resolves the output-directory root without granting an input-directory read', () => {
		// Arrange
		const outputFlag = {
			name: '--out-dir',
			aliases: [],
			kind: 'file-path',
			direction: 'output',
			pathKind: 'directory',
			required: true,
		} as const;
		const resolve = createGogOperationResolver([{ ...descriptor, flags: [outputFlag] }]);
		// Act / Assert
		expect(resolve(['gmail', 'get', 'one', '--out-dir=./'])).toMatchObject({
			files: { inputs: [], outputs: [{ relativePath: '', kind: 'directory' }] },
		});
		expect(() =>
			createGogOperationResolver([
				{ ...descriptor, flags: [{ ...outputFlag, direction: 'input' }] },
			]),
		).toThrow();
		expect(() =>
			createGogOperationResolver([{ ...descriptor, flags: [{ ...outputFlag, required: false }] }]),
		).toThrow();
	});

	it('admits exact paths and returns catalog effects, never rewritten executable arguments', () => {
		// Arrange
		const resolve = createGogOperationResolver([descriptor]);
		const argv = ['mail', 'get', 'message-id', '--format=metadata', '-j'];
		const original = [...argv];
		// Act / Assert
		expect(resolve(argv)).toEqual({
			kind: 'oauth',
			operationId: 'gmail.get',
			familyId: 'communications',
			requirements: descriptor.requirements,
			sendsMail: false,
		});
		expect(argv).toEqual(original);
	});

	it.each(
		[
			[],
			['gmail'],
			['gmail', 'get'],
			['gmail', 'get', 'one', 'two'],
			['gmail', 'send', '--to', 'recipient'],
			['send', '--to', 'recipient'],
			['gmail', 'get', 'one', '--account', 'other'],
			['gmail', 'get', 'one', '--access-token=x'],
			['gmail', 'get', 'one', '-a', 'other'],
			['gmail', 'get', 'one', '--home=/tmp'],
			['gmail', 'get', 'one', '--client', 'other'],
			['gmail', 'get', 'one', '--gmail-no-send=false'],
			['gmail', 'get', 'one', '--readonly=false'],
			['gmail', 'get', 'one', '--verbose'],
			['gmail', 'get', 'one', '--format'],
			['gmail', 'get', 'one', '--format', '--account'],
			['gmail', 'get', 'one', '--format', 'anything'],
			['gmail', 'get', 'one', '--json=false'],
			['gmail', 'get', 'one', '--max', '0'],
			['gmail', 'get', 'one', '--max', '101'],
			['gmail', 'get', 'one', '--max', '1e2'],
			['gmail', 'get', 'one', '--max', '3', '--limit', '4'],
			['gmail', 'get', 'one', '--json', '-j'],
			['api', 'gmail.users.messages.send'],
			['auth', 'add'],
			['config', 'set'],
			['mcp'],
			['batch', 'submit'],
			['gmail', 'get', 'one\0two'],
			['gmail', 'get', 'one', '--format', 'full', '--help'],
		].map((argv) => ({ argv })),
	)('denies unclassified or ambiguous argv %j', ({ argv }) => {
		// Arrange
		const resolve = createGogOperationResolver([descriptor]);
		// Act / Assert
		expect(resolve(argv)).toEqual({ kind: 'denied' });
	});

	it('honors a literal positional separator without interpreting later values as flags', () => {
		// Arrange
		const resolve = createGogOperationResolver([descriptor]);
		// Act / Assert
		expect(resolve(['gmail', 'get', '--', '--account']).kind).toBe('oauth');
	});

	it.each(['--version', 'version', '--help'])(
		'only classifies exact local help/version as credential-free %j',
		(token) => {
			// Arrange / Act / Assert
			expect(createGogOperationResolver([descriptor])([token])).toEqual({ kind: 'no-oauth' });
		},
	);

	it('rejects duplicate or prefix-ambiguous catalog paths before any invocation', () => {
		// Arrange / Act / Assert
		expect(() =>
			createGogOperationResolver([descriptor, { ...descriptor, operationId: 'other' }]),
		).toThrow();
		expect(() =>
			createGogOperationResolver([
				descriptor,
				{ ...descriptor, operationId: 'parent', paths: [['gmail']] },
			]),
		).toThrow();
	});

	it('requires required flag values', () => {
		// Arrange
		const resolve = createGogOperationResolver([
			{ ...descriptor, flags: [{ name: '--subject', aliases: [], kind: 'text', required: true }] },
		]);
		// Act / Assert
		expect(resolve(['gmail', 'get', 'one'])).toEqual({ kind: 'denied' });
		expect(resolve(['gmail', 'get', 'one', '--subject='])).toEqual({ kind: 'denied' });
		expect(resolve(['gmail', 'get', 'one', '--subject=example']).kind).toBe('oauth');
	});

	it('does not expose mutable catalog authority in a returned result', () => {
		// Arrange
		const resolve = createGogOperationResolver([descriptor]);
		const result = resolve(['gmail', 'get', 'one']);
		// Act
		if (result.kind !== 'oauth') throw new Error('Expected classified command');
		Reflect.set(result.requirements[0] ?? {}, 'serviceId', 'other');
		// Assert
		expect(resolve(['gmail', 'get', 'one'])).toMatchObject({
			requirements: descriptor.requirements,
		});
	});
});
