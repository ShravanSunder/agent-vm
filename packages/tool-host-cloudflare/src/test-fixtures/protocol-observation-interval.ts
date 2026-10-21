/** Bounded host-protocol observation when the OS exposes no socket-close event to the test. */
export async function waitForProtocolRetryInterval(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 100);
	});
}
