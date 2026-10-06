import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaLinkStatusEntry } from "../../shared/multica-session-status";
import { createLatestWinsPublisher } from "./multica-status-publisher";

type TestSnapshot = { stale: boolean; entries: MulticaLinkStatusEntry[] };
type PublishResult = { ok: boolean };

function snapshot(label: string, stale = false): TestSnapshot {
	return { stale, entries: [{ sessionId: "s1", tone: "working", label, detail: "" }] };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("createLatestWinsPublisher", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for the debounce window", async () => {
		const a = snapshot("A");
		const publish = vi.fn().mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(a);
		await vi.advanceTimersByTimeAsync(149);
		expect(publish).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(publish).toHaveBeenCalledExactlyOnceWith(a);
	});

	it("collapses snapshots set inside the debounce window", async () => {
		const a = snapshot("A");
		const b = snapshot("B");
		const c = snapshot("C");
		const publish = vi.fn().mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(a);
		await vi.advanceTimersByTimeAsync(50);
		publisher.set(b);
		await vi.advanceTimersByTimeAsync(50);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(149);
		expect(publish).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(publish).toHaveBeenCalledExactlyOnceWith(c);
	});

	it("skips the initially accepted key and does not republish the last accepted key", async () => {
		const a = snapshot("A");
		const b = snapshot("B");
		const c = snapshot("C");
		const publish = vi.fn().mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({
			publish,
			delayMs: 150,
			initialAcceptedKey: JSON.stringify(a),
		});

		publisher.set(a);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish).not.toHaveBeenCalled();

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(150);

		expect(publish.mock.calls).toEqual([[b], [c]]);
	});

	it("publishes a corrective snapshot after the in-flight snapshot settles", async () => {
		const a = snapshot("A");
		const b = snapshot("B");
		const bResult = deferred<PublishResult>();
		const publish = vi.fn().mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(bResult.promise).mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(a);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(a);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish.mock.calls).toEqual([[a], [b]]);

		bResult.resolve({ ok: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(publish.mock.calls).toEqual([[a], [b], [a]]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish).toHaveBeenCalledTimes(3);
	});

	it("does not let completion bypass the newest snapshot's debounce", async () => {
		const b = snapshot("B");
		const c = snapshot("C");
		const bResult = deferred<PublishResult>();
		const publish = vi.fn().mockReturnValueOnce(bResult.promise).mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(1);
		bResult.resolve({ ok: true });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(148);
		expect(publish).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(publish.mock.calls).toEqual([[b], [c]]);
	});

	it.each(["reject", "false"] as const)("publishes the newer snapshot after an in-flight failure (%s)", async (failure) => {
		const b = snapshot("B");
		const c = snapshot("C");
		const bResult = deferred<PublishResult>();
		const publish = vi.fn().mockReturnValueOnce(bResult.promise).mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish.mock.calls).toEqual([[b]]);

		if (failure === "reject") bResult.reject(new Error("publish failed"));
		else bResult.resolve({ ok: false });
		await vi.advanceTimersByTimeAsync(0);
		expect(publish.mock.calls).toEqual([[b], [c]]);
	});

	it("does not retry the newer snapshot when it also fails", async () => {
		const b = snapshot("B");
		const c = snapshot("C");
		const bResult = deferred<PublishResult>();
		const publish = vi.fn().mockReturnValueOnce(bResult.promise).mockResolvedValueOnce({ ok: false });
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(c);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish.mock.calls).toEqual([[b]]);

		bResult.reject(new Error("publish failed"));
		await vi.advanceTimersByTimeAsync(0);
		expect(publish.mock.calls).toEqual([[b], [c]]);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish.mock.calls).toEqual([[b], [c]]);
	});

	it("does not retry failures unless set is called again", async () => {
		const b = snapshot("B");
		const c = snapshot("C");
		const publish = vi.fn().mockRejectedValue(new Error("publish failed"));
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish.mock.calls).toEqual([[b]]);

		publisher.set(c);
		await vi.advanceTimersByTimeAsync(150);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish.mock.calls).toEqual([[b], [c]]);

		publisher.set(b);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish.mock.calls).toEqual([[b], [c], [b]]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish).toHaveBeenCalledTimes(3);
	});

	it("treats a synchronous publish throw as a failure", async () => {
		const b = snapshot("B");
		const publish = vi.fn(() => {
			throw new Error("publish failed");
		});
		const publisher = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		expect(() => publisher.set(b)).not.toThrow();
		await vi.advanceTimersByTimeAsync(150);
		expect(publish).toHaveBeenCalledExactlyOnceWith(b);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it("stops publishing after disposal", async () => {
		const a = snapshot("A");
		const b = snapshot("B");
		const c = snapshot("C");
		const publish = vi.fn().mockResolvedValue({ ok: true });
		const beforeDebounce = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });

		beforeDebounce.set(a);
		beforeDebounce.dispose();
		await vi.advanceTimersByTimeAsync(150);
		expect(publish).not.toHaveBeenCalled();

		const aResult = deferred<PublishResult>();
		publish.mockReset().mockReturnValueOnce(aResult.promise).mockResolvedValue({ ok: true });
		const inFlight = createLatestWinsPublisher<TestSnapshot>({ publish, delayMs: 150 });
		inFlight.set(a);
		await vi.advanceTimersByTimeAsync(150);
		inFlight.set(b);
		inFlight.dispose();
		inFlight.set(c);
		aResult.resolve({ ok: true });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(publish.mock.calls).toEqual([[a]]);
	});

	it("publishes the empty snapshot after state returns to empty during the first publish", async () => {
		const empty = { stale: false, entries: [] } satisfies TestSnapshot;
		const nonEmpty = snapshot("Linked");
		const firstResult = deferred<PublishResult>();
		const publish = vi.fn().mockReturnValueOnce(firstResult.promise).mockResolvedValue({ ok: true });
		const publisher = createLatestWinsPublisher<TestSnapshot>({
			publish,
			delayMs: 150,
			initialAcceptedKey: JSON.stringify(empty),
		});

		publisher.set(nonEmpty);
		await vi.advanceTimersByTimeAsync(150);
		publisher.set(empty);
		await vi.advanceTimersByTimeAsync(150);
		expect(publish.mock.calls).toEqual([[nonEmpty]]);

		firstResult.resolve({ ok: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(publish.mock.calls).toEqual([[nonEmpty], [empty]]);
	});
});
