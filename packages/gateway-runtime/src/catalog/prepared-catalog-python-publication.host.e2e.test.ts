import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { JsonValue } from '@agent-vm/agent-portal-sdk';
import type { GatewayRuntimeAttachmentMetadata } from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import type { GatewayRuntimePortalSemanticSnapshot } from '@agent-vm/gateway-control-contracts';
import type { ToolPortalCapabilityCore } from '@agent-vm/tool-portal';
import { describe, expect, it } from 'vitest';

import {
	createGatewayRuntimePrivateUdsDispatcher,
	resolveGatewayRuntimeOperationGroup,
} from '../production/gateway-runtime-private-uds-dispatcher.js';
import {
	createGatewayRuntimeToolPortalComposition,
	type GatewayRuntimeCatalogProjectionOperations,
} from '../tool-portal-projections.js';
import { createGatewayRuntimePaths } from '../uds/gateway-runtime-paths.js';
import { startGatewayRuntimeUdsServer } from '../uds/gateway-runtime-uds-server.js';
import { createManagedPluginAttachmentState } from '../uds/managed-plugin-attachment-policy.js';
import { createPreparedCatalogSourceCache } from './prepared-catalog-source-cache.js';

const execFile = promisify(execFileCallback);
const projectionCohortDigest =
	'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const attachment = {
	attachmentGeneration: 1,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['main'],
	frameworkEpoch: 'framework-1',
	gatewayEpoch: 'gateway-1',
	projectionCohortDigest,
	protocolVersion: 1,
	runtimeEpoch: 'runtime-1',
	schemaVersion: 1,
} as const satisfies GatewayRuntimeAttachmentMetadata;
const semanticSnapshot = {
	activeRevision: 'active-1',
	agentProjections: {
		main: {
			agentId: 'main',
			frameworkIdentity: { kind: 'hermes', profileName: 'main' },
			profileAssignmentRevision: 'assignment-1',
			toolPortalNamespaces: [{ namespace: 'large-a' }, { namespace: 'large-b' }],
			toolPortalProfileId: 'profile-1',
		},
	},
	bindingRevision: 'binding-1',
	catalogRevision: 'catalog-1',
	desiredRevision: 'active-1',
	profilePolicyRevision: 'policy-1',
	projectionCohortDigest,
	providerRevision: 'provider-1',
	schemaRevision: 'schema-1',
	schemaVersion: 1,
	surfaceEligibilityByProfile: {
		'profile-1': { 'large-a': ['protected_uds'], 'large-b': ['protected_uds'] },
	},
} as const satisfies GatewayRuntimePortalSemanticSnapshot;

const PYTHON_JOINED_CATALOG_PROOF = String.raw`
import asyncio
import json
import sys
from collections.abc import Mapping
from pathlib import Path

from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity
from agent_vm_agent_portal_sdk.catalog_relay_startup import GatewayPortalCatalogSource
from agent_vm_agent_portal_sdk.gateway_runtime_client import GatewayRuntimeClient
from agent_vm_agent_portal_sdk.portal_bridge_connection import PortalBridgeConnection
from agent_vm_agent_portal_sdk.portal_execution_bridge import PortalExecutionBridge
from pydantic import BaseModel

ATTACHMENT = {
    "attachmentGeneration": 1,
    "clientKind": "hermes-managed-plugin",
    "configuredAgentIds": ["main"],
    "frameworkEpoch": "framework-1",
    "gatewayEpoch": "gateway-1",
    "projectionCohortDigest": "projection-cohort:" + "a" * 64,
    "protocolVersion": 1,
    "runtimeEpoch": "runtime-1",
    "schemaVersion": 1,
}
TRUSTED_CONTEXT = {
    "correlation": {"runId": "run-1", "sessionId": "session-1", "toolCallId": "tool-call-1", "turnId": "turn-1"},
    "principal": {
        "agentId": "main",
        "frameworkIdentity": {"kind": "hermes", "profileName": "main"},
        "profileAssignmentRevision": "assignment-1",
        "toolPortalProfileId": "profile-1",
    },
}

class SubprocessPort:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdin is not None
        assert process.stdout is not None
        self.process = process
        self.stdin = process.stdin
        self.stdout = process.stdout

    async def read(self) -> bytes:
        return await self.stdout.read(65_536)

    async def write(self, content: bytes) -> None:
        self.stdin.write(content)
        await self.stdin.drain()

    async def close(self) -> None:
        if not self.stdin.is_closing():
            self.stdin.close()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=10)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()

async def start_helper(socket_path: Path, publication_root: Path, identity: CatalogPublicationIdentity) -> asyncio.subprocess.Process:
    helper_source = """
import asyncio
import sys
from pathlib import Path
from agent_vm_agent_portal_sdk.catalog_module_publication import CatalogPublicationIdentity
from agent_vm_agent_portal_sdk.guest_portal_relay_process import run_guest_relay

identity = CatalogPublicationIdentity(
    definition_fingerprint=sys.argv[3],
    bundle_sha256=sys.argv[4],
    bundle_byte_length=int(sys.argv[5]),
)
asyncio.run(run_guest_relay(
    sys.argv[1],
    catalog_identity=identity,
    catalog_root=Path(sys.argv[2]),
    create_directory=True,
))
"""
    return await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        helper_source,
        str(socket_path),
        str(publication_root),
        identity.definition_fingerprint,
        identity.bundle_sha256,
        str(identity.bundle_byte_length),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

async def run_helper(label: str, publication_root: Path, source: GatewayPortalCatalogSource) -> str:
    socket_path = publication_root.parent / f"relay-{label}" / "portal.sock"
    process = await start_helper(socket_path, publication_root, source.identity)

    async def reject_public_call(_operation: str, _request: Mapping[str, object]) -> BaseModel:
        raise AssertionError("Catalog startup must not dispatch a public Portal call.")

    connection = PortalBridgeConnection(
        process=SubprocessPort(process),
        bridge=PortalExecutionBridge(invoke=reject_public_call),
        catalog_source=source,
        startup_deadline_monotonic=asyncio.get_running_loop().time() + 30,
    )
    pump = asyncio.create_task(connection.run())
    try:
        await connection.wait_ready()
        manifest_path = connection.catalog_manifest_path
        assert manifest_path == source.expected_manifest_path
        assert socket_path.exists()
        return manifest_path
    finally:
        await connection.close()
        await asyncio.gather(pump, return_exceptions=True)
        if process.returncode != 0:
            assert process.stderr is not None
            raise AssertionError((await process.stderr.read()).decode())

async def main() -> None:
    runtime_socket = sys.argv[1]
    publication_root = Path(sys.argv[2])
    client = GatewayRuntimeClient(
        attachment=ATTACHMENT,
        socket_path=runtime_socket,
        startup_retry_policy={"maxAttempts": 1, "deadlineMs": 30_000, "intervalMs": 1},
    )
    await client.connect()
    try:
        prepared = (await client.catalog.prepare({}, trusted_context=TRUSTED_CONTEXT)).model_dump(by_alias=True, mode="json", exclude_none=True)
        assert prepared["kind"] == "complete"
        manifest = prepared["manifest"]
        assert manifest["bundleByteLength"] > 1024 * 1024
        fingerprint = manifest["definitionFingerprint"]
        read_counts = [0, 0]

        async def publish_once(index: int, label: str) -> str:
            offered = (await client.catalog.offer({"definitionFingerprint": fingerprint}, trusted_context=TRUSTED_CONTEXT)).model_dump(by_alias=True, mode="json", exclude_none=True)
            assert offered["kind"] == "offered"
            assert offered["manifest"] == manifest
            offer_id = offered["offerId"]
            identity = CatalogPublicationIdentity(
                definition_fingerprint=fingerprint,
                bundle_sha256=manifest["bundleSha256"],
                bundle_byte_length=manifest["bundleByteLength"],
            )

            async def read(request: Mapping[str, object]) -> BaseModel:
                read_counts[index] += 1
                return await client.catalog.read(request, trusted_context=TRUSTED_CONTEXT)

            source = GatewayPortalCatalogSource(
                offer_id=offer_id,
                identity=identity,
                read=read,
                publication_root=publication_root,
            )
            manifest_path = await run_helper(label, publication_root, source)
            released = (await client.catalog.release(
                {"definitionFingerprint": fingerprint, "offerId": offer_id},
                trusted_context=TRUSTED_CONTEXT,
            )).model_dump(by_alias=True, mode="json", exclude_none=True)
            assert released["kind"] == "released"
            return manifest_path

        first_manifest = await publish_once(0, "first")
        second_manifest = await publish_once(1, "second")
        assert first_manifest == second_manifest
        assert read_counts[0] > 16
        assert read_counts[1] == 0
        publication_directory = publication_root / fingerprint
        assert (publication_directory / ".bundle.json").stat().st_size == manifest["bundleByteLength"]
        assert (publication_directory / "manifest.json").is_file()
        for file in manifest["files"]:
            assert (publication_directory / file["path"]).stat().st_size == file["byteLength"]
        print(json.dumps({
            "bundleByteLength": manifest["bundleByteLength"],
            "fileCount": len(manifest["files"]),
            "firstReadCount": read_counts[0],
            "secondReadCount": read_counts[1],
            "fingerprint": fingerprint,
        }))
    finally:
        await client.disconnect()

asyncio.run(main())
`;

function largeCatalogInputSchema(namespace: string): Readonly<Record<string, JsonValue>> {
	const values = Array.from(
		{ length: 300 },
		(_unused, index) => `${namespace}-${String(index).padStart(3, '0')}-${'x'.repeat(900)}`,
	);
	return {
		properties: { selection: { enum: values, type: 'string' } },
		required: ['selection'],
		type: 'object',
	};
}

async function rejectUnexpectedOperation(): Promise<never> {
	throw new Error('Unexpected joined catalog proof operation.');
}

describe('prepared catalog Python publication host journey', () => {
	it('publishes a large exact offer through Python and reuses the verified helper cache', async () => {
		const temporaryRoot = await mkdtemp(path.join('/tmp', 'av-cat-'));
		const runtimePaths = createGatewayRuntimePaths({
			runtimeRoot: path.join(temporaryRoot, 'runtime'),
		});
		const publicationRoot = path.join(temporaryRoot, 'published-catalogs');
		const preparedCatalogSourceCache = createPreparedCatalogSourceCache();
		const capabilityCore = {
			call: rejectUnexpectedOperation,
			describe: rejectUnexpectedOperation,
			list: rejectUnexpectedOperation,
			prepareCatalog: async () => ({
				kind: 'complete' as const,
				tools: [
					{ inputSchema: largeCatalogInputSchema('large-a'), name: 'select', namespace: 'large-a' },
					{ inputSchema: largeCatalogInputSchema('large-b'), name: 'select', namespace: 'large-b' },
				],
			}),
			search: rejectUnexpectedOperation,
			semanticSnapshot,
		} satisfies ToolPortalCapabilityCore<'managed'>;
		const composition = createGatewayRuntimeToolPortalComposition<{
			readonly catalogOperations: GatewayRuntimeCatalogProjectionOperations;
		}>({
			approvalPort: {
				armDispatch: rejectUnexpectedOperation,
				reserveDispatch: rejectUnexpectedOperation,
			},
			artifactReader: { read: rejectUnexpectedOperation },
			authenticatedPrivateUdsOperationGroups: ['portal'],
			createPrivateUdsProjection: (props) => ({ catalogOperations: props.catalogOperations }),
			createToolPortalCapabilityCore: () => capabilityCore,
			managedPluginAttachment: {
				clientKind: attachment.clientKind,
				configuredAgentIds: attachment.configuredAgentIds,
				gatewayEpoch: attachment.gatewayEpoch,
				projectionCohortDigest: attachment.projectionCohortDigest,
			},
			preparedCatalogSourceCache,
			semanticSnapshot,
		});
		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			approvalOperations: { decide: rejectUnexpectedOperation },
			artifactOperations: { read: rejectUnexpectedOperation },
			catalogOperations: composition.privateUdsProjection.catalogOperations,
			portalOperations: {
				call: rejectUnexpectedOperation,
				describe: rejectUnexpectedOperation,
				list: rejectUnexpectedOperation,
				search: rejectUnexpectedOperation,
			},
			sandboxDispatch: rejectUnexpectedOperation,
		});
		const server = await startGatewayRuntimeUdsServer({
			attachmentState: createManagedPluginAttachmentState({
				attachmentGeneration: attachment.attachmentGeneration,
				clientKind: attachment.clientKind,
				configuredAgentIds: attachment.configuredAgentIds,
				frameworkEpoch: attachment.frameworkEpoch,
				gatewayEpoch: attachment.gatewayEpoch,
				projectionCohortDigest: attachment.projectionCohortDigest,
				runtimeEpoch: attachment.runtimeEpoch,
				serverAuthority: { allowedOperationGroups: ['portal'], surface: 'managed-plugin' },
			}),
			dispatch: dispatcher.dispatch,
			onConnectionClosed: preparedCatalogSourceCache.retireConnection,
			paths: runtimePaths,
			resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
		});

		try {
			const result = await execFile(
				'uv',
				[
					'run',
					'--project',
					'python/agent-vm-agent-portal-sdk',
					'python',
					'-c',
					PYTHON_JOINED_CATALOG_PROOF,
					server.readiness.socketPath,
					publicationRoot,
				],
				{ cwd: process.cwd(), env: process.env, maxBuffer: 1 * 1_024 * 1_024, timeout: 120_000 },
			);
			const observation = JSON.parse(result.stdout) as {
				readonly bundleByteLength: number;
				readonly fileCount: number;
				readonly fingerprint: string;
				readonly firstReadCount: number;
				readonly secondReadCount: number;
			};
			expect(observation).toMatchObject({ fileCount: 2, secondReadCount: 0 });
			expect(observation.bundleByteLength).toBeGreaterThan(1 * 1_024 * 1_024);
			expect(observation.firstReadCount).toBeGreaterThan(16);
			// oxlint-disable-next-line no-console -- The host proof records bounded transfer and cache-hit evidence.
			console.log('joined catalog host proof', JSON.stringify(observation));
			const manifest = JSON.parse(
				await readFile(
					path.join(publicationRoot, observation.fingerprint, 'manifest.json'),
					'utf8',
				),
			) as { readonly definitionFingerprint: string };
			expect(manifest.definitionFingerprint).toBe(observation.fingerprint);
		} finally {
			await server.retire({ drainTimeoutMs: 1_000 });
			preparedCatalogSourceCache.retireEpoch();
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});
});
