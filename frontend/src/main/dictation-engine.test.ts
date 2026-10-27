// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeDictationEngine, dictationHelperPath } from "./dictation-engine";

function setup() {
	const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
	const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
	const engine = new NativeDictationEngine(process.execPath, launch as unknown as typeof spawn);
	const emit = vi.fn();
	const line = (value: unknown) => child.stdout.write(JSON.stringify(value) + "\n");
	return { child, launch, engine, emit, line };
}

afterEach(() => vi.useRealTimers());
describe("native dictation engine", () => {
	it("probes without recording or microphone access", async () => {
		const s = setup();
		const available = s.engine.availability("en-US");
		expect(s.launch).toHaveBeenCalledWith(process.execPath, ["--probe", "en-US"], { stdio: "pipe", windowsHide: true });
		s.line({ type: "recording" });
		expect(await available).toEqual({ available: true });
		expect(s.child.kill).toHaveBeenCalledOnce();
	});

	it("assembles split UTF-8 protocol lines and returns one result after stop", () => {
		const s = setup();
		s.engine.start("ja", s.emit);
		s.child.stdout.write('{"type":"record');
		s.child.stdout.write('ing"}\n');
		expect(s.emit).toHaveBeenCalledWith({ type: "recording" });
		const write = vi.spyOn(s.child.stdin, "write");
		s.engine.stop();
		expect(write).toHaveBeenCalledWith("stop\n");
		s.line({ type: "capture-stopped" });
		expect(s.child.kill).not.toHaveBeenCalled();
		expect(s.emit).toHaveBeenLastCalledWith({ type: "capture-stopped" });
		s.line({ type: "recording" }); // A late readiness event cannot reopen capture.
		expect(s.emit).toHaveBeenCalledTimes(2);
		s.line({ type: "result", text: "こんにちは" });
		s.line({ type: "result", text: "late" });
		expect(s.emit).toHaveBeenCalledTimes(3);
		expect(s.emit).toHaveBeenLastCalledWith({ type: "result", text: "こんにちは" });
		expect(s.child.kill).toHaveBeenCalledOnce();
	});

	it("cancel kills capture and ignores all subsequent output", () => {
		const s = setup();
		s.engine.start("en", s.emit);
		s.engine.cancel();
		s.line({ type: "result", text: "discard" });
		expect(s.child.kill).toHaveBeenCalledOnce();
		expect(s.emit).not.toHaveBeenCalled();
	});

	it.each(["not json\n", '{"type":"unknown"}\n', "x".repeat(65_537)])("rejects invalid or oversized output", (output) => {
		const s = setup();
		s.engine.start("en", s.emit);
		s.child.stdout.write(output);
		expect(s.emit).toHaveBeenCalledWith({ type: "error", error: "failed" });
		expect(s.child.kill).toHaveBeenCalledOnce();
	});

	it("times out startup and finalization without leaking audio processes", () => {
		vi.useFakeTimers();
		const s = setup();
		s.engine.start("en", s.emit);
		vi.advanceTimersByTime(120_000);
		expect(s.emit).toHaveBeenCalledWith({ type: "error", error: "timeout" });
		const t = setup();
		t.engine.start("en", t.emit);
		t.line({ type: "recording" });
		t.engine.stop();
		vi.advanceTimersByTime(10_000);
		expect(t.emit).toHaveBeenCalledWith({ type: "error", error: "timeout" });
		expect(t.child.kill).toHaveBeenCalledOnce();
	});

	it("surfaces missing engines and process failures without raw error details", async () => {
		expect(await new NativeDictationEngine(undefined).availability("en")).toEqual({ available: false, error: "unsupported" });
		expect(await new NativeDictationEngine("/missing/ao-dictation").availability("en")).toEqual({ available: false, error: "unavailable" });
		const s = setup();
		s.engine.start("en", s.emit);
		s.child.emit("error", new Error("private path"));
		expect(s.emit).toHaveBeenCalledWith({ type: "error", error: "unavailable" });
		expect(dictationHelperPath("linux", "/resources")).toBeUndefined();
		expect(dictationHelperPath("win32", "/resources")).toMatch(/ao-dictation.exe$/);
	});
});
