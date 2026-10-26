import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { dictationLocale, parseDictationEvent, type DictationAvailability, type DictationEngine, type DictationEvent } from "../shared/dictation";

export function dictationHelperPath(platform: NodeJS.Platform, root: string): string | undefined {
	if (platform !== "darwin" && platform !== "win32") return undefined;
	return path.join(root, "dictation-helper", platform === "win32" ? "ao-dictation.exe" : "ao-dictation");
}

export class NativeDictationEngine implements DictationEngine {
	private child?: ChildProcessWithoutNullStreams;
	private emit?: (event: DictationEvent) => void;
	private timer?: ReturnType<typeof setTimeout>;
	private stopping = false;

	constructor(private readonly binary: string | undefined, private readonly launch = spawn) {}

	async availability(locale: string): Promise<DictationAvailability> {
		if (!this.binary) return { available: false, error: "unsupported" };
		if (!existsSync(this.binary) || !dictationLocale(locale)) return { available: false, error: "unavailable" };
		return new Promise((resolve) => {
			const probe = new NativeDictationEngine(this.binary, this.launch);
			probe.run("--probe", locale, (event) => {
				probe.cancel();
				resolve(event.type === "recording" ? { available: true } : { available: false, error: event.type === "error" ? event.error : "unavailable" });
			}, 10_000);
		});
	}

	start(locale: string, emit: (event: DictationEvent) => void): void {
		this.run("--record", locale, emit, 120_000);
	}

	private run(mode: string, locale: string, emit: (event: DictationEvent) => void, timeout: number): void {
		if (this.child) { emit({ type: "error", error: "busy" }); return; }
		if (!this.binary || !dictationLocale(locale)) { emit({ type: "error", error: "unavailable" }); return; }
		this.emit = emit;
		this.stopping = false;
		let child: ChildProcessWithoutNullStreams;
		try {
			child = this.launch(this.binary, [mode, locale], { stdio: "pipe", windowsHide: true });
		} catch { this.finish({ type: "error", error: "unavailable" }); return; }
		this.child = child;
		this.arm(timeout);
		let buffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (this.child !== child) return;
			buffer += chunk;
			if (buffer.length > 65_536) { this.finish({ type: "error", error: "failed" }); return; }
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0 && this.child === child) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let event: DictationEvent | undefined;
				try { event = parseDictationEvent(JSON.parse(line)); } catch { event = undefined; }
				if (!event) { this.finish({ type: "error", error: "failed" }); return; }
				if (event.type === "recording") {
					if (this.stopping) continue;
					if (mode === "--record") this.arm(70_000);
					this.emit?.(event);
				} else this.finish(event);
			}
		});
		child.stderr.resume();
		child.stdin.on("error", () => {
			if (this.child === child) this.finish({ type: "error", error: "failed" });
		});
		child.on("error", () => {
			if (this.child === child) this.finish({ type: "error", error: "unavailable" });
		});
		child.on("close", () => {
			if (this.child === child) this.finish({ type: "error", error: "failed" });
		});
	}

	stop(): void {
		if (!this.child || this.stopping) return;
		this.stopping = true;
		this.child.stdin.write("stop\n");
		this.arm(10_000);
	}

	cancel(): void {
		const child = this.child;
		this.child = undefined;
		this.emit = undefined;
		clearTimeout(this.timer);
		child?.kill();
	}

	private arm(timeout: number): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.finish({ type: "error", error: "timeout" }), timeout);
	}

	private finish(event: DictationEvent): void {
		const emit = this.emit;
		this.cancel();
		emit?.(event);
	}
}
