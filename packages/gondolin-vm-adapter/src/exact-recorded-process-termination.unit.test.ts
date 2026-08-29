import type { ManagedVmHostProcessIdentity } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import {
	terminateExactRecordedManagedVmHostProcess,
	type GondolinHostProcessIdentity,
	type GondolinProcessTerminationDependencies,
} from './exact-recorded-process-termination.js';

const recordedIdentity = {
	command: '/usr/local/bin/qemu-system-aarch64 -name tool-vm',
	hostProcessId: 48_282,
	processStartIdentity: 'Sat Jul 18 10:00:00 2026',
	vmId: 'tool-vm-1',
} satisfies ManagedVmHostProcessIdentity;

function observedIdentity(
	overrides: Partial<GondolinHostProcessIdentity> = {},
): GondolinHostProcessIdentity {
	return {
		command: recordedIdentity.command,
		processState: 'S',
		processStartIdentity: recordedIdentity.processStartIdentity,
		...overrides,
	};
}

function createDependencies(
	readProcessIdentity: GondolinProcessTerminationDependencies['readProcessIdentity'],
): GondolinProcessTerminationDependencies {
	let currentTimeMs = 0;
	return {
		now: () => currentTimeMs,
		readProcessIdentity,
		sendSignal: vi.fn(),
		sleep: vi.fn(async (delayMs: number): Promise<void> => {
			currentTimeMs += delayMs;
		}),
	};
}

describe('Gondolin exact recorded process termination', () => {
	it('treats a confirmed absent recorded process as already absent without signaling', async () => {
		const dependencies = createDependencies(vi.fn(async () => null));

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'already-absent' });
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('treats an absent stale unmanaged record as already absent without signaling', async () => {
		const dependencies = createDependencies(vi.fn(async () => null));

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: { ...recordedIdentity, command: 'node stale-record.js' },
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'already-absent' });
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('terminates the exact recorded identity with SIGTERM when it exits in the grace period', async () => {
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () => (signalSent ? null : observedIdentity())),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('treats an initial same-incarnation Darwin zombie as already absent', async () => {
		const dependencies = createDependencies(
			vi.fn(async () =>
				observedIdentity({
					command: '(qemu-system-aarc)',
					processState: 'Z+',
				}),
			),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'already-absent' });
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('treats the exact process becoming a Darwin zombie after SIGTERM as terminated', async () => {
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () =>
				signalSent
					? observedIdentity({ command: '(qemu-system-aarc)', processState: 'Z' })
					: observedIdentity(),
			),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('keeps polling a same-incarnation Darwin exiting process until it is absent', async () => {
		let observationCount = 0;
		const dependencies = createDependencies(
			vi.fn(async () => {
				observationCount += 1;
				if (observationCount === 1) {
					return observedIdentity({ processState: 'S+' });
				}
				if (observationCount === 2) {
					return observedIdentity({
						command: '(qemu-system-aarc)',
						processState: '?E+',
					});
				}
				return null;
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('escalates a persistent same-incarnation Darwin exiting process to SIGKILL', async () => {
		let lastSignal: NodeJS.Signals | undefined;
		const dependencies = createDependencies(
			vi.fn(async () => {
				if (lastSignal === undefined) {
					return observedIdentity({ processState: 'S+' });
				}
				if (lastSignal === 'SIGKILL') {
					return null;
				}
				return observedIdentity({
					command: '(qemu-system-aarc)',
					processState: '?E+',
				});
			}),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation((_processId, signal) => {
			lastSignal = signal;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(2, 48_282, 'SIGKILL');
	});

	it('keeps polling a same-incarnation Darwin uninterruptible process until it is absent', async () => {
		let observationCount = 0;
		const dependencies = createDependencies(
			vi.fn(async () => {
				observationCount += 1;
				if (observationCount === 1) {
					return observedIdentity({ processState: 'S+' });
				}
				if (observationCount === 2) {
					return observedIdentity({
						command: '(qemu-system-aarc)',
						processState: 'U',
					});
				}
				return null;
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('accepts an exact short Darwin fallback command after SIGTERM', async () => {
		const krunIdentity = {
			...recordedIdentity,
			command: '/usr/local/bin/krun --config tool-vm.json',
		} satisfies ManagedVmHostProcessIdentity;
		let observationCount = 0;
		const dependencies = createDependencies(
			vi.fn(async () => {
				observationCount += 1;
				if (observationCount === 1) {
					return observedIdentity({ command: krunIdentity.command, processState: 'S+' });
				}
				if (observationCount === 2) {
					return observedIdentity({ command: '(krun)', processState: 'U' });
				}
				return null;
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: krunIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('keeps polling the exact Linux task-name fallback after SIGTERM', async () => {
		const linuxQemuIdentity = {
			...recordedIdentity,
			command: 'qemu-system-x86_64 -name tool-vm',
		} satisfies ManagedVmHostProcessIdentity;
		let observationCount = 0;
		const dependencies = createDependencies(
			vi.fn(async () => {
				observationCount += 1;
				if (observationCount === 1) {
					return observedIdentity({ command: linuxQemuIdentity.command, processState: 'S' });
				}
				if (observationCount === 2) {
					return observedIdentity({ command: '[qemu-system-x86]', processState: 'R' });
				}
				return null;
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: linuxQemuIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('keeps polling the exact Linux task-name fallback in uninterruptible sleep after SIGTERM', async () => {
		const linuxQemuIdentity = {
			...recordedIdentity,
			command: 'qemu-system-x86_64 -name tool-vm',
		} satisfies ManagedVmHostProcessIdentity;
		let observationCount = 0;
		const dependencies = createDependencies(
			vi.fn(async () => {
				observationCount += 1;
				if (observationCount === 1) {
					return observedIdentity({ command: linuxQemuIdentity.command, processState: 'S' });
				}
				if (observationCount === 2) {
					return observedIdentity({ command: '[qemu-system-x86]', processState: 'D' });
				}
				return null;
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: linuxQemuIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('never authorizes SIGKILL from a persistent Linux task-name fallback', async () => {
		const linuxQemuIdentity = {
			...recordedIdentity,
			command: 'qemu-system-x86_64 -name tool-vm',
		} satisfies ManagedVmHostProcessIdentity;
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () =>
				signalSent
					? observedIdentity({ command: '[qemu-system-x86]', processState: 'D' })
					: observedIdentity({ command: linuxQemuIdentity.command, processState: 'S' }),
			),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: linuxQemuIdentity,
			}),
		).rejects.toThrow(/unable to prove exact identity after SIGTERM/iu);
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it.each(['R', 'U'])(
		'never restores SIGKILL authority when a Linux task-name fallback changes from D to %s',
		async (laterProcessState) => {
			const linuxQemuIdentity = {
				...recordedIdentity,
				command: 'qemu-system-x86_64 -name tool-vm',
			} satisfies ManagedVmHostProcessIdentity;
			let observationCount = 0;
			const dependencies = createDependencies(
				vi.fn(async () => {
					observationCount += 1;
					if (observationCount === 1) {
						return observedIdentity({
							command: linuxQemuIdentity.command,
							processState: 'S',
						});
					}
					return observedIdentity({
						command: '[qemu-system-x86]',
						processState: observationCount === 2 ? 'D' : laterProcessState,
					});
				}),
			);

			await expect(
				terminateExactRecordedManagedVmHostProcess({
					contextLabel: 'lease predecessor',
					dependencies,
					identity: linuxQemuIdentity,
				}),
			).rejects.toThrow(/unable to prove exact identity after SIGTERM/iu);
			expect(dependencies.sendSignal).toHaveBeenCalledOnce();
			expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
		},
	);

	it('fails closed on an unrelated Linux task-name fallback after SIGTERM', async () => {
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () =>
				signalSent
					? observedIdentity({ command: '[unrelated-task]', processState: 'R' })
					: observedIdentity({ processState: 'S' }),
			),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*command changed/iu);
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('fails closed on an unrelated Linux task-name fallback in uninterruptible sleep', async () => {
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () =>
				signalSent
					? observedIdentity({ command: '[unrelated-task]', processState: 'D' })
					: observedIdentity({ processState: 'S' }),
			),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*command changed/iu);
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it.each(['U', 'R+'])(
		'escalates a persistent same-incarnation Darwin fallback process in state %s to SIGKILL',
		async (processState) => {
			let lastSignal: NodeJS.Signals | undefined;
			const dependencies = createDependencies(
				vi.fn(async () => {
					if (lastSignal === undefined) {
						return observedIdentity({ processState: 'S+' });
					}
					if (lastSignal === 'SIGKILL') {
						return null;
					}
					return observedIdentity({
						command: '(qemu-system-aarc)',
						processState,
					});
				}),
			);
			vi.mocked(dependencies.sendSignal).mockImplementation((_processId, signal) => {
				lastSignal = signal;
			});

			await expect(
				terminateExactRecordedManagedVmHostProcess({
					contextLabel: 'lease predecessor',
					dependencies,
					identity: recordedIdentity,
				}),
			).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
			expect(dependencies.sendSignal).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
			expect(dependencies.sendSignal).toHaveBeenNthCalledWith(2, 48_282, 'SIGKILL');
		},
	);

	it('refuses an initially observed Darwin uninterruptible process with changed command', async () => {
		const dependencies = createDependencies(
			vi.fn(async () =>
				observedIdentity({
					command: '(qemu-system-aarc)',
					processState: 'U',
				}),
			),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*state "U".*command changed/iu);
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('refuses an initially observed Linux task-name fallback in uninterruptible sleep', async () => {
		const dependencies = createDependencies(
			vi.fn(async () =>
				observedIdentity({
					command: '[qemu-system-aar]',
					processState: 'D',
				}),
			),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*state "D".*command changed/iu);
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it.each(['U', 'R+'])(
		'fails closed on post-SIGTERM state %s for an unrelated fallback command',
		async (processState) => {
			let signalSent = false;
			const dependencies = createDependencies(
				vi.fn(async () =>
					signalSent
						? observedIdentity({ command: '(unrelated-proces)', processState })
						: observedIdentity({ processState: 'S+' }),
				),
			);
			vi.mocked(dependencies.sendSignal).mockImplementation(() => {
				signalSent = true;
			});

			await expect(
				terminateExactRecordedManagedVmHostProcess({
					contextLabel: 'lease predecessor',
					dependencies,
					identity: recordedIdentity,
				}),
			).rejects.toThrow(/same process start identity.*command changed/iu);
			expect(dependencies.sendSignal).toHaveBeenCalledOnce();
			expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
		},
	);

	it('refuses an initially observed Darwin exiting process with changed command', async () => {
		const dependencies = createDependencies(
			vi.fn(async () =>
				observedIdentity({
					command: '(qemu-system-aarc)',
					processState: '?E+',
				}),
			),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*state "\?E\+".*command changed/iu);
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it.each(['?X+', 'S+'])(
		'fails closed on post-SIGTERM same-start command drift in state %s',
		async (processState) => {
			let signalSent = false;
			const dependencies = createDependencies(
				vi.fn(async () =>
					signalSent
						? observedIdentity({ command: '(qemu-system-aarc)', processState })
						: observedIdentity({ processState: 'S+' }),
				),
			);
			vi.mocked(dependencies.sendSignal).mockImplementation(() => {
				signalSent = true;
			});

			await expect(
				terminateExactRecordedManagedVmHostProcess({
					contextLabel: 'lease predecessor',
					dependencies,
					identity: recordedIdentity,
				}),
			).rejects.toThrow(/same process start identity.*command changed/iu);
			expect(dependencies.sendSignal).toHaveBeenCalledOnce();
			expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
		},
	);

	it('treats post-SIGTERM pid reuse as absence before inspecting the exiting state', async () => {
		let signalSent = false;
		const dependencies = createDependencies(
			vi.fn(async () =>
				signalSent
					? observedIdentity({
							command: '(qemu-system-aarc)',
							processStartIdentity: 'Sat Jul 18 10:05:00 2026',
							processState: '?E+',
						})
					: observedIdentity({ processState: 'S+' }),
			),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation(() => {
			signalSent = true;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenCalledOnce();
		expect(dependencies.sendSignal).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});

	it('refuses a changed command for the same recorded process start', async () => {
		const dependencies = createDependencies(
			vi.fn(async () => observedIdentity({ command: 'node unrelated-process.js' })),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/same process start identity.*command changed/iu);
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it.each(['X', '?', 'R+'])(
		'refuses a changed command for same-start non-zombie process state %s',
		async (processState) => {
			const dependencies = createDependencies(
				vi.fn(async () => observedIdentity({ command: '(qemu-system-aarc)', processState })),
			);

			await expect(
				terminateExactRecordedManagedVmHostProcess({
					contextLabel: 'lease predecessor',
					dependencies,
					identity: recordedIdentity,
				}),
			).rejects.toThrow(/same process start identity.*command changed/iu);
			expect(dependencies.sendSignal).not.toHaveBeenCalled();
		},
	);

	it('treats a reused pid with a different process start as predecessor absence', async () => {
		const dependencies = createDependencies(
			vi.fn(async () => observedIdentity({ processStartIdentity: 'Sat Jul 18 10:05:00 2026' })),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'already-absent' });
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('treats a reused pid as predecessor absence before stale command admissibility', async () => {
		const dependencies = createDependencies(
			vi.fn(async () =>
				observedIdentity({
					command: 'node current-reused-process.js',
					processStartIdentity: 'Sat Jul 18 10:05:00 2026',
				}),
			),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: { ...recordedIdentity, command: 'node stale-record.js' },
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'already-absent' });
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});

	it('revalidates the exact identity and escalates to SIGKILL after the TERM bound', async () => {
		let lastSignal: NodeJS.Signals | undefined;
		const dependencies = createDependencies(
			vi.fn(async () => (lastSignal === 'SIGKILL' ? null : observedIdentity())),
		);
		vi.mocked(dependencies.sendSignal).mockImplementation((_processId, signal) => {
			lastSignal = signal;
		});

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).resolves.toEqual({ hostProcessId: 48_282, kind: 'terminated' });
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(2, 48_282, 'SIGKILL');
	});

	it('fails closed when the exact recorded process survives TERM and KILL', async () => {
		const dependencies = createDependencies(vi.fn(async () => observedIdentity()));

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow(/failed to terminate exact recorded managed VM process/iu);
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
		expect(dependencies.sendSignal).toHaveBeenNthCalledWith(2, 48_282, 'SIGKILL');
	});

	it('fails closed when current process identity cannot be confirmed', async () => {
		const dependencies = createDependencies(
			vi.fn(async () => {
				throw new Error('process identity output was malformed');
			}),
		);

		await expect(
			terminateExactRecordedManagedVmHostProcess({
				contextLabel: 'lease predecessor',
				dependencies,
				identity: recordedIdentity,
			}),
		).rejects.toThrow('process identity output was malformed');
		expect(dependencies.sendSignal).not.toHaveBeenCalled();
	});
});
