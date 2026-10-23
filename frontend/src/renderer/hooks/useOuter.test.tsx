import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OuterResult } from "../../shared/outer-native";
import { aoBridge } from "../lib/bridge";
import { useOuterNativeAction } from "./useOuter";

describe("exact native action staging", () => {
	let listeners: Set<(result: OuterResult) => void>;
	beforeEach(() => {
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
					{ operation: "send", sessionId: "outer", text },
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
				{ operation: "send", sessionId: "outer", text: "exact" },
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
});
