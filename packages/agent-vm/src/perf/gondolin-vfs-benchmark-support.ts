export interface BenchmarkSampleTiming {
	readonly largeWriteMs: number;
	readonly smallReadMs: number;
	readonly smallWriteMs: number;
}

export interface BenchmarkSampleSummary {
	readonly largeWriteMs: number;
	readonly largeWriteMsMax: number;
	readonly largeWriteMsMin: number;
	readonly smallReadMs: number;
	readonly smallReadMsMax: number;
	readonly smallReadMsMin: number;
	readonly smallWriteMs: number;
	readonly smallWriteMsMax: number;
	readonly smallWriteMsMin: number;
}

export function summarizeBenchmarkSamples(
	samples: readonly BenchmarkSampleTiming[],
): BenchmarkSampleSummary {
	if (samples.length === 0) {
		throw new Error('Cannot summarize benchmark timings without at least one sample.');
	}

	return {
		largeWriteMs: summarizeValues(samples.map((sample) => sample.largeWriteMs)).median,
		largeWriteMsMax: summarizeValues(samples.map((sample) => sample.largeWriteMs)).max,
		largeWriteMsMin: summarizeValues(samples.map((sample) => sample.largeWriteMs)).min,
		smallReadMs: summarizeValues(samples.map((sample) => sample.smallReadMs)).median,
		smallReadMsMax: summarizeValues(samples.map((sample) => sample.smallReadMs)).max,
		smallReadMsMin: summarizeValues(samples.map((sample) => sample.smallReadMs)).min,
		smallWriteMs: summarizeValues(samples.map((sample) => sample.smallWriteMs)).median,
		smallWriteMsMax: summarizeValues(samples.map((sample) => sample.smallWriteMs)).max,
		smallWriteMsMin: summarizeValues(samples.map((sample) => sample.smallWriteMs)).min,
	};
}

export function formatDurationRange(props: {
	readonly max: number;
	readonly median: number;
	readonly min: number;
}): string {
	const median = Math.round(props.median);
	const min = Math.round(props.min);
	const max = Math.round(props.max);
	if (median === min && median === max) {
		return `${median}ms`;
	}
	return `${median}ms median [${min}-${max}ms]`;
}

export function assertExpectedMountToken(props: {
	readonly label: string;
	readonly mountInfo: string;
	readonly token: string | null;
}): void {
	if (props.token === null || props.mountInfo.includes(props.token)) {
		return;
	}
	throw new Error(
		`Expected mount for '${props.label}' to include '${props.token}', got: ${props.mountInfo}`,
	);
}

function summarizeValues(values: readonly number[]): {
	readonly max: number;
	readonly median: number;
	readonly min: number;
} {
	if (values.length === 0) {
		throw new Error('Cannot summarize an empty value list.');
	}
	const sortedValues = values.toSorted((left, right) => left - right);
	const medianIndex = Math.floor(sortedValues.length / 2);
	const min = sortedValues[0];
	const median = sortedValues[medianIndex];
	const max = sortedValues[sortedValues.length - 1];
	if (min === undefined || median === undefined || max === undefined) {
		throw new Error('Cannot summarize an empty value list.');
	}
	return {
		max,
		median,
		min,
	};
}
