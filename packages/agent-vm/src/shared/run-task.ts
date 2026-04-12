export type RunTaskFn = (title: string, fn: () => Promise<void>) => Promise<void>;
