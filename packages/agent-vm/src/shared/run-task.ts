export interface RunTaskContext {
	readonly interactive: boolean;
	readonly setOutput: (output: string | { readonly message: string }) => void;
	readonly setStatus: (status?: string) => void;
	readonly streamPreview?: TaskOutput;
}

export interface TaskOutput {
	write(chunk: string | Uint8Array): boolean;
}

export type RunTaskFn = (
	title: string,
	fn: (context?: RunTaskContext) => Promise<void>,
) => Promise<void>;

export async function runTaskWithResult<TResult>(
	runTaskStep: RunTaskFn,
	title: string,
	fn: () => Promise<TResult>,
): Promise<TResult> {
	const noResult = Symbol(title);
	let taskResult: TResult | typeof noResult = noResult;
	await runTaskStep(title, async () => {
		taskResult = await fn();
	});
	if (taskResult === noResult) {
		throw new Error(`Task '${title}' did not produce a result.`);
	}
	return taskResult;
}
