import { createHash, randomUUID } from 'node:crypto';

import {
	PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES,
	PORTAL_CATALOG_MAXIMUM_FILES,
	PORTAL_CATALOG_MAXIMUM_FILE_BYTES,
	PORTAL_CATALOG_MAXIMUM_MANIFEST_BYTES,
	PORTAL_CATALOG_MAXIMUM_READ_BYTES,
	PortalCatalogSourceManifestSchema,
	type PortalCatalogOfferResult,
	type PortalCatalogPrepareResult,
	type PortalCatalogReadResult,
	type PortalCatalogReleaseResult,
	type PortalCatalogSourceManifest,
} from '@agent-vm/agent-portal-sdk';
import {
	compileCatalogTypescriptModules,
	fingerprintCatalogTypescriptInput,
	type CompileCatalogTypescriptModulesInput,
	type CompiledCatalogTypescriptBundle,
} from '@agent-vm/mcp-portal/catalog-typescript';

export const PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_BYTES = 64 * 1_024 * 1_024;
export const PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_ENTRIES = 128;
export const PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_OFFERS = 128;

export interface PreparedCatalogSourceAuthority {
	readonly activeRevision: string;
	readonly catalogRevision: string;
	readonly connectionId: string;
	readonly gatewayEpoch: string;
	readonly profileAssignmentRevision: string;
	readonly profileId: string;
	readonly profilePolicyRevision: string;
	readonly providerRevision: string;
	readonly schemaRevision: string;
	readonly sessionId?: string;
	readonly stablePrincipal: string;
	readonly turnId?: string;
}

interface PreparedCatalogSourceEntry {
	readonly bundleBytes: Buffer;
	readonly createdSequence: number;
	readonly definitionFingerprint: string;
	readonly manifest: PortalCatalogSourceManifest;
	readonly principalProfileKey: string;
}

interface PreparedCatalogSourceOffer {
	readonly authorityKey: string;
	readonly connectionId: string;
	readonly definitionFingerprint: string;
	readonly entryKey: string;
	readonly offerId: string;
	readonly sessionId: string;
	readonly turnId: string;
}

export interface PreparedCatalogSourceCache {
	readonly inspect: () => {
		readonly byteLength: number;
		readonly entries: number;
		readonly offers: number;
		readonly retired: boolean;
	};
	readonly offer: (props: {
		readonly authority: PreparedCatalogSourceAuthority;
		readonly definitionFingerprint: string;
	}) => PortalCatalogOfferResult;
	readonly prepare: (props: {
		readonly authority: PreparedCatalogSourceAuthority;
		readonly input: CompileCatalogTypescriptModulesInput;
	}) => Promise<PortalCatalogPrepareResult>;
	readonly read: (props: {
		readonly authority: PreparedCatalogSourceAuthority;
		readonly definitionFingerprint: string;
		readonly length: number;
		readonly offerId: string;
		readonly offset: number;
	}) => PortalCatalogReadResult;
	readonly release: (props: {
		readonly authority: PreparedCatalogSourceAuthority;
		readonly definitionFingerprint: string;
		readonly offerId: string;
	}) => PortalCatalogReleaseResult;
	readonly retireConnection: (connectionId: string) => void;
	readonly retireEpoch: () => void;
}

export interface CreatePreparedCatalogSourceCacheProps {
	readonly compile?: typeof compileCatalogTypescriptModules;
	readonly fingerprint?: typeof fingerprintCatalogTypescriptInput;
	readonly limits?: {
		readonly maximumBytes?: number;
		readonly maximumEntries?: number;
		readonly maximumOffers?: number;
	};
}

function sha256(bytes: string | Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function authorityKey(authority: PreparedCatalogSourceAuthority): string {
	return JSON.stringify({
		activeRevision: authority.activeRevision,
		catalogRevision: authority.catalogRevision,
		gatewayEpoch: authority.gatewayEpoch,
		profileAssignmentRevision: authority.profileAssignmentRevision,
		profileId: authority.profileId,
		profilePolicyRevision: authority.profilePolicyRevision,
		providerRevision: authority.providerRevision,
		schemaRevision: authority.schemaRevision,
		stablePrincipal: authority.stablePrincipal,
	});
}

function principalProfileKey(authority: PreparedCatalogSourceAuthority): string {
	return JSON.stringify({
		gatewayEpoch: authority.gatewayEpoch,
		profileId: authority.profileId,
		stablePrincipal: authority.stablePrincipal,
	});
}

function entryKey(
	authority: PreparedCatalogSourceAuthority,
	definitionFingerprint: string,
): string {
	return `${authorityKey(authority)}\u0000${definitionFingerprint}`;
}

function unavailableDiagnostic(message: string): PortalCatalogPrepareResult {
	return {
		diagnostics: [{ code: 'provider_unavailable', level: 'error', safeMessage: message }],
		kind: 'incomplete',
		reason: 'catalog-preparation-failed',
	};
}

function buildManifest(
	bundle: CompiledCatalogTypescriptBundle,
	bundleBytes: Buffer,
): PortalCatalogSourceManifest {
	const filePaths = bundle.files.map((file) => file.path);
	const namespaceNames = bundle.manifest.namespaces.map((namespace) => namespace.namespace);
	if (
		bundle.manifest.definitionFingerprint !== bundle.definitionFingerprint ||
		new Set(filePaths).size !== filePaths.length ||
		new Set(namespaceNames).size !== namespaceNames.length ||
		bundle.manifest.namespaces.some((namespace) => !filePaths.includes(namespace.modulePath))
	) {
		throw new Error('Compiled catalog manifest contains inconsistent namespace files.');
	}
	for (const file of bundle.files) {
		if (file.byteLength !== Buffer.byteLength(file.source) || file.sha256 !== sha256(file.source)) {
			throw new Error('Compiled catalog file integrity metadata is inconsistent.');
		}
	}
	if (
		bundle.files.length > PORTAL_CATALOG_MAXIMUM_FILES ||
		bundle.files.some((file) => file.byteLength > PORTAL_CATALOG_MAXIMUM_FILE_BYTES) ||
		bundleBytes.byteLength > PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES
	) {
		throw new Error('Compiled catalog exceeds the prepared-source bounds.');
	}
	const manifest = PortalCatalogSourceManifestSchema.parse({
		bundleByteLength: bundleBytes.byteLength,
		bundleSha256: `sha256:${sha256(bundleBytes)}`,
		definitionFingerprint: bundle.definitionFingerprint,
		files: bundle.files.map(({ byteLength, namespace, path, sha256: fileSha256 }) => ({
			byteLength,
			namespace,
			path,
			sha256: fileSha256,
		})),
		generatorVersion: bundle.manifest.generatorVersion,
		namespaces: bundle.manifest.namespaces.map(
			({ exportedFactoryName, modulePath, namespace }) => ({
				exportedFactoryName,
				modulePath,
				namespace,
			}),
		),
		sdkContractVersion: bundle.manifest.sdkContractVersion,
	});
	if (
		Buffer.byteLength(
			JSON.stringify({
				kind: 'offered',
				manifest,
				offerId: '00000000-0000-4000-8000-000000000000',
			}),
		) > PORTAL_CATALOG_MAXIMUM_MANIFEST_BYTES
	) {
		throw new Error('Compiled catalog manifest exceeds the private response bound.');
	}
	return manifest;
}

function offerMatchesAuthority(
	offer: PreparedCatalogSourceOffer,
	authority: PreparedCatalogSourceAuthority,
): boolean {
	return (
		offer.authorityKey === authorityKey(authority) &&
		offer.connectionId === authority.connectionId &&
		offer.sessionId === authority.sessionId &&
		offer.turnId === authority.turnId
	);
}

export function createPreparedCatalogSourceCache(
	props: CreatePreparedCatalogSourceCacheProps = {},
): PreparedCatalogSourceCache {
	const compile = props.compile ?? compileCatalogTypescriptModules;
	const fingerprint = props.fingerprint ?? fingerprintCatalogTypescriptInput;
	const maximumBytes = props.limits?.maximumBytes ?? PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_BYTES;
	const maximumEntries =
		props.limits?.maximumEntries ?? PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_ENTRIES;
	const maximumOffers = props.limits?.maximumOffers ?? PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_OFFERS;
	const entries = new Map<string, PreparedCatalogSourceEntry>();
	const offers = new Map<string, PreparedCatalogSourceOffer>();
	const releasedOffers = new Map<string, PreparedCatalogSourceOffer>();
	const currentEntryByPrincipalProfile = new Map<string, string>();
	const preparationFlights = new Map<string, Promise<PortalCatalogPrepareResult>>();
	let byteLength = 0;
	let createdSequence = 0;
	let retired = false;

	const offeredEntryKeys = (): ReadonlySet<string> =>
		new Set([...offers.values()].map((offer) => offer.entryKey));

	const deleteEntry = (key: string): void => {
		const entry = entries.get(key);
		if (entry === undefined) return;
		entries.delete(key);
		byteLength -= entry.bundleBytes.byteLength;
	};

	const makeCapacity = (propsForCapacity: {
		readonly bytesNeeded: number;
		readonly entriesNeeded: number;
		readonly replacingCurrentKey?: string;
	}): boolean => {
		const offered = offeredEntryKeys();
		const protectedCurrent = new Set(currentEntryByPrincipalProfile.values());
		if (propsForCapacity.replacingCurrentKey !== undefined) {
			protectedCurrent.delete(propsForCapacity.replacingCurrentKey);
		}
		const candidates = [...entries]
			.filter(([key]) => !offered.has(key) && !protectedCurrent.has(key))
			.toSorted(([, left], [, right]) => left.createdSequence - right.createdSequence);
		let projectedByteLength = byteLength;
		let projectedEntryCount = entries.size;
		const entriesToDelete: string[] = [];
		for (const [key] of candidates) {
			if (
				projectedByteLength + propsForCapacity.bytesNeeded <= maximumBytes &&
				projectedEntryCount + propsForCapacity.entriesNeeded <= maximumEntries
			)
				break;
			const candidate = entries.get(key);
			if (candidate === undefined) continue;
			entriesToDelete.push(key);
			projectedByteLength -= candidate.bundleBytes.byteLength;
			projectedEntryCount -= 1;
		}
		const hasCapacity =
			projectedByteLength + propsForCapacity.bytesNeeded <= maximumBytes &&
			projectedEntryCount + propsForCapacity.entriesNeeded <= maximumEntries;
		if (!hasCapacity) return false;
		for (const key of entriesToDelete) deleteEntry(key);
		return true;
	};

	const retainedFingerprint = (authority: PreparedCatalogSourceAuthority): string | undefined => {
		const currentKey = currentEntryByPrincipalProfile.get(principalProfileKey(authority));
		return currentKey === undefined ? undefined : entries.get(currentKey)?.definitionFingerprint;
	};

	return {
		inspect: () => ({ byteLength, entries: entries.size, offers: offers.size, retired }),
		offer: ({ authority, definitionFingerprint }) => {
			if (retired || authority.sessionId === undefined || authority.turnId === undefined) {
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			}
			const profileKey = principalProfileKey(authority);
			const key = currentEntryByPrincipalProfile.get(profileKey);
			if (key === undefined) {
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			}
			const entry = entries.get(key);
			if (
				entry === undefined ||
				entry.definitionFingerprint !== definitionFingerprint ||
				offers.size >= maximumOffers
			) {
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			}
			const offerId = randomUUID();
			offers.set(offerId, {
				authorityKey: authorityKey(authority),
				connectionId: authority.connectionId,
				definitionFingerprint,
				entryKey: key,
				offerId,
				sessionId: authority.sessionId,
				turnId: authority.turnId,
			});
			return { kind: 'offered', manifest: entry.manifest, offerId };
		},
		prepare: async ({ authority, input }) => {
			if (retired) return unavailableDiagnostic('Catalog source preparation is unavailable.');
			let definitionFingerprint: string;
			try {
				definitionFingerprint = fingerprint(input);
			} catch {
				return unavailableDiagnostic('Catalog definitions could not be normalized.');
			}
			const key = entryKey(authority, definitionFingerprint);
			const existing = entries.get(key);
			if (existing !== undefined) {
				currentEntryByPrincipalProfile.set(existing.principalProfileKey, key);
				return { cacheDisposition: 'reused', kind: 'complete', manifest: existing.manifest };
			}
			const currentKey = currentEntryByPrincipalProfile.get(principalProfileKey(authority));
			const currentEntry = currentKey === undefined ? undefined : entries.get(currentKey);
			if (currentEntry?.definitionFingerprint === definitionFingerprint) {
				return { cacheDisposition: 'reused', kind: 'complete', manifest: currentEntry.manifest };
			}
			const preparationFlightKey = authorityKey(authority);
			const flight = preparationFlights.get(preparationFlightKey);
			if (flight !== undefined) return await flight;
			const preparation = (async (): Promise<PortalCatalogPrepareResult> => {
				const retainedDefinitionFingerprint = retainedFingerprint(authority);
				try {
					const bundle = await compile(input);
					if (retired) return unavailableDiagnostic('Catalog source preparation is unavailable.');
					if (bundle.definitionFingerprint !== definitionFingerprint) {
						throw new Error('Compiled catalog fingerprint changed during preparation.');
					}
					const bundleBytes = Buffer.from(JSON.stringify(bundle));
					const manifest = buildManifest(bundle, bundleBytes);
					const profileKey = principalProfileKey(authority);
					const previousCurrentKey = currentEntryByPrincipalProfile.get(profileKey);
					if (
						!makeCapacity({
							bytesNeeded: bundleBytes.byteLength,
							entriesNeeded: 1,
							...(previousCurrentKey === undefined
								? {}
								: { replacingCurrentKey: previousCurrentKey }),
						})
					) {
						return {
							diagnostics: [
								{
									code: 'provider_unavailable',
									level: 'error',
									safeMessage: 'Prepared catalog source capacity is exhausted.',
								},
							],
							kind: 'incomplete',
							reason: 'catalog-capacity-exhausted',
							...(retainedDefinitionFingerprint === undefined
								? {}
								: { retainedDefinitionFingerprint }),
						};
					}
					const entry: PreparedCatalogSourceEntry = {
						bundleBytes,
						createdSequence: createdSequence++,
						definitionFingerprint,
						manifest,
						principalProfileKey: profileKey,
					};
					entries.set(key, entry);
					byteLength += bundleBytes.byteLength;
					currentEntryByPrincipalProfile.set(profileKey, key);
					if (
						previousCurrentKey !== undefined &&
						previousCurrentKey !== key &&
						!offeredEntryKeys().has(previousCurrentKey)
					) {
						deleteEntry(previousCurrentKey);
					}
					return { cacheDisposition: 'prepared', kind: 'complete', manifest };
				} catch {
					return {
						diagnostics: [
							{
								code: 'provider_unavailable',
								level: 'error',
								safeMessage: 'Catalog source preparation failed.',
							},
						],
						kind: 'incomplete',
						reason: 'catalog-preparation-failed',
						...(retainedDefinitionFingerprint === undefined
							? {}
							: { retainedDefinitionFingerprint }),
					};
				}
			})();
			preparationFlights.set(preparationFlightKey, preparation);
			try {
				return await preparation;
			} finally {
				preparationFlights.delete(preparationFlightKey);
			}
		},
		read: ({ authority, definitionFingerprint, length, offerId, offset }) => {
			if (
				retired ||
				!Number.isSafeInteger(length) ||
				length <= 0 ||
				length > PORTAL_CATALOG_MAXIMUM_READ_BYTES ||
				!Number.isSafeInteger(offset) ||
				offset < 0 ||
				offset > PORTAL_CATALOG_MAXIMUM_BUNDLE_BYTES
			) {
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			}
			const offer = offers.get(offerId);
			if (
				offer === undefined ||
				offer.definitionFingerprint !== definitionFingerprint ||
				!offerMatchesAuthority(offer, authority)
			)
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			const entry = entries.get(offer.entryKey);
			if (entry === undefined || offset >= entry.bundleBytes.byteLength) {
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			}
			const content = entry.bundleBytes.subarray(
				offset,
				Math.min(offset + length, entry.bundleBytes.byteLength),
			);
			return {
				byteLength: content.byteLength,
				contentBase64: content.toString('base64'),
				eof: offset + content.byteLength === entry.bundleBytes.byteLength,
				kind: 'content',
				totalLength: entry.bundleBytes.byteLength,
			};
		},
		release: ({ authority, definitionFingerprint, offerId }) => {
			const offer = offers.get(offerId) ?? releasedOffers.get(offerId);
			if (
				retired ||
				offer === undefined ||
				offer.definitionFingerprint !== definitionFingerprint ||
				!offerMatchesAuthority(offer, authority)
			)
				return { kind: 'unavailable', reason: 'catalog-source-unavailable' };
			if (offers.delete(offerId)) {
				releasedOffers.set(offerId, offer);
				if (releasedOffers.size > PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_OFFERS) {
					const oldestReleasedOfferId = releasedOffers.keys().next().value;
					if (oldestReleasedOfferId !== undefined) releasedOffers.delete(oldestReleasedOfferId);
				}
			}
			return { kind: 'released' };
		},
		retireConnection: (connectionId) => {
			for (const [offerId, offer] of offers)
				if (offer.connectionId === connectionId) offers.delete(offerId);
			for (const [offerId, offer] of releasedOffers)
				if (offer.connectionId === connectionId) releasedOffers.delete(offerId);
		},
		retireEpoch: () => {
			retired = true;
			offers.clear();
			releasedOffers.clear();
			entries.clear();
			currentEntryByPrincipalProfile.clear();
			preparationFlights.clear();
			byteLength = 0;
		},
	};
}
