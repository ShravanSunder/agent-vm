import { describe, expect, test } from 'vitest';

import { compilePolicy } from './policy-compiler.js';

describe('compilePolicy', () => {
	test('normalizes hostnames, drops comments, and preserves stable order', () => {
		expect(
			compilePolicy({
				base: [' api.openai.com ', '# comment', 'API.OpenAI.COM.'],
				profile: ['discord.com', 'gateway.discord.gg'],
				extra: ['gateway.discord.gg', ' web.whatsapp.com. '],
			}),
		).toEqual(['api.openai.com', 'discord.com', 'gateway.discord.gg', 'web.whatsapp.com']);
	});

	test('skips blank values after normalization', () => {
		expect(
			compilePolicy({
				base: ['   ', '..'],
				profile: ['example.com'],
				extra: [''],
			}),
		).toEqual(['example.com']);
	});
});
