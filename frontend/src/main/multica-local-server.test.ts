import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaCheckResult, MulticaSettings } from "../shared/multica";
import type { LocalServerStatus } from "../shared/multica-local-server";
import { createMulticaLocalServer, type MulticaLocalServer, type MulticaLocalServerOptions } from "./multica-local-server";
import type { ExecError, ExecFileLike } from "./multica-local-server-commands";
import type { SetupOutcome, StackCheck } from "./multica-local-server-stack";
import { STARTING_GRACE_MS } from "./multica-local-server-state";

const DOCKER = "/usr/local/bin/docker";
const HOME = "/Users/me";
const DIR = "/Users/me/.multica/server";
const FILE = `${DIR}/docker-compose.selfhost.yml`;
const LOCAL: MulticaSettings = { mode: "local", customUrl: "http://localhost:3000", apiUrl: "" };

type Reply = { error?: Partial<ExecError> & { message?: string }; stdout?: string; stderr?: string };

const ndjson = (rows: Array<Record<string, unknown>>) => rows.map((row) => JSON.stringify(row)).join("\n");
const row = (service: string, state = "running", extra: Record<string, unknown> = {}) => ({ Service: service, State: state, Health: "", ExitCode: 0, ...extra });
const ALL_UP = ndjson([
	row("postgres", "running", { Health: "healthy" }),
	row("backend", "running", { Publishers: [{ TargetPort: 8080, PublishedPort: 8080 }] }),
	row("frontend", "running", { Publishers: [{ TargetPort: 3000, PublishedPort: 3000 }] }),
]);

type Fake = {
	engine: "up" | "down" | "missing";
	composePlugin: boolean;
	ps: string;
	composeList: string;
	hasEnv: boolean;
	settings: MulticaSettings;
	stackDir: string;
	validDirs: Set<string>;
	probe: MulticaCheckResult;
	platform: NodeJS.Platform;
	docker: string | null;
	handlers: Partial<Record<string, (args: string[], signal?: AbortSignal) => Promise<Reply> | Reply>>;
	now: number;
	setupOutcome: SetupOutcome;
	chosen: string | null;
};

function harness(patch: Partial<Fake> = {}) {
	const fake: Fake = {
		engine: "up",
		composePlugin: true,
		ps: "",
		composeList: "[]",
		hasEnv: true,
		settings: LOCAL,
		stackDir: "",
		validDirs: new Set([DIR]),
		probe: { ok: false, error: "unreachable" },
		platform: "darwin",
		docker: DOCKER,
		handlers: {},
		now: 1_000_000,
		setupOutcome: "created",
		chosen: null,
		...patch,
	};
	const calls: Array<{ file: string; args: string[] }> = [];
	const emitted: LocalServerStatus[] = [];
	const writes: unknown[] = [];

	const verbOf = (args: string[]): string => {
		if (args[0] === "version") return "docker-version";
		if (args[0] === "-a") return "open";
		if (args[1] === "version") return "compose-version";
		if (args[1] === "ls") return "compose-ls";
		return args[5] ?? "?";
	};

	const exec: ExecFileLike = (file, args, options, callback) => {
		calls.push({ file, args });
		const verb = verbOf(args);
		const finish = (reply: Reply) => {
			const error = reply.error ? Object.assign(new Error(reply.error.message ?? "command failed"), reply.error) : null;
			callback(error as ExecError | null, reply.stdout ?? "", reply.stderr ?? "");
		};
		const custom = fake.handlers[verb];
		if (custom) {
			const onAbort = () => finish({ error: { name: "AbortError", code: "ABORT_ERR", killed: true } });
			options.signal?.addEventListener("abort", onAbort, { once: true });
			void Promise.resolve(custom(args, options.signal)).then((reply) => {
				options.signal?.removeEventListener("abort", onAbort);
				finish(reply);
			});
			return;
		}
		if (verb === "docker-version") return finish(fake.engine === "up" ? { stdout: "27.0.0\n" } : { error: { code: 1 }, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" });
		if (verb === "compose-version") return finish(fake.composePlugin ? { stdout: "v2.29.0\n" } : { error: { code: 1 }, stderr: "docker: 'compose' is not a docker command." });
		if (verb === "compose-ls") return finish({ stdout: fake.composeList });
		if (verb === "ps") return finish({ stdout: fake.ps });
		if (verb === "open") {
			fake.engine = "up";
			return finish({});
		}
		return finish({});
	};

	const options: MulticaLocalServerOptions = {
		readServerSettings: async () => fake.settings,
		readStackSettings: async () => ({ stackDir: fake.stackDir }),
		writeStackSettings: async (settings) => {
			writes.push(settings);
			fake.stackDir = settings.stackDir;
		},
		validate: async (dir): Promise<StackCheck> => (fake.validDirs.has(dir) ? { ok: true, dir, file: `${dir}/docker-compose.selfhost.yml` } : { ok: false, error: "not_found" }),
		fileExists: async () => fake.hasEnv,
		setupEnv: async () => {
			if (fake.setupOutcome === "created") fake.hasEnv = true;
			return fake.setupOutcome;
		},
		probe: async () => fake.probe,
		chooseFolder: async () => fake.chosen,
		exec,
		emit: (status) => emitted.push(status),
		home: HOME,
		env: { PATH: "/usr/bin", HOME },
		platform: fake.platform,
		findDocker: () => fake.docker,
		now: () => fake.now,
		sleep: async (ms) => {
			fake.now += ms;
		},
	};
	const server: MulticaLocalServer = createMulticaLocalServer(options);
	const verbs = () => calls.map((call) => verbOf(call.args));
	return { fake, calls, emitted, writes, server, verbs, options };
}

const hang = () => {
	let release: (reply: Reply) => void = () => undefined;
	const promise = new Promise<Reply>((resolve) => {
		release = resolve;
	});
	return { promise, release: (reply: Reply = {}) => release(reply) };
};

describe("status", () => {
	it("is unavailable, and runs no docker command, in Cloud mode or for a non-loopback address", async () => {
		for (const [settings, reason] of [
			[{ ...LOCAL, mode: "cloud" }, "cloud"],
			[{ ...LOCAL, customUrl: "http://192.168.1.20:3000" }, "remote_url"],
			[{ ...LOCAL, customUrl: "" }, "no_url"],
		] as const) {
			const h = harness({ settings });
			const status = await h.server.getStatus();
			expect(status).toMatchObject({ state: "unavailable", unavailableReason: reason });
			expect(h.calls).toEqual([]);
		}
	});

	it("maps fake docker output to each state", async () => {
		const cases: Array<[string, Partial<Fake>, string]> = [
			["no docker binary", { docker: null }, "docker_not_installed"],
			["engine down", { engine: "down" }, "docker_not_running"],
			["no compose plugin", { composePlugin: false }, "compose_missing"],
			["no .env", { hasEnv: false }, "needs_setup"],
			["stopped", { ps: "" }, "stopped"],
			["healthy", { ps: ALL_UP, probe: { ok: true, apiUrl: "http://localhost:8080" } }, "healthy"],
			["starting", { ps: ALL_UP, probe: { ok: false, error: "unreachable" } }, "starting"],
			["backend crashed", { ps: ndjson([row("postgres"), row("backend", "exited", { ExitCode: 1 }), row("frontend")]) }, "unhealthy"],
			["Multica from elsewhere", { ps: "", probe: { ok: true, apiUrl: "http://localhost:8080" } }, "running_elsewhere"],
			["port taken by another server", { ps: "", probe: { ok: false, error: "not_multica" } }, "port_conflict"],
			["older Compose (JSON array)", { ps: JSON.stringify([row("postgres"), row("backend"), row("frontend")]), probe: { ok: true, apiUrl: "" } }, "healthy"],
		];
		for (const [name, patch, state] of cases) {
			const status = await harness(patch).server.getStatus();
			expect(status.state, name).toBe(state);
		}
	});

	it("reports no folder and offers a detected Multica stack, never using it on its own", async () => {
		const h = harness({
			validDirs: new Set(["/Users/me/code/multica"]),
			composeList: JSON.stringify([{ Name: "multica", Status: "exited(3)", ConfigFiles: "/Users/me/code/multica/docker-compose.selfhost.yml" }]),
		});

		const status = await h.server.getStatus();

		expect(status).toMatchObject({ state: "no_folder", folder: null, detectedFolder: "/Users/me/code/multica" });
		expect(h.writes).toEqual([]);
		expect(h.verbs()).not.toContain("up");
	});

	it("uses the saved folder, and reports it invalid rather than falling back to the default", async () => {
		const h = harness({ stackDir: "/Users/me/gone" });
		expect(await h.server.getStatus()).toMatchObject({ state: "invalid_folder", folder: "/Users/me/gone" });
	});

	it("goes from starting to unhealthy once the grace period passes without an answer", async () => {
		const h = harness({ ps: ALL_UP });
		expect((await h.server.getStatus()).state).toBe("starting");
		h.fake.now += STARTING_GRACE_MS + 1;
		expect((await h.server.getStatus()).state).toBe("unhealthy");
		h.fake.probe = { ok: true, apiUrl: "" };
		expect((await h.server.getStatus()).state).toBe("healthy");
	});

	it("notes when the published web port differs from the configured address", async () => {
		const h = harness({
			ps: ndjson([row("postgres"), row("backend"), row("frontend", "running", { Publishers: [{ TargetPort: 3000, PublishedPort: 3001 }] })]),
			probe: { ok: true, apiUrl: "" },
		});
		expect((await h.server.getStatus()).portMismatch).toEqual({ published: 3001, configured: 3000 });
	});

	it("runs nothing until asked, then polls while watched and stops when not", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			expect(h.calls).toEqual([]);
			h.server.watch(true);
			await vi.advanceTimersByTimeAsync(0);
			const first = h.calls.length;
			expect(first).toBeGreaterThan(0);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(h.calls.length).toBeGreaterThan(first);
			h.server.watch(false);
			const stopped = h.calls.length;
			await vi.advanceTimersByTimeAsync(20_000);
			expect(h.calls.length).toBe(stopped);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes polling when watched again after being stopped", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.server.watch(true);
			await vi.advanceTimersByTimeAsync(0);
			h.server.watch(false);
			await vi.advanceTimersByTimeAsync(10_000);
			const stopped = h.calls.length;

			h.server.watch(true);
			await vi.advanceTimersByTimeAsync(0);
			const resumed = h.calls.length;
			expect(resumed).toBeGreaterThan(stopped);
			await vi.advanceTimersByTimeAsync(5_000);

			expect(h.calls.length).toBeGreaterThan(resumed);
		} finally {
			vi.useRealTimers();
		}
	});

	it("pushes a status only when it changes", async () => {
		const h = harness();
		await h.server.getStatus();
		await h.server.getStatus();
		expect(h.emitted).toHaveLength(1);
		h.fake.ps = ALL_UP;
		await h.server.getStatus();
		expect(h.emitted).toHaveLength(2);
	});
});

describe("start, stop and restart", () => {
	it("starts a stopped stack with the exact allow-listed command", async () => {
		const h = harness();
		expect(await h.server.start()).toEqual({ ok: true });
		const up = h.calls.find((call) => call.args.includes("up"));
		expect(up).toEqual({ file: DOCKER, args: ["compose", "-f", FILE, "--project-directory", DIR, "up", "-d"] });
	});

	it("stops and restarts with their commands", async () => {
		const h = harness({ ps: ALL_UP, probe: { ok: true, apiUrl: "" } });
		expect(await h.server.stop()).toEqual({ ok: true });
		expect(await h.server.restart()).toEqual({ ok: true });
		expect(h.calls.filter((call) => call.args[6] === undefined && call.args[5] === "stop")).toHaveLength(1);
		expect(h.calls.some((call) => call.args[5] === "restart" && call.args.length === 6)).toBe(true);
	});

	it("reports the transient state while the command runs", async () => {
		const gate = hang();
		const h = harness({ handlers: { up: () => gate.promise } });
		const started = h.server.start();
		await vi.waitFor(() => expect(h.emitted.map((s) => s.state)).toContain("starting_server"));
		gate.release();
		await started;
		expect(h.emitted.at(-1)?.state).toBe("stopped");
	});

	it("starts Docker Desktop on macOS, waits for the engine, then starts the stack", async () => {
		const h = harness({ engine: "down" });
		let opened = false;
		let polls = 0;
		h.fake.handlers["open"] = () => {
			opened = true;
			return {};
		};
		// Docker takes a few polls to come up after it was launched.
		h.fake.handlers["docker-version"] = () =>
			opened && ++polls > 2 ? { stdout: "27.0.0\n" } : { error: { code: 1 }, stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?" };
		expect(await h.server.start()).toEqual({ ok: true });

		expect(h.calls.find((call) => call.file === "/usr/bin/open")?.args).toEqual(["-a", "Docker"]);
		expect(h.verbs().indexOf("open")).toBeLessThan(h.verbs().indexOf("up"));
		expect(h.emitted.map((s) => s.state)).toContain("docker_starting");
	});

	it("gives up waiting for Docker after the timeout and does not start the stack", async () => {
		const h = harness({ engine: "down" });
		h.fake.handlers["open"] = () => ({});
		const result = await h.server.start();

		expect(result).toEqual({ ok: false, code: "docker_start_timeout" });
		expect(h.verbs()).not.toContain("up");
		expect(h.fake.now - 1_000_000).toBeGreaterThanOrEqual(120_000);
	});

	it("does not try to launch Docker off macOS, nor for stop and restart", async () => {
		const linux = harness({ engine: "down", platform: "linux" });
		expect(await linux.server.start()).toEqual({ ok: false, code: "docker_not_running" });
		expect(linux.calls.some((call) => call.file === "/usr/bin/open")).toBe(false);

		const mac = harness({ engine: "down" });
		expect(await mac.server.stop()).toEqual({ ok: false, code: "docker_not_running" });
		expect(await mac.server.restart()).toEqual({ ok: false, code: "docker_not_running" });
		expect(mac.calls.some((call) => call.file === "/usr/bin/open")).toBe(false);
	});

	it("refuses with the reason when the stack is not ready to run", async () => {
		expect(await harness({ hasEnv: false }).server.start()).toEqual({ ok: false, code: "needs_setup" });
		expect(await harness({ docker: null }).server.start()).toEqual({ ok: false, code: "docker_not_installed" });
		expect(await harness({ composePlugin: false }).server.start()).toEqual({ ok: false, code: "compose_missing" });
		expect(await harness({ validDirs: new Set() }).server.start()).toEqual({ ok: false, code: "no_folder" });
		expect(await harness({ settings: { ...LOCAL, mode: "cloud" } }).server.start()).toEqual({ ok: false, code: "unavailable" });
	});

	it("reports a taken port as a port conflict that survives until a start works", async () => {
		const h = harness({ handlers: { up: () => ({ error: { code: 1 }, stderr: "Bind for 127.0.0.1:3000 failed: port is already allocated" }) } });

		const result = await h.server.start();

		expect(result).toMatchObject({ ok: false, code: "port_conflict" });
		expect((await h.server.getStatus()).state).toBe("port_conflict");
		delete h.fake.handlers["up"];
		expect(await h.server.start()).toEqual({ ok: true });
		expect((await h.server.getStatus()).state).toBe("stopped");
	});

	it("shows a failure's redacted details in the status until the next success", async () => {
		const h = harness({ handlers: { up: () => ({ error: { code: 1 }, stderr: "failed with JWT_SECRET=topsecret123 and postgres://u:hunter2@db/x" }) } });

		await h.server.start();
		const status = await h.server.getStatus();

		expect(status.error?.code).toBe("command_failed");
		expect(JSON.stringify(status)).not.toMatch(/topsecret123|hunter2/);
		delete h.fake.handlers["up"];
		await h.server.start();
		expect((await h.server.getStatus()).error).toBeNull();
	});

	it("keeps secrets out of every pushed status, the console and the settings writes", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
		try {
			const h = harness({ handlers: { up: () => ({ error: { code: 1 }, stderr: "POSTGRES_PASSWORD=pg-secret-9 MULTICA_VCS_SECRET_KEY=vcs-secret-9" }) } });
			await h.server.start();
			await h.server.getStatus();

			expect(JSON.stringify([h.emitted, h.writes])).not.toMatch(/pg-secret-9|vcs-secret-9/);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});

	it("maps a command that hit its timeout to a timeout error", async () => {
		const h = harness({ handlers: { up: () => ({ error: { killed: true, code: null } }) } });
		expect(await h.server.start()).toEqual({ ok: false, code: "timeout" });
	});
});

describe("one operation at a time", () => {
	it("refuses a second operation while one runs, then accepts again", async () => {
		const gate = hang();
		const h = harness({ handlers: { up: () => gate.promise } });

		const first = h.server.start();
		await vi.waitFor(() => expect(h.verbs()).toContain("up"));

		expect(await h.server.start()).toEqual({ ok: false, code: "busy" });
		expect(await h.server.stop()).toEqual({ ok: false, code: "busy" });
		expect(await h.server.restart()).toEqual({ ok: false, code: "busy" });
		expect(await h.server.setup()).toEqual({ ok: false, code: "busy" });
		expect(await h.server.chooseFolder()).toEqual({ ok: false, code: "busy" });
		expect(await h.server.useDetectedFolder()).toEqual({ ok: false, code: "busy" });
		expect(h.calls.filter((call) => call.args.includes("up"))).toHaveLength(1);

		gate.release();
		await first;
		expect(await h.server.stop()).toEqual({ ok: true });
	});

	it("is one operation per machine, across instances", async () => {
		const gate = hang();
		const a = harness({ handlers: { up: () => gate.promise } });
		const b = harness();

		const first = a.server.start();
		await vi.waitFor(() => expect(a.verbs()).toContain("up"));
		expect(await b.server.start()).toEqual({ ok: false, code: "busy" });
		expect(b.calls.some((call) => call.args.includes("up"))).toBe(false);

		gate.release();
		await first;
	});

	it("reports the operation state instead of running docker for a status request in the meantime", async () => {
		const gate = hang();
		const h = harness({ handlers: { up: () => gate.promise } });
		const first = h.server.start();
		await vi.waitFor(() => expect(h.verbs()).toContain("up"));
		const before = h.calls.length;

		expect((await h.server.getStatus()).state).toBe("starting_server");
		expect(h.calls.length).toBe(before);

		gate.release();
		await first;
	});
});

describe("cancel", () => {
	it("stops a running operation, reports cancelled and leaves no error behind", async () => {
		const gate = hang();
		const h = harness({ handlers: { up: () => gate.promise } });
		const started = h.server.start();
		await vi.waitFor(() => expect(h.verbs()).toContain("up"));

		expect(h.server.cancel()).toEqual({ ok: true });

		expect(await started).toEqual({ ok: false, code: "cancelled" });
		expect((await h.server.getStatus()).error).toBeNull();
		expect(await h.server.stop()).toEqual({ ok: true });
	});

	it("also cancels the wait for Docker Desktop", async () => {
		const h = harness({ engine: "down" });
		h.fake.handlers["open"] = () => ({});
		let sleeps = 0;
		h.options.sleep = async (ms) => {
			sleeps += 1;
			h.fake.now += ms;
			if (sleeps === 2) server.cancel();
		};
		const server = createMulticaLocalServer(h.options);

		expect(await server.start()).toEqual({ ok: false, code: "cancelled" });
		expect(h.verbs()).not.toContain("up");
	});

	it("does nothing when nothing runs", () => {
		expect(harness().server.cancel()).toEqual({ ok: true });
	});
});

describe("setup", () => {
	it("creates .env through the setup step and runs no process", async () => {
		const h = harness({ hasEnv: false });
		expect(await h.server.setup()).toEqual({ ok: true });
		expect(h.verbs().filter((verb) => !["docker-version", "compose-version", "ps"].includes(verb))).toEqual([]);
		expect((await h.server.getStatus()).state).toBe("stopped");
	});

	it("does not touch an existing .env", async () => {
		const h = harness();
		const setupEnv = vi.spyOn(h.options, "setupEnv");
		const server = createMulticaLocalServer(h.options);
		expect(await server.setup()).toEqual({ ok: false, code: "already_set_up" });
		expect(setupEnv).not.toHaveBeenCalled();
	});

	it("reports a failed setup and when there is nothing to set up in", async () => {
		expect(await harness({ hasEnv: false, setupOutcome: "failed" }).server.setup()).toEqual({ ok: false, code: "setup_failed" });
		expect(await harness({ hasEnv: false, validDirs: new Set() }).server.setup()).toEqual({ ok: false, code: "no_folder" });
	});
});

describe("choosing the folder", () => {
	it("saves only a folder that validates, as its canonical path", async () => {
		const h = harness({ validDirs: new Set(["/Users/me/code/multica"]), chosen: "/Users/me/code/multica" });
		expect(await h.server.chooseFolder()).toEqual({ ok: true });
		expect(h.writes).toEqual([{ stackDir: "/Users/me/code/multica" }]);
		expect((await h.server.getStatus()).folder).toBe("/Users/me/code/multica");
	});

	it("does not save a folder that does not validate, or when the dialog is cancelled", async () => {
		const bad = harness({ chosen: "/etc" });
		expect(await bad.server.chooseFolder()).toEqual({ ok: false, code: "invalid_folder", detail: "not_found" });
		const cancelled = harness({ chosen: null });
		expect(await cancelled.server.chooseFolder()).toEqual({ ok: false, code: "cancelled" });
		expect(bad.writes).toEqual([]);
		expect(cancelled.writes).toEqual([]);
	});

	it("is not offered in Cloud mode", async () => {
		const h = harness({ settings: { ...LOCAL, mode: "cloud" }, chosen: DIR });
		expect(await h.server.chooseFolder()).toEqual({ ok: false, code: "unavailable" });
	});

	it("adopts the detected stack only when the user asks, and only if it still validates", async () => {
		const detected = "/Users/me/code/multica";
		const list = JSON.stringify([{ Name: "multica", Status: "exited(3)", ConfigFiles: `${detected}/docker-compose.selfhost.yml` }]);
		const h = harness({ validDirs: new Set([detected]), composeList: list });
		expect(await h.server.useDetectedFolder()).toEqual({ ok: true });
		expect(h.writes).toEqual([{ stackDir: detected }]);

		const none = harness({ validDirs: new Set() , composeList: list });
		expect(await none.server.useDetectedFolder()).toEqual({ ok: false, code: "no_detected_folder" });
	});

	it("ignores projects that are not Multica's or whose file is not the self-hosting file", async () => {
		const list = JSON.stringify([
			{ Name: "other", Status: "running", ConfigFiles: "/Users/me/x/docker-compose.selfhost.yml" },
			{ Name: "multica", Status: "running", ConfigFiles: "/Users/me/y/docker-compose.yml" },
		]);
		const h = harness({ validDirs: new Set(["/Users/me/x", "/Users/me/y"]), composeList: list });
		expect((await h.server.getStatus()).detectedFolder).toBeNull();
	});
});

describe("logs", () => {
	const logs = "backend-1  | starting\nbackend-1  | [DEV] Verification code for a@b.c: 123456\n";

	it("returns the tail as printed, including a sign-in code, and keeps it nowhere", async () => {
		const h = harness({ handlers: { logs: () => ({ stdout: logs }) } });
		const result = await h.server.getLogs("backend", 200);

		expect(result).toEqual({ ok: true, lines: ["backend-1  | starting", "backend-1  | [DEV] Verification code for a@b.c: 123456"] });
		expect(h.calls.find((call) => call.args[5] === "logs")?.args).toEqual(["compose", "-f", FILE, "--project-directory", DIR, "logs", "--no-color", "--tail", "200", "backend"]);
		expect(JSON.stringify([h.emitted, h.writes])).not.toContain("123456");
	});

	it("limits lines to the requested tail and caps very long lines", async () => {
		const h = harness({ handlers: { logs: () => ({ stdout: `${"a\n".repeat(50)}${"x".repeat(5000)}\n` }) } });
		const result = await h.server.getLogs("backend", 3);
		expect(result.ok && result.lines).toHaveLength(3);
		expect(result.ok && result.lines.at(-1)?.length).toBe(2000);
	});

	it("reports why logs are unavailable", async () => {
		expect(await harness({ engine: "down" }).server.getLogs("backend", 10)).toEqual({ ok: false, code: "docker_not_running" });
		expect(await harness({ hasEnv: false }).server.getLogs("backend", 10)).toEqual({ ok: false, code: "needs_setup" });
		expect(await harness({ handlers: { logs: () => ({ error: { code: 1 }, stderr: "no such service" }) } }).server.getLogs("frontend", 10)).toMatchObject({ ok: false, code: "command_failed" });
	});

	it("can be read while an operation runs", async () => {
		const gate = hang();
		const h = harness({ handlers: { up: () => gate.promise, logs: () => ({ stdout: "line\n" }) } });
		const started = h.server.start();
		await vi.waitFor(() => expect(h.verbs()).toContain("up"));
		expect(await h.server.getLogs("backend", 5)).toEqual({ ok: true, lines: ["line"] });
		gate.release();
		await started;
	});
});

describe("dispose", () => {
	it("stops polling and pushes nothing afterwards", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			h.server.watch(true);
			await vi.advanceTimersByTimeAsync(0);
			h.server.dispose();
			const count = h.emitted.length;
			h.fake.ps = ALL_UP;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(h.emitted.length).toBe(count);
		} finally {
			vi.useRealTimers();
		}
	});
});

beforeEach(() => undefined);
afterEach(() => vi.restoreAllMocks());
