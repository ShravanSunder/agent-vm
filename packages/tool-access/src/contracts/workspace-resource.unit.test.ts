import { describe, expect, it } from 'vitest';

import {
	normalizeToolPortalOrigin,
	workspaceResourceIdentifier,
	workspaceResourceMetadataSchema,
} from '#tool-access/contracts/workspace-resource';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('configured workspace resource identity', () => {
	it('normalizes an origin and constructs one literal workspace address', () => {
		expect(normalizeToolPortalOrigin('https://PORTAL.invalid:443/')).toBe('https://portal.invalid');
		expect(
			workspaceResourceIdentifier({ toolPortalOrigin: 'https://PORTAL.invalid:443/', workspaceId }),
		).toBe('https://portal.invalid/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/mcp');
	});
	it.each([
		'https://user:secret@portal.invalid',
		'https://portal.invalid/mcp',
		'https://portal.invalid/?x=1',
		'https://portal.invalid/#fragment',
		'file:///tmp/portal',
	])('refuses a configured value that is not an origin: %s', (toolPortalOrigin) => {
		expect(() => workspaceResourceIdentifier({ toolPortalOrigin, workspaceId })).toThrow();
	});
	it('requires UUID metadata and refuses unrelated claims', () => {
		const metadata = {
			kind: 'workspace',
			organizationId: '11111111-1111-4111-8111-111111111111',
			workspaceId,
		};
		expect(workspaceResourceMetadataSchema.parse(metadata)).toEqual(metadata);
		expect(
			workspaceResourceMetadataSchema.safeParse({ ...metadata, persona: 'owner' }).success,
		).toBe(false);
		expect(
			workspaceResourceMetadataSchema.safeParse({ ...metadata, workspaceId: 'not-uuid' }).success,
		).toBe(false);
	});
});
