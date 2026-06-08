import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
	parseMinimumZigVersion,
	resolveGondolinMinimumZigVersion,
	resolveGondolinPackageSpec,
} from './gondolin-package.js';

describe('parseMinimumZigVersion', () => {
	it('parses a simple version declaration', () => {
		const zon = `.{
    .name = .sandboxd,
    .version = "0.0.0",
    .minimum_zig_version = "0.15.2",
    .paths = .{""},
}`;
		expect(parseMinimumZigVersion(zon)).toBe('0.15.2');
	});

	it('parses pre-release versions', () => {
		const zon = `.{ .minimum_zig_version = "0.16.0-rc.1" }`;
		expect(parseMinimumZigVersion(zon)).toBe('0.16.0-rc.1');
	});

	it('tolerates whitespace variations', () => {
		const zon = `.{
        .minimum_zig_version   =   "0.15.2"
}`;
		expect(parseMinimumZigVersion(zon)).toBe('0.15.2');
	});

	it('throws when the field is absent', () => {
		const zon = `.{ .name = .sandboxd, .version = "0.0.0" }`;
		expect(() => parseMinimumZigVersion(zon)).toThrow(/minimum_zig_version.*not found/u);
	});

	it('throws when the value is empty', () => {
		const zon = `.{ .minimum_zig_version = "" }`;
		expect(() => parseMinimumZigVersion(zon)).toThrow(/minimum_zig_version.*empty/u);
	});

	it('throws on malformed declarations without quotes', () => {
		const zon = `.{ .minimum_zig_version = 0.15.2 }`;
		expect(() => parseMinimumZigVersion(zon)).toThrow(/minimum_zig_version.*not found/u);
	});
});

describe('gondolin package helpers', () => {
	it('reads and parses a synthetic build.zig.zon', async () => {
		const tempDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-zig-'));
		const zonPath = path.join(tempDirectoryPath, 'build.zig.zon');
		await fs.writeFile(
			zonPath,
			`.{
    .minimum_zig_version = "0.15.2",
}`,
			'utf8',
		);

		await expect(resolveGondolinMinimumZigVersion({ buildZigZonPath: zonPath })).resolves.toBe(
			'0.15.2',
		);

		await fs.rm(tempDirectoryPath, { recursive: true, force: true });
	});

	it('throws with the resolved path when the file is missing', async () => {
		const tempDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-zig-'));
		const missingPath = path.join(tempDirectoryPath, 'build.zig.zon');

		await expect(
			resolveGondolinMinimumZigVersion({ buildZigZonPath: missingPath }),
		).rejects.toThrow(new RegExp(`Missing Gondolin build.zig.zon at '${missingPath}'`, 'u'));

		await fs.rm(tempDirectoryPath, { recursive: true, force: true });
	});

	it('throws with the resolved path when the content is malformed', async () => {
		const tempDirectoryPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gondolin-zig-'));
		const zonPath = path.join(tempDirectoryPath, 'build.zig.zon');
		await fs.writeFile(zonPath, `.{ .name = .broken }`, 'utf8');

		await expect(resolveGondolinMinimumZigVersion({ buildZigZonPath: zonPath })).rejects.toThrow(
			new RegExp(`build.zig.zon at '${zonPath}'.*minimum_zig_version.*not found`, 'u'),
		);

		await fs.rm(tempDirectoryPath, { recursive: true, force: true });
	});

	it('resolves the real installed Gondolin package spec and build.zig.zon', async () => {
		await expect(resolveGondolinPackageSpec()).resolves.toMatch(/^@earendil-works\/gondolin@/u);
		await expect(resolveGondolinMinimumZigVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/u);
	});
});
