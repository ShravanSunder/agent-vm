import { readFile } from 'node:fs/promises';

import * as access from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import * as sdk from './index.js';
import { observeToolPortalSchemas } from './tool-portal-schema-observations.js';

describe('Tool Portal schema ownership', () => {
	it('preserves pre-move d25be046 schema bytes, exports, defaults and rejection details', async () => {
		const oracle: unknown = JSON.parse(
			await readFile(
				new URL('./tool-portal-schema-d25be046.snapshot.json', import.meta.url),
				'utf8',
			),
		);

		const observations = observeToolPortalSchemas();

		expect(observations).toEqual(oracle);
	});

	it('reexports the same lower-layer validators without widening bounded Portal JSON', () => {
		const sharedSchemas = Object.entries(access).filter(
			([name]) => name in sdk && name.endsWith('Schema'),
		);

		for (const [name, schema] of sharedSchemas) {
			expect(Reflect.get(sdk, name), name).toBe(schema);
		}
		expect(sharedSchemas.length).toBeGreaterThan(40);
		expect(access.jsonValueSchema.safeParse('x'.repeat(65_537)).success).toBe(true);
		expect(access.JsonValueSchema.safeParse('x'.repeat(65_537)).success).toBe(false);
	});
});
