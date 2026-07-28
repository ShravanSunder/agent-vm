import { readdir, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	assertPortableContractSchemaIsExportable,
	createPortableContractSchemaManifest,
	encodeCanonicalJson,
	PORTABLE_CONTRACT_ADAPTERS,
	PORTABLE_REFINEMENT_IDENTITIES,
} from './portable-contracts/portable-contract-runtime.js';

const AcceptedFixtureExpectationSchema = z
	.object({
		canonicalJson: z.string(),
		kind: z.literal('accepted'),
		normalized: z.unknown(),
		refinementIdentities: z.array(z.string()),
	})
	.strict();

const RejectedFixtureExpectationSchema = z
	.object({
		errorCodes: z.array(z.string()).min(1),
		kind: z.literal('rejected'),
		refinementIdentities: z.array(z.string()),
	})
	.strict();

const PortableContractFixtureSchema = z
	.object({
		caseId: z.string().min(1),
		expectation: z.discriminatedUnion('kind', [
			AcceptedFixtureExpectationSchema,
			RejectedFixtureExpectationSchema,
		]),
		input: z.unknown(),
		schemaId: z.string().min(1),
		tags: z.array(z.string().min(1)),
	})
	.strict();

type PortableContractFixture = z.infer<typeof PortableContractFixtureSchema>;

const portableFixtureDirectoryUrl = new URL(
	'../contract-fixtures/portable-contracts/',
	import.meta.url,
);

async function listPortableFixtureUrls(directoryUrl: URL): Promise<readonly URL[]> {
	const directoryEntries = await readdir(directoryUrl, { withFileTypes: true });
	const nestedFixtureUrls = await Promise.all(
		directoryEntries.map(async (directoryEntry): Promise<readonly URL[]> => {
			const entryUrl = new URL(directoryEntry.name, directoryUrl);
			if (directoryEntry.isDirectory()) {
				return await listPortableFixtureUrls(new URL(`${entryUrl.href}/`));
			}
			return directoryEntry.isFile() && directoryEntry.name.endsWith('.fixture.json')
				? [entryUrl]
				: [];
		}),
	);
	return nestedFixtureUrls.flat().toSorted((left, right) => left.href.localeCompare(right.href));
}

async function loadPortableContractFixtures(): Promise<readonly PortableContractFixture[]> {
	const fixtureUrls = await listPortableFixtureUrls(portableFixtureDirectoryUrl);
	return await Promise.all(
		fixtureUrls.map(async (fixtureUrl): Promise<PortableContractFixture> => {
			const fixtureInput: unknown = JSON.parse(await readFile(fixtureUrl, 'utf8'));
			return PortableContractFixtureSchema.parse(fixtureInput);
		}),
	);
}

const portableContractFixtures = await loadPortableContractFixtures();

describe('portable contract fixture corpus', () => {
	it('uses unique case ids and only registered schema ids', () => {
		// Arrange
		const caseIds = portableContractFixtures.map((fixture) => fixture.caseId);
		const schemaIds = new Set(Object.keys(PORTABLE_CONTRACT_ADAPTERS));

		// Act
		const uniqueCaseIds = new Set(caseIds);
		const missingSchemaIds = portableContractFixtures
			.filter((fixture) => !schemaIds.has(fixture.schemaId))
			.map((fixture) => fixture.schemaId);

		// Assert
		expect(uniqueCaseIds.size).toBe(caseIds.length);
		expect(missingSchemaIds).toEqual([]);
	});

	it('covers every generated schema with an accepted shared fixture', () => {
		// Arrange
		const acceptedFixtureSchemaIds = new Set(
			portableContractFixtures
				.filter((fixture) => fixture.expectation.kind === 'accepted')
				.map((fixture) => fixture.schemaId),
		);
		const manifestSchemas = createPortableContractSchemaManifest()['schemas'];
		if (
			typeof manifestSchemas !== 'object' ||
			manifestSchemas === null ||
			Array.isArray(manifestSchemas)
		) {
			throw new Error('Portable contract manifest schemas must be an object.');
		}
		const manifestSchemaIds = Object.keys(manifestSchemas).toSorted();
		const adapterSchemaIds = Object.keys(PORTABLE_CONTRACT_ADAPTERS).toSorted();

		// Act
		const missingAcceptedManifestSchemaIds = manifestSchemaIds.filter(
			(schemaId) => !acceptedFixtureSchemaIds.has(schemaId),
		);
		const missingAcceptedAdapterSchemaIds = adapterSchemaIds.filter(
			(schemaId) => !acceptedFixtureSchemaIds.has(schemaId),
		);

		// Assert
		expect(adapterSchemaIds).toEqual(manifestSchemaIds);
		expect(missingAcceptedManifestSchemaIds).toEqual([]);
		expect(missingAcceptedAdapterSchemaIds).toEqual([]);
	});

	it.each(portableContractFixtures)('$caseId', (fixture) => {
		// Arrange
		const adapter = PORTABLE_CONTRACT_ADAPTERS[fixture.schemaId];
		if (adapter === undefined) {
			throw new Error(`Portable contract adapter is missing for ${fixture.schemaId}.`);
		}

		// Act
		const result = adapter.parse(fixture.input);

		// Assert
		if (fixture.expectation.kind === 'accepted') {
			expect(result).toEqual({
				kind: 'accepted',
				normalized: fixture.expectation.normalized,
				refinementIdentities: fixture.expectation.refinementIdentities,
			});
			if (result.kind !== 'accepted') {
				throw new Error(`Expected ${fixture.caseId} to be accepted.`);
			}
			expect(encodeCanonicalJson(result.normalized)).toBe(fixture.expectation.canonicalJson);
			return;
		}

		expect(result).toEqual({
			errorCodes: fixture.expectation.errorCodes,
			kind: 'rejected',
			refinementIdentities: fixture.expectation.refinementIdentities,
		});
	});

	it('publishes every named fixture refinement identity', () => {
		// Arrange
		const fixtureRefinementIdentities = new Set(
			portableContractFixtures.flatMap((fixture) => fixture.expectation.refinementIdentities),
		);

		// Act
		const missingRefinementIdentities = [...fixtureRefinementIdentities].filter(
			(refinementIdentity) => !PORTABLE_REFINEMENT_IDENTITIES.includes(refinementIdentity),
		);

		// Assert
		expect(missingRefinementIdentities).toEqual([]);
	});
});

describe('portable contract authoring guard', () => {
	it.each([
		{
			label: 'anonymous refine',
			schema: z.string().refine((value) => value.length > 0),
			schemaId: 'test.anonymous-refine',
		},
		{
			label: 'anonymous superRefine',
			schema: z.object({ value: z.string() }).superRefine((value, context) => {
				if (value.value.length === 0) {
					context.addIssue({ code: 'custom', message: 'Value is required.' });
				}
			}),
			schemaId: 'test.anonymous-super-refine',
		},
		{
			label: 'anonymous transform',
			schema: z.string().transform((value) => value.trim()),
			schemaId: 'test.anonymous-transform',
		},
	])('rejects $label', ({ schema, schemaId }) => {
		// Arrange
		const inspectSchema = (): void => {
			assertPortableContractSchemaIsExportable({ schema, schemaId });
		};

		// Act / Assert
		expect(inspectSchema).toThrowError(/anonymous|unregistered/iu);
	});
});
