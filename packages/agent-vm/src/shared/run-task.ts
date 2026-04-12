export type RunTaskFn = (title: string, fn: () => Promise<void>) => Promise<void>;

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
