import { describe, expect, it, vi } from "vitest";
import {
	composeListCommand,
	composeVersionCommand,
	dockerVersionCommand,
	findDockerBinary,
	isIssuedCommand,
	localServerChildEnv,
	logsCommand,
	openDockerCommand,
	psCommand,
	restartCommand,
	runLocalServerCommand,
	stopCommand,
	upCommand,
	type CommandSpec,
	type ExecFileLike,
	type StackPaths,
} from "./multica-local-server-commands";

const DOCKER = "/usr/local/bin/docker";
const STACK: StackPaths = { dir: "/Users/me/.multica/server", file: "/Users/me/.multica/server/docker-compose.selfhost.yml" };
const BASE = ["compose", "-f", STACK.file, "--project-directory", STACK.dir];

describe("local server commands", () => {
	it("builds exactly the allow-listed argument vectors", () => {
		expect([dockerVersionCommand(DOCKER).file, ...dockerVersionCommand(DOCKER).args]).toEqual([DOCKER, "version", "--format", "{{.Server.Version}}"]);
		expect(composeVersionCommand(DOCKER).args).toEqual(["compose", "version", "--short"]);
		expect(composeListCommand(DOCKER).args).toEqual(["compose", "ls", "--all", "--format", "json"]);
		expect(psCommand(DOCKER, STACK).args).toEqual([...BASE, "ps", "--all", "--format", "json"]);
		expect(upCommand(DOCKER, STACK).args).toEqual([...BASE, "up", "-d"]);
		expect(stopCommand(DOCKER, STACK).args).toEqual([...BASE, "stop"]);
		expect(restartCommand(DOCKER, STACK).args).toEqual([...BASE, "restart"]);
		expect(logsCommand(DOCKER, STACK, "backend", 200).args).toEqual([...BASE, "logs", "--no-color", "--tail", "200", "backend"]);
		expect(openDockerCommand()).toMatchObject({ file: "/usr/bin/open", args: ["-a", "Docker"] });
	});

	it("never runs a stack command through a shell, a pipe or a different verb", () => {
		const verbs = new Set(["ps", "up", "stop", "restart", "logs"]);
		for (const spec of [psCommand, upCommand, stopCommand, restartCommand].map((build) => build(DOCKER, STACK))) {
			expect(spec.args.filter((arg) => verbs.has(arg))).toHaveLength(1);
			expect(spec.args.some((arg) => /[;&|`$<>]/.test(arg))).toBe(false);
			expect(spec.args).not.toContain("down");
			expect(spec.args).not.toContain("-v");
		}
	});

	it("rejects a service or line count outside the allowed set before a command exists", () => {
		expect(() => logsCommand(DOCKER, STACK, "backend; rm -rf /" as never, 10)).toThrow();
		expect(() => logsCommand(DOCKER, STACK, "--follow" as never, 10)).toThrow();
		expect(() => logsCommand(DOCKER, STACK, "backend", 0)).toThrow();
		expect(() => logsCommand(DOCKER, STACK, "backend", 501)).toThrow();
		expect(() => logsCommand(DOCKER, STACK, "backend", 1.5)).toThrow();
		expect(() => logsCommand(DOCKER, STACK, "backend", Number.NaN)).toThrow();
	});

	it("keeps a hostile folder name a single argument and never lets a path become an option", () => {
		for (const name of ["a b", "a'b", 'a"b', "a;b", "a$(id)b", "a\nb", "-f", "--rm"]) {
			const dir = `/Users/me/${name}`;
			const stack = { dir, file: `${dir}/docker-compose.selfhost.yml` };
			const spec = upCommand(DOCKER, stack);
			expect(spec.args).toEqual(["compose", "-f", stack.file, "--project-directory", dir, "up", "-d"]);
			expect(spec.args.every((arg) => arg === "up" || arg === "-d" || arg === "compose" || arg === "-f" || arg === "--project-directory" || arg.startsWith("/"))).toBe(true);
		}
	});

	it("refuses relative paths, NUL bytes and a compose file that is not the fixed file inside the folder", () => {
		expect(() => upCommand(DOCKER, { dir: "relative", file: "relative/docker-compose.selfhost.yml" })).toThrow();
		expect(() => upCommand("docker", STACK)).toThrow();
		expect(() => upCommand(DOCKER, { dir: "/a\0b", file: "/a\0b/docker-compose.selfhost.yml" })).toThrow();
		expect(() => upCommand(DOCKER, { dir: "/a", file: "/a/other.yml" })).toThrow();
		expect(() => upCommand(DOCKER, { dir: "/a", file: "/b/docker-compose.selfhost.yml" })).toThrow();
		expect(() => upCommand(DOCKER, { dir: "/a", file: "/a/sub/docker-compose.selfhost.yml" })).toThrow();
	});
});

describe("runLocalServerCommand", () => {
	const env = { PATH: "/usr/bin" };

	it("runs an issued command through execFile with timeout, buffer cap, hidden window and the given environment", async () => {
		const exec = vi.fn<ExecFileLike>((_file, _args, _options, callback) => callback(null, "ok", ""));
		const spec = stopCommand(DOCKER, STACK);
		const result = await runLocalServerCommand(exec, spec, env);

		expect(result).toEqual({ error: null, stdout: "ok", stderr: "" });
		expect(exec).toHaveBeenCalledExactlyOnceWith(DOCKER, [...spec.args], { timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true, env }, expect.any(Function));
	});

	it("refuses a command that was not built by this module, including a copy of a built one", async () => {
		const exec = vi.fn<ExecFileLike>();
		const forged: CommandSpec = { name: "up", file: DOCKER, args: ["compose", "down", "-v"], timeoutMs: 1000 };
		const copied: CommandSpec = { ...upCommand(DOCKER, STACK) };

		await expect(runLocalServerCommand(exec, forged, env)).rejects.toThrow(/allow-list/);
		await expect(runLocalServerCommand(exec, copied, env)).rejects.toThrow(/allow-list/);
		expect(isIssuedCommand(forged)).toBe(false);
		expect(exec).not.toHaveBeenCalled();
	});

	it("does not start a process when already cancelled, and passes the abort signal through", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		const aborted = new AbortController();
		aborted.abort();
		const result = await runLocalServerCommand(exec, upCommand(DOCKER, STACK), env, aborted.signal);
		expect(result.error?.name).toBe("AbortError");
		expect(exec).not.toHaveBeenCalled();

		const live = new AbortController();
		await runLocalServerCommand(exec, upCommand(DOCKER, STACK), env, live.signal);
		expect(exec.mock.calls[0]?.[2].signal).toBe(live.signal);
	});

	it("allows up to ten minutes for a start (the first one pulls images) and bounds every other command", () => {
		expect(upCommand(DOCKER, STACK).timeoutMs).toBe(600_000);
		for (const spec of [dockerVersionCommand(DOCKER), composeVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, STACK), stopCommand(DOCKER, STACK), restartCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5), openDockerCommand()]) {
			expect(spec.timeoutMs).toBeGreaterThan(0);
			expect(spec.timeoutMs).toBeLessThanOrEqual(120_000);
		}
	});
});

describe("localServerChildEnv", () => {
	it("keeps a short allow-list and drops secrets, COMPOSE_* and DOCKER_HOST", () => {
		const env = localServerChildEnv(
			{
				PATH: "/usr/bin:relative/bin",
				HOME: "/Users/me",
				LANG: "en_US.UTF-8",
				DOCKER_CONFIG: "/Users/me/.docker",
				DOCKER_HOST: "tcp://evil:2375",
				COMPOSE_PROJECT_NAME: "other",
				COMPOSE_FILE: "/tmp/x.yml",
				JWT_SECRET: "s3cret",
				ANTHROPIC_API_KEY: "k",
				AO_DATA_DIR: "/x",
			},
			"/Users/me",
			"darwin",
		);

		expect(Object.keys(env).sort()).toEqual(["DOCKER_CONFIG", "HOME", "LANG", "PATH"]);
		expect(env.PATH).toContain("/Applications/Docker.app/Contents/Resources/bin");
		expect(env.PATH?.split(":")).not.toContain("relative/bin");
	});
});

describe("findDockerBinary", () => {
	const only = (target: string) => (file: string) => file === target;

	it("finds docker in a usual install directory when PATH is minimal", () => {
		expect(findDockerBinary({ pathEnv: "/usr/bin", home: "/Users/me", platform: "darwin", isExecutable: only("/opt/homebrew/bin/docker") })).toBe("/opt/homebrew/bin/docker");
		expect(findDockerBinary({ pathEnv: "", home: "/Users/me", platform: "darwin", isExecutable: only("/Applications/Docker.app/Contents/Resources/bin/docker") })).toBe(
			"/Applications/Docker.app/Contents/Resources/bin/docker",
		);
	});

	it("ignores relative PATH entries and returns null when nothing is executable", () => {
		expect(findDockerBinary({ pathEnv: "bin:.", home: "/Users/me", platform: "darwin", isExecutable: only("bin/docker") })).toBeNull();
		expect(findDockerBinary({ pathEnv: "/usr/bin", home: "/Users/me", platform: "linux", isExecutable: () => false })).toBeNull();
	});
});
