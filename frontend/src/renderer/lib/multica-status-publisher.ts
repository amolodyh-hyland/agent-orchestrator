export type LatestWinsPublisher<T> = {
	set: (snapshot: T) => void;
	dispose: () => void;
};

export function createLatestWinsPublisher<T>(options: {
	publish: (snapshot: T) => Promise<{ ok: boolean }>;
	delayMs: number;
	initialAcceptedKey?: string;
}): LatestWinsPublisher<T> {
	let desired: { key: string; snapshot: T } | null = null;
	let accepted: string | null = options.initialAcceptedKey ?? null;
	let inFlight = false;
	let failedKey: string | null = null;
	let ready = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	const pump = () => {
		if (disposed || inFlight || !ready || desired === null || desired.key === accepted || desired.key === failedKey) return;

		inFlight = true;
		const sent = desired;
		const settle = (succeeded: boolean) => {
			inFlight = false;
			if (disposed) return;

			if (succeeded) {
				accepted = sent.key;
				failedKey = null;
			} else {
				failedKey = sent.key;
			}

			pump();
		};

		try {
			void Promise.resolve(options.publish(sent.snapshot)).then(
				(result) => settle(result?.ok === true),
				() => settle(false),
			);
		} catch {
			settle(false);
		}
	};

	return {
		set(snapshot) {
			if (disposed) return;

			desired = { key: JSON.stringify(snapshot), snapshot };
			failedKey = null;
			ready = false;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				ready = true;
				pump();
			}, options.delayMs);
		},
		dispose() {
			disposed = true;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
		},
	};
}
