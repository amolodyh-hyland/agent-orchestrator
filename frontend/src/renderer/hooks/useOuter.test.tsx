import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OuterResult } from "../../shared/outer-native";
import { aoBridge } from "../lib/bridge";
import { useOuterNativeAction } from "./useOuter";

describe("exact native action staging", () => {
	let listeners: Set<(result: OuterResult) => void>;
	beforeEach(() => {
		vi.clearAllMocks();
		listeners = new Set();
		vi.mocked(aoBridge.outer.onResult).mockImplementation((listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		});
		vi.mocked(aoBridge.outer.stage).mockImplementation(
			async (_slot, draft) => ({
				id: draft.operation === "send" ? draft.text : "control",
				digest: "digest",
				expiresAt: Date.now() + 120_000,
			})
		);
	});

	it("replaces staged text and ignores a delayed result for the old draft", async () => {
		const completed = vi.fn();
		let resolveNew!: (stage: {
			id: string;
			digest: string;
			expiresAt: number;
		}) => void;
		const hook = renderHook(
			({ text }) =>
				useOuterNativeAction(
					{
						operation: "send",
						expected: {
							bindingRevision: 1,
							scopeRevision: 1,
							controllerGeneration: "generation-1",
							settingsDigest: "a".repeat(64),
						},
						sessionId: "outer",
						text,
					},
					completed
				),
			{ initialProps: { text: "first" } }
		);
		await waitFor(() => expect(hook.result.current.ready).toBe(true));
		vi.mocked(aoBridge.outer.stage).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveNew = resolve;
				})
		);
		hook.rerender({ text: "second" });
		expect(hook.result.current.ready).toBe(false);
		act(() => {
			for (const listener of listeners)
				listener({ id: "first", ok: true, uncertain: false });
		});
		expect(completed).not.toHaveBeenCalled();
		await act(async () => {
			resolveNew({
				id: "second",
				digest: "second-digest",
				expiresAt: Date.now() + 120_000,
			});
		});
		await waitFor(() =>
			expect(hook.result.current.attributes["data-outer-stage-id"]).toBe(
				"second"
			)
		);
		act(() => {
			for (const listener of listeners)
				listener({ id: "second", ok: true, uncertain: false });
		});
		expect(completed).toHaveBeenCalledOnce();
		expect(hook.result.current.ready).toBe(false);
	});

	it("holds when native staging is unavailable and exposes no submit method", async () => {
		vi.mocked(aoBridge.outer.stage).mockRejectedValue(
			new Error("desktop unavailable")
		);
		const completed = vi.fn();
		const hook = renderHook(() =>
			useOuterNativeAction(
				{
					operation: "send",
					expected: {
						bindingRevision: 1,
						scopeRevision: 1,
						controllerGeneration: "generation-1",
						settingsDigest: "a".repeat(64),
					},
					sessionId: "outer",
					text: "exact",
				},
				completed
			)
		);
		await act(async () => {});
		expect(hook.result.current.ready).toBe(false);
		expect(Object.keys(hook.result.current).sort()).toEqual([
			"attributes",
			"ready",
			"result",
		]);
		expect(completed).not.toHaveBeenCalled();
	});

	it("renews an idle draft without submitting and retains a result arriving across renewal", async () => {
		vi.useFakeTimers();
		try {
			let sequence = 0;
			vi.mocked(aoBridge.outer.stage).mockImplementation(async () => ({
				id: `stage-${++sequence}`,
				digest: "exact",
				expiresAt: Date.now() + 120_000,
			}));
			const completed = vi.fn();
			const hook = renderHook(() =>
				useOuterNativeAction(
					{
						operation: "send",
						sessionId: "outer",
						text: "long-lived draft",
						expected: {
							bindingRevision: 1,
							scopeRevision: 1,
							controllerGeneration: "generation-1",
							settingsDigest: "a".repeat(64),
						},
					},
					completed
				)
			);
			await act(async () => {});
			expect(hook.result.current.attributes["data-outer-stage-id"]).toBe(
				"stage-1"
			);
			await act(async () => {
				vi.advanceTimersByTime(120_001);
			});
			expect(hook.result.current.attributes["data-outer-stage-id"]).toBe(
				"stage-2"
			);
			expect(completed).not.toHaveBeenCalled();
			act(() => {
				for (const listener of listeners)
					listener({ id: "stage-1", ok: true, uncertain: false });
			});
			expect(completed).toHaveBeenCalledOnce();
			hook.unmount();
		} finally {
			vi.useRealTimers();
		}
	});
});
