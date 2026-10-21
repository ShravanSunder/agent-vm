import {
	accessProfileProjection,
	assessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import { describe, expect, it } from 'vitest';

import { fixture, namespace } from '#tool-access/authorization/access-assessor-test-fixture';

describe('projection call-policy non-overlap at exported boundaries', () => {
	it.each([
		{
			requiresApproval: { allow: ['run'], deny: [] },
			withoutApproval: { allow: ['run'], deny: [] },
		},
		{ requiresApproval: { allow: '*', deny: [] }, withoutApproval: { allow: '*', deny: [] } },
	])('rejects overlapping selectors through projection and assessment input %j', (selectors) => {
		const input = fixture();
		const profile = {
			...input.facts.assignment.profile,
			namespaces: { tools: { ...namespace(input), calls: { kind: 'selectors', ...selectors } } },
		};
		const rawInput = {
			...input,
			facts: { ...input.facts, assignment: { ...input.facts.assignment, profile } },
		};
		expect(accessProfileProjection.safeParse(profile).success).toBe(false);
		expect(assessAccessInput.safeParse(rawInput).success).toBe(false);
	});
	it.each([
		{
			requiresApproval: { allow: ['delete'], deny: [] },
			withoutApproval: { allow: ['read'], deny: [] },
		},
		{
			requiresApproval: { allow: '*', deny: ['read'] },
			withoutApproval: { allow: ['read'], deny: [] },
		},
		{
			requiresApproval: { allow: ['read'], deny: [] },
			withoutApproval: { allow: '*', deny: ['read'] },
		},
	])('retains disjoint and deny-excluded selectors through both schemas %j', (selectors) => {
		const input = fixture();
		const profile = {
			...input.facts.assignment.profile,
			namespaces: { tools: { ...namespace(input), calls: { kind: 'selectors', ...selectors } } },
		};
		const rawInput = {
			...input,
			facts: { ...input.facts, assignment: { ...input.facts.assignment, profile } },
		};
		expect(accessProfileProjection.safeParse(profile).success).toBe(true);
		expect(assessAccessInput.safeParse(rawInput).success).toBe(true);
	});
});
