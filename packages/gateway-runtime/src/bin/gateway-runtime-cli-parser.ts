import path from 'node:path';

import {
	constant,
	type InferValue,
	type Mode,
	object,
	option,
	optional,
	type Parser,
	withDefault,
} from '@optique/core';
import { zod } from '@optique/zod';
import { z } from 'zod';

const gatewayRuntimeConfigPathSchema = z
	.string()
	.refine(path.isAbsolute, { message: 'Gateway Runtime config path must be absolute.' })
	.refine((configPath): boolean => !configPath.includes('\0'), {
		message: 'Gateway Runtime config path must contain no NUL bytes.',
	});

export function projectZodScalarPresence<
	TSchema extends z.ZodType,
	TMode extends Mode,
	TParserState,
>(
	schema: TSchema,
	parser: Parser<TMode, z.infer<TSchema>, TParserState>,
): Parser<TMode, z.infer<TSchema>>;
export function projectZodScalarPresence(schema: z.ZodType, parser: Parser<Mode>): Parser<Mode> {
	if (schema instanceof z.ZodOptional) {
		if (schema.unwrap() instanceof z.ZodDefault) {
			throw new TypeError('CLI value schemas must not mix ZodOptional and ZodDefault.');
		}
		return optional(parser);
	}
	if (schema instanceof z.ZodDefault) {
		if (schema.unwrap() instanceof z.ZodOptional) {
			throw new TypeError('CLI value schemas must not mix ZodOptional and ZodDefault.');
		}
		return withDefault(parser, schema.parse(undefined));
	}
	return parser;
}

export const gatewayRuntimeRootParser = object({
	command: constant('start'),
	configPath: projectZodScalarPresence(
		gatewayRuntimeConfigPathSchema,
		option(
			'--config',
			zod(gatewayRuntimeConfigPathSchema, {
				metavar: 'PATH',
				placeholder: '/tmp/gateway-runtime.json',
			}),
		),
	),
});

export type GatewayRuntimeCommand = InferValue<typeof gatewayRuntimeRootParser>;
