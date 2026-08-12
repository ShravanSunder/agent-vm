import path from 'node:path';

import { object, or } from '@optique/core/constructs';
import { map, optional, withDefault } from '@optique/core/modifiers';
import type { InferValue, Parser } from '@optique/core/parser';
import { command, constant, option } from '@optique/core/primitives';
import { zod } from '@optique/zod';
import { z } from 'zod';

const toolPortalTransportKindSchema = z.enum(['http', 'scoped-stdio']);
const toolPortalHttpTransportKindSchema = toolPortalTransportKindSchema.extract(['http']);
const toolPortalScopedStdioTransportKindSchema = toolPortalTransportKindSchema.extract([
	'scoped-stdio',
]);
const toolPortalInputJsonSchema = z.string().min(1);
const toolPortalEnvironmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const toolPortalOptionalApprovalEnvironmentNameSchema =
	toolPortalEnvironmentVariableNameSchema.optional();
const toolPortalHttpEndpointSchema = z
	.string()
	.min(1)
	.refine(
		(value): boolean => {
			try {
				const endpoint = new URL(value);
				return (
					(endpoint.protocol === 'http:' || endpoint.protocol === 'https:') &&
					endpoint.username.length === 0 &&
					endpoint.password.length === 0 &&
					endpoint.hash.length === 0
				);
			} catch {
				return false;
			}
		},
		{
			message:
				'Tool Portal HTTP endpoint must be an HTTP(S) URL without credentials or a fragment.',
		},
	);
const toolPortalScopedStdioConfigPathSchema = z.string().min(1).refine(path.isAbsolute, {
	message: 'Scoped stdio configuration path must be absolute.',
});

interface ZodScalarPresenceProps<TSchema extends z.ZodType, TState> {
	readonly parser: Parser<'sync', z.infer<TSchema>, TState>;
	readonly schema: TSchema;
}

export function projectZodScalarPresence<TSchema extends z.ZodType, TState>(
	props: ZodScalarPresenceProps<TSchema, TState>,
): Parser<'sync', z.infer<TSchema>>;
export function projectZodScalarPresence(props: {
	readonly parser: Parser;
	readonly schema: z.ZodType;
}): Parser {
	if (props.schema instanceof z.ZodOptional) {
		if (props.schema.unwrap() instanceof z.ZodDefault) {
			throw new Error('CLI value schemas must not mix ZodOptional and ZodDefault.');
		}
		return optional(props.parser);
	}
	if (props.schema instanceof z.ZodDefault) {
		if (props.schema.unwrap() instanceof z.ZodOptional) {
			throw new Error('CLI value schemas must not mix ZodOptional and ZodDefault.');
		}
		return withDefault(props.parser, props.schema.parse(undefined));
	}
	return props.parser;
}

const toolPortalHttpTransportParser = map(
	object({
		authorizationEnvironmentName: option(
			'--authorization-env',
			zod(toolPortalEnvironmentVariableNameSchema, {
				metavar: 'ENV_NAME',
				placeholder: 'TOOL_PORTAL_AUTH',
			}),
		),
		endpoint: option(
			'--endpoint',
			zod(toolPortalHttpEndpointSchema, {
				metavar: 'URL',
				placeholder: 'https://example.test/mcp',
			}),
		),
		kind: constant('http'),
		transportKind: option(
			'--transport',
			zod(toolPortalHttpTransportKindSchema, {
				metavar: 'TRANSPORT',
				placeholder: 'http',
			}),
		),
	}),
	({ authorizationEnvironmentName, endpoint, kind }) => ({
		authorizationEnvironmentName,
		endpoint,
		kind,
	}),
);

const toolPortalScopedStdioTransportParser = map(
	object({
		kind: constant('scoped-stdio'),
		scopedStdioConfigPath: option(
			'--stdio-config',
			zod(toolPortalScopedStdioConfigPathSchema, {
				metavar: 'PATH',
				placeholder: '/tmp/tool-portal.json',
			}),
		),
		transportKind: option(
			'--transport',
			zod(toolPortalScopedStdioTransportKindSchema, {
				metavar: 'TRANSPORT',
				placeholder: 'scoped-stdio',
			}),
		),
	}),
	({ kind, scopedStdioConfigPath }) => ({ kind, scopedStdioConfigPath }),
);

const toolPortalTransportParser = or(
	toolPortalHttpTransportParser,
	toolPortalScopedStdioTransportParser,
);

function createInputJsonOption(): Parser<'sync', z.infer<typeof toolPortalInputJsonSchema>> {
	return option(
		'--input-json',
		zod(toolPortalInputJsonSchema, { metavar: 'JSON', placeholder: '{}' }),
	);
}

const callCommandParser = command(
	'call',
	object({
		approvalTokenEnvironmentName: projectZodScalarPresence({
			parser: option(
				'--approval-token-env',
				zod(toolPortalOptionalApprovalEnvironmentNameSchema, {
					metavar: 'ENV_NAME',
					placeholder: undefined,
				}),
			),
			schema: toolPortalOptionalApprovalEnvironmentNameSchema,
		}),
		inputJson: createInputJsonOption(),
		operation: constant('call'),
		transport: toolPortalTransportParser,
	}),
);

const artifactReadCommandParser = command(
	'artifact-read',
	object({
		inputJson: createInputJsonOption(),
		operation: constant('artifact-read'),
		transport: toolPortalTransportParser,
	}),
);
const describeCommandParser = command(
	'describe',
	object({
		inputJson: createInputJsonOption(),
		operation: constant('describe'),
		transport: toolPortalTransportParser,
	}),
);
const listCommandParser = command(
	'list',
	object({
		inputJson: createInputJsonOption(),
		operation: constant('list'),
		transport: toolPortalTransportParser,
	}),
);
const searchCommandParser = command(
	'search',
	object({
		inputJson: createInputJsonOption(),
		operation: constant('search'),
		transport: toolPortalTransportParser,
	}),
);

export const toolPortalRootParser = or(
	artifactReadCommandParser,
	callCommandParser,
	describeCommandParser,
	listCommandParser,
	searchCommandParser,
);

export type ToolPortalCommand = InferValue<typeof toolPortalRootParser>;
