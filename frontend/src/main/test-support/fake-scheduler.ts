import type { Scheduler } from "../multica-read-client";

export type FakeScheduler = Scheduler & {
	/** Moves the clock forward, firing due timers in order and letting promises settle between them. */
	advance: (ms: number) => Promise<void>;
	pending: () => number;
	setNow: (ms: number) => void;
};

export function createFakeScheduler(start = 1_000_000): FakeScheduler {
	let current = start;
	let sequence = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();

	const settle = async (): Promise<void> => {
		for (let index = 0; index < 20; index += 1) await Promise.resolve();
	};

	return {
		now: () => current,
		setTimeout: (callback, delayMs) => {
			sequence += 1;
			timers.set(sequence, { at: current + Math.max(0, delayMs), callback });
			return sequence;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		pending: () => timers.size,
		setNow: (ms) => {
			current = ms;
		},
		advance: async (ms) => {
			const target = current + ms;
			await settle();
			for (;;) {
				let nextKey: number | null = null;
				let nextAt = Number.POSITIVE_INFINITY;
				for (const [key, timer] of timers) {
					if (timer.at <= target && timer.at < nextAt) {
						nextKey = key;
						nextAt = timer.at;
					}
				}
				if (nextKey === null) break;
				const timer = timers.get(nextKey)!;
				timers.delete(nextKey);
				current = Math.max(current, timer.at);
				timer.callback();
				await settle();
			}
			current = target;
			await settle();
		},
	};
}
