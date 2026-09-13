import { z } from 'zod';

import {
	BoundedOpaqueIdentifierSchema,
	CanonicalBase64Schema,
	NonnegativeSafeIntegerSchema,
	PositiveSafeIntegerSchema,
	SandboxWorkRelativePathSchema,
	Sha256DigestSchema,
} from '../../contracts/contract-foundations.js';
import { SafeDiagnosticSchema } from '../../portal-event-surface/models/safe-diagnostic-schema.js';

export const PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES = 16 * 1_024 * 1_024;
export const PORTAL_CATALOG_MAXIMUM_FILES = 256;
export const PORTAL_CATALOG_MAXIMUM_FILE_BYTES = 1 * 1_024 * 1_024;
export const PORTAL_CATALOG_MAXIMUM_READ_BYTES = 64 * 1_024;
export const PORTAL_CATALOG_MAXIMUM_MANIFEST_BYTES = 1 * 1_024 * 1_024;

export const PortalCatalogDefinitionFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const PortalCatalogSourceFileSchema = z
	.object({
		byteLength: NonnegativeSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_FILE_BYTES),
		namespace: BoundedOpaqueIdentifierSchema,
		path: SandboxWorkRelativePathSchema,
		sha256: z.string().regex(/^[a-f0-9]{64}$/u),
	})
	.strict();

export const PortalCatalogSourceNamespaceSchema = z
	.object({
		exportedFactoryName: BoundedOpaqueIdentifierSchema,
		modulePath: SandboxWorkRelativePathSchema,
		namespace: BoundedOpaqueIdentifierSchema,
	})
	.strict();

export const PortalCatalogSourceManifestSchema = z
	.object({
		bundleByteLength: PositiveSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES),
		bundleSha256: Sha256DigestSchema,
		definitionFingerprint: PortalCatalogDefinitionFingerprintSchema,
		files: z.array(PortalCatalogSourceFileSchema).max(PORTAL_CATALOG_MAXIMUM_FILES).readonly(),
		generatorVersion: BoundedOpaqueIdentifierSchema,
		namespaces: z
			.array(PortalCatalogSourceNamespaceSchema)
			.max(PORTAL_CATALOG_MAXIMUM_FILES)
			.readonly(),
		sdkContractVersion: BoundedOpaqueIdentifierSchema,
	})
	.strict();

export const PortalCatalogPrepareRequestSchema = z.object({}).strict();
export const PortalCatalogPrepareResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			cacheDisposition: z.enum(['prepared', 'reused']),
			kind: z.literal('complete'),
			manifest: PortalCatalogSourceManifestSchema,
		})
		.strict(),
	z
		.object({
			diagnostics: z.array(SafeDiagnosticSchema).max(64).readonly(),
			kind: z.literal('incomplete'),
			reason: z.enum([
				'catalog-capacity-exhausted',
				'catalog-incomplete',
				'catalog-preparation-failed',
			]),
			retainedDefinitionFingerprint: PortalCatalogDefinitionFingerprintSchema.optional(),
		})
		.strict(),
]);

export const PortalCatalogOfferRequestSchema = z
	.object({ definitionFingerprint: PortalCatalogDefinitionFingerprintSchema })
	.strict();
export const PortalCatalogOfferResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('offered'),
			manifest: PortalCatalogSourceManifestSchema,
			offerId: BoundedOpaqueIdentifierSchema,
		})
		.strict(),
	z
		.object({ kind: z.literal('unavailable'), reason: z.literal('catalog-source-unavailable') })
		.strict(),
]);

export const PortalCatalogReadRequestSchema = z
	.object({
		definitionFingerprint: PortalCatalogDefinitionFingerprintSchema,
		length: PositiveSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_READ_BYTES),
		offerId: BoundedOpaqueIdentifierSchema,
		offset: NonnegativeSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES),
	})
	.strict();
export const PortalCatalogReadResultSchema = z.discriminatedUnion('kind', [
	z
		.object({
			byteLength: NonnegativeSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_READ_BYTES),
			contentBase64: CanonicalBase64Schema.max(
				Math.ceil(PORTAL_CATALOG_MAXIMUM_READ_BYTES / 3) * 4,
			),
			eof: z.boolean(),
			kind: z.literal('content'),
			totalLength: PositiveSafeIntegerSchema.max(PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES),
		})
		.strict(),
	z
		.object({ kind: z.literal('unavailable'), reason: z.literal('catalog-source-unavailable') })
		.strict(),
]);

export const PortalCatalogReleaseRequestSchema = z
	.object({
		definitionFingerprint: PortalCatalogDefinitionFingerprintSchema,
		offerId: BoundedOpaqueIdentifierSchema,
	})
	.strict();
export const PortalCatalogReleaseResultSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('released') }).strict(),
	z
		.object({ kind: z.literal('unavailable'), reason: z.literal('catalog-source-unavailable') })
		.strict(),
]);

export type PortalCatalogSourceManifest = z.infer<typeof PortalCatalogSourceManifestSchema>;
export type PortalCatalogPrepareRequest = z.infer<typeof PortalCatalogPrepareRequestSchema>;
export type PortalCatalogPrepareResult = z.infer<typeof PortalCatalogPrepareResultSchema>;
export type PortalCatalogOfferRequest = z.infer<typeof PortalCatalogOfferRequestSchema>;
export type PortalCatalogOfferResult = z.infer<typeof PortalCatalogOfferResultSchema>;
export type PortalCatalogReadRequest = z.infer<typeof PortalCatalogReadRequestSchema>;
export type PortalCatalogReadResult = z.infer<typeof PortalCatalogReadResultSchema>;
export type PortalCatalogReleaseRequest = z.infer<typeof PortalCatalogReleaseRequestSchema>;
export type PortalCatalogReleaseResult = z.infer<typeof PortalCatalogReleaseResultSchema>;
