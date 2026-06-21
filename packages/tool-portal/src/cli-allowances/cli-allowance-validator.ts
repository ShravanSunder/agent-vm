import type {
	CliAllowance,
	CliAllowanceInput,
	CliFlagRule,
} from './models/cli-allowance-schema.js';

export type CliAllowanceValidationResult =
	| {
			readonly argv: readonly string[];
			readonly ok: true;
	  }
	| {
			readonly error: {
				readonly code: string;
				readonly message: string;
			};
			readonly ok: false;
	  };

export interface ValidateCliAllowanceInvocationProps {
	readonly allowance: CliAllowance;
	readonly input: CliAllowanceInput;
}

const shellLauncherTokens = new Set(['bash', 'dash', 'fish', 'sh', 'zsh']);
const shellLikeTokenPattern = /[`$;&|<>\n\r]/u;

export function validateCliAllowanceInvocation(
	props: ValidateCliAllowanceInvocationProps,
): CliAllowanceValidationResult {
	const commandPrefixLength = matchingAllowedSubcommandLength(props);
	const shellToken = props.input.argv.find(isShellLikeToken);
	if (shellToken !== undefined) {
		return invalidCliAllowance(`CLI argv token "${shellToken}" is not allowed.`);
	}

	const deniedFlag = props.input.argv.find((token) => props.allowance.deniedFlags.includes(token));
	if (deniedFlag !== undefined) {
		return invalidCliAllowance(`CLI argv flag "${deniedFlag}" is denied by policy.`);
	}

	const deniedPattern = props.allowance.deniedPatterns.find((pattern) =>
		props.input.argv.some((token) => token.includes(pattern)),
	);
	if (deniedPattern !== undefined) {
		return invalidCliAllowance(`CLI argv matched denied pattern "${deniedPattern}".`);
	}

	if (commandPrefixLength === null) {
		return invalidCliAllowance('CLI argv does not match an allowed command family.');
	}

	const flagValidation = validateAllowedFlags({
		allowance: props.allowance,
		argv: props.input.argv,
		commandPrefixLength: commandPrefixLength ?? 0,
	});
	if (!flagValidation.ok) {
		return flagValidation;
	}

	return {
		argv: props.input.argv,
		ok: true,
	};
}

function invalidCliAllowance(message: string): CliAllowanceValidationResult {
	return {
		error: {
			code: 'cli_allowance_denied',
			message,
		},
		ok: false,
	};
}

function isShellLikeToken(token: string): boolean {
	return (
		shellLikeTokenPattern.test(token) ||
		token.includes('$(') ||
		token.includes('${') ||
		shellLauncherTokens.has(token)
	);
}

function matchingAllowedSubcommandLength(
	props: ValidateCliAllowanceInvocationProps,
): number | null {
	const matchingSubcommand = props.allowance.allowedSubcommands.find((subcommand) =>
		argvStartsWithSubcommand(props.input.argv, subcommand),
	);
	return matchingSubcommand?.length ?? null;
}

function argvStartsWithSubcommand(argv: readonly string[], subcommand: readonly string[]): boolean {
	return subcommand.every((token, index) => argv[index] === token);
}

function validateAllowedFlags(props: {
	readonly allowance: CliAllowance;
	readonly argv: readonly string[];
	readonly commandPrefixLength: number;
}): CliAllowanceValidationResult {
	let index = props.commandPrefixLength;
	while (index < props.argv.length) {
		const token = props.argv[index];
		if (token === undefined) {
			return invalidCliAllowance('CLI argv contained an empty slot.');
		}
		if (!token.startsWith('-')) {
			return invalidCliAllowance(`CLI argv positional token "${token}" is not allowed.`);
		}

		const parsedFlag = parseFlagToken(token);
		const flagRule = props.allowance.allowedFlags.find((rule) => rule.flag === parsedFlag.flag);
		if (flagRule === undefined) {
			return invalidCliAllowance(`CLI argv flag "${parsedFlag.flag}" is not allowed.`);
		}
		if (flagRule.value === 'none') {
			if (parsedFlag.inlineValue !== undefined) {
				return invalidCliAllowance(`CLI argv flag "${parsedFlag.flag}" does not accept a value.`);
			}
			index += 1;
			continue;
		}

		const valueToken = parsedFlag.inlineValue ?? props.argv[index + 1];
		if (valueToken === undefined || valueToken.startsWith('-')) {
			return invalidCliAllowance(`CLI argv flag "${parsedFlag.flag}" requires a value.`);
		}
		const valueValidation = validateFlagValue({
			flag: parsedFlag.flag,
			rule: flagRule,
			value: valueToken,
		});
		if (!valueValidation.ok) {
			return valueValidation;
		}
		index += parsedFlag.inlineValue === undefined ? 2 : 1;
	}

	return { argv: props.argv, ok: true };
}

function parseFlagToken(token: string): {
	readonly flag: string;
	readonly inlineValue?: string;
} {
	const separatorIndex = token.indexOf('=');
	if (separatorIndex === -1) {
		return { flag: token };
	}
	return {
		flag: token.slice(0, separatorIndex),
		inlineValue: token.slice(separatorIndex + 1),
	};
}

function validateFlagValue(props: {
	readonly flag: string;
	readonly rule: CliFlagRule;
	readonly value: string;
}): CliAllowanceValidationResult {
	if (props.rule.value === 'number' && !Number.isFinite(Number(props.value))) {
		return invalidCliAllowance(`CLI argv flag "${props.flag}" requires a numeric value.`);
	}
	if (props.rule.value === 'enum' && !(props.rule.allowedValues ?? []).includes(props.value)) {
		return invalidCliAllowance(`CLI argv flag "${props.flag}" received an invalid enum value.`);
	}
	if (props.rule.value === 'path' && !isSafeRelativePathValue(props.value)) {
		return invalidCliAllowance(
			`CLI argv flag "${props.flag}" requires a safe relative path value.`,
		);
	}
	if (props.rule.value === 'host' && /[/:]/u.test(props.value)) {
		return invalidCliAllowance(`CLI argv flag "${props.flag}" requires a host value.`);
	}
	return { argv: [], ok: true };
}

function isSafeRelativePathValue(value: string): boolean {
	const pathSegments = value.split('/');
	return (
		value.length > 0 &&
		!value.startsWith('/') &&
		!value.startsWith('~') &&
		!pathSegments.some((segment) => segment === '..' || segment === '')
	);
}
