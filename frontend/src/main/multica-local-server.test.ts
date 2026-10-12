import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Records every file-system write the code under test attempts (and lets it through), so a
// log line that is persisted anywhere shows up, whichever fs API or import style is used.
const fsWrites = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const wrap = (names: string[], target: Record<string, unknown>) =>
		Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => { fsWrites.calls.push(`fs/promises.${name}`); return (target[name] as (...a: unknown[]) => unknown)(...args); }]));
	const names = ["writeFile", "appendFile", "open", "mkdir", "rename", "copyFile", "cp", "truncate", "mkdtemp", "symlink", "link"];
	const wrapped = { ...actual, ...wrap(names, actual as never) };
	return { ...wrapped, default: wrapped };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const wrap = (names: string[], target: Record<string, unknown>, prefix: string) =>
		Object.fromEntries(names.map((name) => [name, (...args: unknown[]) => { fsWrites.calls.push(`${prefix}.${name}`); return (target[name] as (...a: unknown[]) => unknown)(...args); }]));
	const syncNames = ["writeFileSync", "appendFileSync", "openSync", "writeSync", "mkdirSync", "renameSync", "copyFileSync", "truncateSync", "createWriteStream", "writeFile", "appendFile", "mkdtempSync"];
	const promiseNames = ["writeFile", "appendFile", "open", "mkdir", "rename", "copyFile", "cp", "truncate"];
	const promises = { ...actual.promises, ...wrap(promiseNames, actual.promises as never, "fs.promises") };
	const wrapped = { ...actual, ...wrap(syncNames, actual as never, "fs"), promises };
	return { ...wrapped, default: wrapped };
});

import type { MulticaCheckResult, MulticaSettings } from "../shared/multica";
import type { LocalServerStatus } from "../shared/multica-local-server";
import { checkMulticaServer } from "./multica-server-check";
import { createMulticaLocalServer, type MulticaLocalServer, type MulticaLocalServerOptions } from "./multica-local-server";
import type { ExecError, ExecFileLike } from "./multica-local-server-commands";
import type { SetupOutcome, StackCheck } from "./multica-local-server-stack";
import { STARTING_GRACE_MS } from "./multica-local-server-state";

const DOCKER = "/usr/local/bin/docker";
const HOME = "/Users/me";
const DIR = "/Users/me/.multica/server";
const FILE = `${DIR}/docker-compose.selfhost.yml`;
const SOCKET = "unix:///Users/me/.docker/run/docker.sock";
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
	endpoint: string | null;
	env: NodeJS.ProcessEnv;
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
		endpoint: SOCKET,
		env: { PATH: "/usr/bin", HOME },
		...patch,
	};
	const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
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
		calls.push({ file, args, env: options.env });
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
		env: fake.env,
		platform: fake.platform,
		findDocker: () => fake.docker,
		findEndpoint: () => fake.endpoint,
		findPathDirs: () => ["/usr/local/bin", "/usr/bin"],
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

	it("turns a stack that stays in 'created' unhealthy after the grace period too", async () => {
		const created = ndjson([row("postgres", "created"), row("backend", "created"), row("frontend", "created")]);
		const h = harness({ ps: created });

		expect((await h.server.getStatus()).state).toBe("starting");
		h.fake.now += STARTING_GRACE_MS - 1;
		expect((await h.server.getStatus()).state).toBe("starting");
		h.fake.now += 2;
		expect((await h.server.getStatus()).state).toBe("unhealthy");
	});

	it("does the same for a stack with some containers created and the rest running", async () => {
		const mixed = ndjson([row("postgres", "running", { Health: "healthy" }), row("backend", "created"), row("frontend", "created")]);
		const h = harness({ ps: mixed });

		expect((await h.server.getStatus()).state).toBe("starting");
		h.fake.now += STARTING_GRACE_MS + 1;
		expect((await h.server.getStatus()).state).toBe("unhealthy");
	});

	it("restarts the grace clock after the stack went away and came back", async () => {
		const created = ndjson([row("postgres", "created")]);
		const h = harness({ ps: created });
		await h.server.getStatus();
		h.fake.now += STARTING_GRACE_MS + 1;
		expect((await h.server.getStatus()).state).toBe("unhealthy");

		h.fake.ps = "";
		expect((await h.server.getStatus()).state).toBe("stopped");
		h.fake.ps = created;
		expect((await h.server.getStatus()).state).toBe("starting");
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
		expect(up).toMatchObject({ file: DOCKER, args: ["compose", "-f", FILE, "--project-directory", DIR, "up", "-d"] });
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

describe("a failed inspection is not a stopped stack", () => {
	const denied = { error: { code: 1 }, stderr: "permission denied while reading /var/run/compose with POSTGRES_PASSWORD=pg-secret-1" };

	it("reports an unknown state, with the redacted reason, when docker compose ps fails", async () => {
		const h = harness({ handlers: { ps: () => denied }, probe: { ok: false, error: "unreachable" } });

		const status = await h.server.getStatus();

		expect(status.state).toBe("unknown");
		expect(status.error?.code).toBe("inspect_failed");
		expect(status.error?.detail).toContain("permission denied");
		expect(JSON.stringify(status)).not.toContain("pg-secret-1");
	});

	it("reports an unknown state for output that is not Compose's JSON, and does not probe", async () => {
		const h = harness({ ps: "this is not json", probe: { ok: false, error: "unreachable" } });
		const probe = vi.spyOn(h.options, "probe");
		const status = await createMulticaLocalServer(h.options).getStatus();

		expect(status).toMatchObject({ state: "unknown", error: { code: "inspect_failed", detail: "Unexpected output from docker compose ps" } });
		expect(probe).not.toHaveBeenCalled();
	});

	it("is unknown even when something answers at the address", async () => {
		const h = harness({ handlers: { ps: () => denied }, probe: { ok: true, apiUrl: "" } });
		expect((await h.server.getStatus()).state).toBe("unknown");
	});

	it("recovers on its own once docker compose ps works again", async () => {
		const h = harness({ handlers: { ps: () => denied } });
		expect((await h.server.getStatus()).state).toBe("unknown");
		delete h.fake.handlers["ps"];
		const status = await h.server.getStatus();
		expect(status.state).toBe("stopped");
		expect(status.error).toBeNull();
	});

	it("is unknown when docker itself answers with a permission error, and starts nothing", async () => {
		const h = harness({
			handlers: { "docker-version": () => ({ error: { code: 1 }, stderr: "permission denied while trying to connect to the Docker daemon socket" }) },
		});

		expect(await h.server.getStatus()).toMatchObject({ state: "unknown", error: { code: "inspect_failed" } });
		expect(await h.server.start()).toMatchObject({ ok: false, code: "inspect_failed" });
		expect(await h.server.stop()).toMatchObject({ ok: false, code: "inspect_failed" });
		expect(await h.server.getLogs("backend", 5)).toMatchObject({ ok: false, code: "inspect_failed" });
		expect(h.calls.some((call) => call.file === "/usr/bin/open")).toBe(false);
		expect(h.verbs()).not.toContain("up");
	});

	it("still reports a plainly stopped engine as not running", async () => {
		expect((await harness({ engine: "down" }).server.getStatus()).state).toBe("docker_not_running");
	});
});

describe("a remote API with a local web address", () => {
	const REMOTE_API: MulticaSettings = { mode: "local", customUrl: "http://localhost:3000", apiUrl: "https://remote.example" };

	it("is unavailable: no docker command, no probe, and every operation is refused", async () => {
		const h = harness({ settings: REMOTE_API, ps: ALL_UP });
		const probe = vi.spyOn(h.options, "probe");
		const server = createMulticaLocalServer(h.options);

		expect(await server.getStatus()).toMatchObject({ state: "unavailable", unavailableReason: "remote_api" });
		expect(await server.start()).toEqual({ ok: false, code: "unavailable" });
		expect(await server.stop()).toEqual({ ok: false, code: "unavailable" });
		expect(await server.restart()).toEqual({ ok: false, code: "unavailable" });
		expect(await server.setup()).toEqual({ ok: false, code: "unavailable" });
		expect(await server.chooseFolder()).toEqual({ ok: false, code: "unavailable" });
		expect(await server.getLogs("backend", 5)).toEqual({ ok: false, code: "unavailable" });
		expect(h.calls).toEqual([]);
		expect(probe).not.toHaveBeenCalled();
	});

	it("never sends a request to the remote host, and a healthy remote answer cannot make the local stack healthy", async () => {
		const requested: string[] = [];
		const get = async (url: string) => {
			requested.push(url);
			return url.endsWith("/api/config") ? { status: 200, body: JSON.stringify({ allow_signup: true }) } : { status: 200, body: "{}" };
		};
		const h = harness({ settings: REMOTE_API, ps: ALL_UP });
		h.options.probe = (request) => checkMulticaServer(request, get);
		const server = createMulticaLocalServer(h.options);

		const status = await server.getStatus();

		expect(requested).toEqual([]);
		expect(status.state).not.toBe("healthy");
	});

	it("probes only loopback addresses, with the normalized web and API origins, when both are local", async () => {
		const requested: string[] = [];
		const get = async (url: string) => {
			requested.push(url);
			return { status: 200, body: JSON.stringify({ allow_signup: true }) };
		};
		const h = harness({ settings: { mode: "local", customUrl: "http://localhost:3000", apiUrl: "http://127.0.0.1:8081" }, ps: ALL_UP });
		h.options.probe = (request) => checkMulticaServer(request, get);
		const server = createMulticaLocalServer(h.options);

		expect((await server.getStatus()).state).toBe("healthy");

		expect(requested.length).toBeGreaterThan(0);
		for (const url of requested) expect(["localhost", "127.0.0.1"]).toContain(new URL(url).hostname);
	});

	it("passes the validated origins to the probe, not the raw settings", async () => {
		const h = harness({ settings: { mode: "local", customUrl: "http://localhost:3000/", apiUrl: "" }, ps: ALL_UP });
		const probe = vi.spyOn(h.options, "probe");
		await createMulticaLocalServer(h.options).getStatus();
		expect(probe).toHaveBeenCalledWith({ customUrl: "http://localhost:3000", apiUrl: "" });
	});
});

describe("the local Docker engine", () => {
	const HOSTILE_ENV = {
		PATH: "/usr/bin",
		HOME,
		DOCKER_HOST: "tcp://10.0.0.5:2375",
		DOCKER_CONTEXT: "remote",
		DOCKER_CONFIG: "/Users/me/remote-config",
		DOCKER_TLS_VERIFY: "1",
		COMPOSE_PROJECT_NAME: "other",
	};

	it("runs every engine command against the pinned local socket, whatever AO's environment or Docker's context says", async () => {
		const h = harness({ env: HOSTILE_ENV, ps: ALL_UP, probe: { ok: true, apiUrl: "" } });

		await h.server.getStatus();
		await h.server.start();
		await h.server.stop();
		await h.server.restart();
		await h.server.getLogs("backend", 5);

		const engineCalls = h.calls.filter((call) => call.file === DOCKER && call.args[1] !== "version");
		expect(engineCalls.length).toBeGreaterThan(6);
		for (const call of h.calls.filter((c) => c.file === DOCKER)) {
			if (call.args[0] === "compose" && call.args[1] === "version") continue;
			expect(call.env.DOCKER_HOST, call.args.join(" ")).toBe(SOCKET);
		}
		for (const call of h.calls) {
			for (const name of ["DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "COMPOSE_PROJECT_NAME"]) expect(call.env[name]).toBeUndefined();
		}
	});

	it("never asks Docker anything when no local engine socket exists, and reports it as not running", async () => {
		const h = harness({ endpoint: null, env: HOSTILE_ENV });

		expect((await h.server.getStatus()).state).toBe("docker_not_running");
		expect(await h.server.stop()).toEqual({ ok: false, code: "docker_not_running" });
		expect(await h.server.restart()).toEqual({ ok: false, code: "docker_not_running" });
		expect(await h.server.getLogs("backend", 5)).toEqual({ ok: false, code: "docker_not_running" });

		const engine = h.calls.filter((call) => call.file === DOCKER && !(call.args[0] === "compose" && call.args[1] === "version"));
		expect(engine).toEqual([]);
	});

	it("starts Docker Desktop and then follows its socket once it appears", async () => {
		const h = harness({ endpoint: null });
		h.fake.handlers["open"] = () => {
			h.fake.endpoint = SOCKET;
			return {};
		};

		expect(await h.server.start()).toEqual({ ok: true });

		const up = h.calls.find((call) => call.args.includes("up"));
		expect(up?.env.DOCKER_HOST).toBe(SOCKET);
		expect(h.calls.find((call) => call.file === "/usr/bin/open")?.env.DOCKER_HOST).toBeUndefined();
	});

	it("gives every command a PATH of trusted directories only, ignoring AO's inherited PATH", async () => {
		const h = harness({ env: { PATH: "/tmp/bin:/home/evil/bin:/usr/bin", HOME } });
		await h.server.getStatus();
		await h.server.start();
		expect(h.calls.length).toBeGreaterThan(3);
		for (const call of h.calls) expect(call.env.PATH, call.args.join(" ")).toBe("/usr/local/bin:/usr/bin");
	});

	it("never starts the stack on a remote engine even if the endpoint lookup is wrong", async () => {
		const h = harness({ endpoint: "tcp://10.0.0.5:2375" });
		expect(await h.server.start()).toEqual({ ok: false, code: "command_failed" });
		expect(h.calls.some((call) => call.args.includes("up"))).toBe(false);
	});
});

describe("backend log lines are never persisted", () => {
	const CODE_LINE = "backend-1  | [DEV] Verification code for me@example.com: 987654";

	beforeEach(() => {
		fsWrites.calls.length = 0;
	});

	it("writes no file, logs nothing and pushes nothing while the log is read, polled and the server is operated", async () => {
		const consoleSpies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const h = harness({ ps: ALL_UP, probe: { ok: true, apiUrl: "" }, handlers: { logs: () => ({ stdout: `${CODE_LINE}\n` }) } });

			for (let i = 0; i < 3; i += 1) expect(await h.server.getLogs("backend", 200)).toEqual({ ok: true, lines: [CODE_LINE] });
			await h.server.getStatus();
			await h.server.restart();
			await h.server.getLogs("backend", 200);
			h.server.dispose();

			expect(fsWrites.calls).toEqual([]);
			expect(JSON.stringify([h.emitted, h.writes, h.calls])).not.toContain("987654");
			for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
			expect(stdoutWrite).not.toHaveBeenCalled();
			expect(stderrWrite).not.toHaveBeenCalled();
		} finally {
			for (const spy of consoleSpies) spy.mockRestore();
			stdoutWrite.mockRestore();
			stderrWrite.mockRestore();
		}
	});

	it("keeps a failed log read's lines out of the error details too", async () => {
		const h = harness({ ps: ALL_UP, handlers: { logs: () => ({ error: { code: 1 }, stdout: `${CODE_LINE}\n`, stderr: "no such service" }) } });
		const result = await h.server.getLogs("backend", 10);
		expect(JSON.stringify(result)).not.toContain("987654");
		expect(fsWrites.calls).toEqual([]);
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

	it("does not create .env when cancelled while the settings are still being read", async () => {
		const h = harness({ hasEnv: false });
		const gate = hang();
		h.options.readServerSettings = async () => {
			await gate.promise;
			return h.fake.settings;
		};
		const setupEnv = vi.spyOn(h.options, "setupEnv");
		const server = createMulticaLocalServer(h.options);

		const setup = server.setup();
		await vi.waitFor(() => expect(h.emitted.map((s) => s.state)).toContain("setting_up"));
		expect(server.cancel()).toEqual({ ok: true });
		gate.release();

		expect(await setup).toEqual({ ok: false, code: "cancelled" });
		expect(setupEnv).not.toHaveBeenCalled();
		expect(h.fake.hasEnv).toBe(false);
	});

	it("does not create .env when cancelled while the folder or .env check is pending", async () => {
		for (const stage of ["validate", "fileExists"] as const) {
			const h = harness({ hasEnv: false });
			const gate = hang();
			const original = h.options[stage] as (...args: never[]) => Promise<unknown>;
			(h.options as Record<string, unknown>)[stage] = async (...args: never[]) => {
				await gate.promise;
				return original(...args);
			};
			const setupEnv = vi.spyOn(h.options, "setupEnv");
			const server = createMulticaLocalServer(h.options);

			const setup = server.setup();
			await vi.waitFor(() => expect(h.emitted.map((s) => s.state)).toContain("setting_up"));
			server.cancel();
			gate.release();

			expect(await setup, stage).toEqual({ ok: false, code: "cancelled" });
			expect(setupEnv, stage).not.toHaveBeenCalled();
		}
	});

	it("says cancel is too late once .env is being written, and the write completes", async () => {
		const h = harness({ hasEnv: false });
		const gate = hang();
		h.options.setupEnv = async () => {
			await gate.promise;
			h.fake.hasEnv = true;
			return "created";
		};
		const server = createMulticaLocalServer(h.options);

		const setup = server.setup();
		await vi.waitFor(() => expect(h.fake.hasEnv).toBe(false));
		await vi.waitFor(() => expect(h.emitted.map((s) => s.state)).toContain("setting_up"));
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(server.cancel()).toEqual({ ok: false, code: "busy" });
		gate.release();

		expect(await setup).toEqual({ ok: true });
		expect(h.fake.hasEnv).toBe(true);
		expect(server.cancel()).toEqual({ ok: true });
	});

	it("starts nothing, and launches no Docker Desktop, when cancelled while the stack is being prepared", async () => {
		const h = harness({ engine: "down" });
		const gate = hang();
		h.options.readServerSettings = async () => {
			await gate.promise;
			return h.fake.settings;
		};
		const server = createMulticaLocalServer(h.options);

		const started = server.start();
		await vi.waitFor(() => expect(h.emitted.map((s) => s.state)).toContain("starting_server"));
		server.cancel();
		gate.release();

		expect(await started).toEqual({ ok: false, code: "cancelled" });
		expect(h.calls.some((call) => call.file === "/usr/bin/open")).toBe(false);
		expect(h.verbs()).not.toContain("up");
	});

	it("does not launch Docker Desktop when cancelled while Docker was being asked", async () => {
		const h = harness({ engine: "down" });
		const gate = hang();
		h.fake.handlers["docker-version"] = () => gate.promise;
		const server = createMulticaLocalServer(h.options);

		const started = server.start();
		await vi.waitFor(() => expect(h.verbs()).toContain("docker-version"));
		server.cancel();
		gate.release({ error: { code: 1 }, stderr: "Cannot connect to the Docker daemon" });

		expect(await started).toEqual({ ok: false, code: "cancelled" });
		expect(h.calls.some((call) => call.file === "/usr/bin/open")).toBe(false);
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
