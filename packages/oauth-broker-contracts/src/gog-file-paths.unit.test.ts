import { describe, expect, it } from 'vitest';

import { normalizeGogFileArgument } from './gog-file-paths.js';

describe('Gog operation-relative file arguments', () => {
	it.each([
		['report.pdf', 'report.pdf'],
		['./report.pdf', 'report.pdf'],
		['./reports/annual report.pdf', 'reports/annual report.pdf'],
		['資料/report.pdf', '資料/report.pdf'],
	])('resolves %s without changing the caller argument', (value, expected) => {
		// Arrange
		const original = value;
		// Act
		const actual = normalizeGogFileArgument(value, 'file');
		// Assert
		expect(actual).toBe(expected);
		expect(value).toBe(original);
	});

	it.each(['.', './', 'reports/', './reports/'])('supports output directory %s', (value) => {
		// Arrange / Act
		const actual = normalizeGogFileArgument(value, 'directory');
		// Assert
		expect(actual).toBe(value.includes('reports') ? 'reports' : '');
	});

	it.each([
		'',
		'/',
		'/tmp/report.pdf',
		'../report.pdf',
		'./a/../report.pdf',
		'a//report.pdf',
		'././report.pdf',
		'~/.config/token',
		'$HOME/report.pdf',
		'a\\report.pdf',
		'report\0.pdf',
		'report\n.pdf',
		'report\u007f.pdf',
		' report.pdf',
		'report.pdf ',
		'-',
		'https://example.test/report.pdf',
		`${'a'.repeat(256)}.pdf`,
		`${'folder/'.repeat(33)}report.pdf`,
	])('rejects unsafe or differently interpreted path %j', (value) => {
		// Arrange / Act / Assert
		expect(normalizeGogFileArgument(value, 'file')).toBeUndefined();
		expect(normalizeGogFileArgument(value, 'directory')).toBeUndefined();
	});

	it.each(['.', './', 'reports/', './reports/'])(
		'rejects directory-only file argument %s',
		(value) => {
			// Arrange / Act / Assert
			expect(normalizeGogFileArgument(value, 'file')).toBeUndefined();
		},
	);
});
