import { beforeEach, describe, expect, it, vi } from "vitest";

// Every way to start a process is a recorder, so nothing real can run and any other entry point shows up.
const childProcess = vi.hoisted(() => {
	const others = ["exec", "execSync", "execFileSync", "spawn", "spawnSync", "fork"] as const;
	const fns = { execFile: vi.fn(), ...Object.fromEntries(others.map((name) => [name, vi.fn(() => { throw new Error(`unexpected child_process.${name}`); })])) } as Record<string, ReturnType<typeof vi.fn>>;
	return { execFile: fns.execFile as ReturnType<typeof vi.fn>, fns, others };
});
vi.mock("node:child_process", () => ({ ...childProcess.fns, default: childProcess.fns }));

import {
	composeListCommand,
	composeVersionCommand,
	dockerVersionCommand,
	findDockerBinary,
	findLocalDockerEndpoint,
	isIssuedCommand,
	isLocalDockerEndpoint,
	localServerChildEnv,
	logsCommand,
	nodeExec,
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
	const env = { PATH: "/usr/bin", DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" };

	it("runs an issued command through execFile with timeout, buffer cap, hidden window and the given environment", async () => {
		const exec = vi.fn<ExecFileLike>((_file, _args, _options, callback) => callback(null, "ok", ""));
		const spec = stopCommand(DOCKER, STACK);
		const result = await runLocalServerCommand(exec, spec, env);

		expect(result).toEqual({ error: null, stdout: "ok", stderr: "" });
		expect(exec).toHaveBeenCalledExactlyOnceWith(DOCKER, [...spec.args], { timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true, env }, expect.any(Function));
	});

	it("refuses a command that was not built by this module, including a copy of a built one", async () => {
		const exec = vi.fn<ExecFileLike>();
		const forged: CommandSpec = { name: "up", file: DOCKER, args: ["compose", "down", "-v"], timeoutMs: 1000, engine: true };
		const copied: CommandSpec = { ...upCommand(DOCKER, STACK) };

		await expect(runLocalServerCommand(exec, forged, env)).rejects.toThrow(/allow-list/);
		await expect(runLocalServerCommand(exec, copied, env)).rejects.toThrow(/allow-list/);
		expect(isIssuedCommand(forged)).toBe(false);
		expect(exec).not.toHaveBeenCalled();
	});

	it("refuses an engine command without a local endpoint, whatever the environment says", async () => {
		const exec = vi.fn<ExecFileLike>();
		for (const bad of [{ PATH: "/usr/bin" }, { DOCKER_HOST: "tcp://10.0.0.5:2375" }, { DOCKER_HOST: "ssh://me@box" }]) {
			for (const spec of [dockerVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, STACK), upCommand(DOCKER, STACK), stopCommand(DOCKER, STACK), restartCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5)]) {
				await expect(runLocalServerCommand(exec, spec, bad)).rejects.toThrow(/local engine/);
			}
		}
		expect(exec).not.toHaveBeenCalled();
	});

	it("lets the commands that never contact the engine run without an endpoint", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		await runLocalServerCommand(exec, composeVersionCommand(DOCKER), { PATH: "/usr/bin" });
		await runLocalServerCommand(exec, openDockerCommand(), { PATH: "/usr/bin" });
		expect(exec).toHaveBeenCalledTimes(2);
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
	const SOCKET = "unix:///Users/me/.docker/run/docker.sock";

	it("keeps a short allow-list and drops secrets, COMPOSE_*, DOCKER_CONFIG, DOCKER_CONTEXT and remote engine settings", () => {
		const env = localServerChildEnv(
			{
				PATH: "/usr/bin:relative/bin",
				HOME: "/Users/me",
				LANG: "en_US.UTF-8",
				DOCKER_CONFIG: "/Users/me/other-docker-config",
				DOCKER_HOST: "tcp://evil:2375",
				DOCKER_CONTEXT: "remote",
				DOCKER_TLS_VERIFY: "1",
				DOCKER_CERT_PATH: "/x",
				COMPOSE_PROJECT_NAME: "other",
				COMPOSE_FILE: "/tmp/x.yml",
				JWT_SECRET: "s3cret",
				ANTHROPIC_API_KEY: "k",
				AO_DATA_DIR: "/x",
			},
			"/Users/me",
			"darwin",
			SOCKET,
		);

		expect(Object.keys(env).sort()).toEqual(["DOCKER_HOST", "HOME", "LANG", "PATH"]);
		expect(env.DOCKER_HOST).toBe(SOCKET);
		expect(env.PATH).toContain("/Applications/Docker.app/Contents/Resources/bin");
		expect(env.PATH?.split(":")).not.toContain("relative/bin");
	});

	it("sets no DOCKER_HOST when there is no local endpoint, and never copies one from the environment", () => {
		expect(localServerChildEnv({ DOCKER_HOST: "tcp://evil:2375", HOME: "/Users/me" }, "/Users/me", "darwin").DOCKER_HOST).toBeUndefined();
	});

	it("refuses an endpoint that is not a local socket", () => {
		for (const endpoint of ["tcp://10.0.0.5:2375", "ssh://user@host", "unix://host/var/run/docker.sock", "http://localhost:2375", "", "unix:///a/../etc/docker.sock"]) {
			expect(() => localServerChildEnv({}, "/Users/me", "darwin", endpoint), endpoint).toThrow();
		}
	});
});

describe("findLocalDockerEndpoint", () => {
	const only = (target: string) => (file: string) => file === target;

	it("finds Docker Desktop's socket first, then the classic one", () => {
		const both = (file: string) => file === "/Users/me/.docker/run/docker.sock" || file === "/var/run/docker.sock";
		expect(findLocalDockerEndpoint({ home: "/Users/me", platform: "darwin", isSocket: both })).toBe("unix:///Users/me/.docker/run/docker.sock");
		expect(findLocalDockerEndpoint({ home: "/Users/me", platform: "darwin", isSocket: only("/var/run/docker.sock") })).toBe("unix:///var/run/docker.sock");
		expect(findLocalDockerEndpoint({ home: "/Users/me", platform: "darwin", isSocket: only("/Users/me/.colima/default/docker.sock") })).toBe("unix:///Users/me/.colima/default/docker.sock");
	});

	it("finds a rootless Linux engine for the current user", () => {
		expect(findLocalDockerEndpoint({ home: "/home/me", platform: "linux", uid: 1000, isSocket: only("/run/user/1000/docker.sock") })).toBe("unix:///run/user/1000/docker.sock");
	});

	it("is null when no engine socket exists, so nothing else can be reached", () => {
		expect(findLocalDockerEndpoint({ home: "/Users/me", platform: "darwin", isSocket: () => false })).toBeNull();
	});

	it("uses the local engine pipe on Windows", () => {
		expect(findLocalDockerEndpoint({ home: "C:\\Users\\me", platform: "win32" })).toBe("npipe:////./pipe/docker_engine");
	});
});

describe("isLocalDockerEndpoint", () => {
	it("accepts only a unix socket path or the Windows engine pipe", () => {
		expect(isLocalDockerEndpoint("unix:///var/run/docker.sock")).toBe(true);
		expect(isLocalDockerEndpoint("npipe:////./pipe/docker_engine")).toBe(true);
		for (const bad of [undefined, "", "tcp://127.0.0.1:2375", "tcp://remote:2376", "ssh://me@box", "unix://remote/sock", "fd://", "unix:///a\nb"]) expect(isLocalDockerEndpoint(bad), String(bad)).toBe(false);
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

describe("the production adapter (nodeExec) with a mocked child_process", () => {
	const ENV = { PATH: "/usr/bin", DOCKER_HOST: "unix:///Users/me/.docker/run/docker.sock" };
	const HOSTILE_NAMES = ["my dir", "a'b", 'a"b', "a;rm -rf x", "a$(id)b", "a`id`b", "a|b", "a&b", "a\nb", "a\tb", " leading", "trailing ", "--rm", "-f", "a b c d e f", "ünï cödé", "a\\b"];

	beforeEach(() => {
		for (const name of childProcess.others) childProcess.fns[name]?.mockClear();
		childProcess.execFile.mockReset();
		childProcess.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, Buffer.from("out"), Buffer.from("err")));
	});

	const stackIn = (name: string): StackPaths => {
		const dir = `/Users/me/${name}`;
		return { dir, file: `${dir}/docker-compose.selfhost.yml` };
	};

	it("hands execFile the file, the untouched argument array and only the intended options, never a shell", async () => {
		const spec = upCommand(DOCKER, STACK);

		const result = await runLocalServerCommand(nodeExec, spec, ENV);

		expect(result).toEqual({ error: null, stdout: "out", stderr: "err" });
		expect(childProcess.execFile).toHaveBeenCalledOnce();
		const [file, args, options, callback] = childProcess.execFile.mock.calls[0] as [string, string[], Record<string, unknown>, unknown];
		expect(file).toBe(DOCKER);
		expect(args).toEqual([...BASE, "up", "-d"]);
		expect(Array.isArray(args)).toBe(true);
		expect(options).toEqual({ timeout: 600_000, maxBuffer: 512 * 1024, windowsHide: true, env: ENV });
		expect(options).not.toHaveProperty("shell");
		expect(typeof callback).toBe("function");
	});

	it("keeps every validated path one argument, whatever characters it holds, for every stack command", async () => {
		for (const name of HOSTILE_NAMES) {
			const stack = stackIn(name);
			for (const [spec, tail] of [
				[psCommand(DOCKER, stack), ["ps", "--all", "--format", "json"]],
				[upCommand(DOCKER, stack), ["up", "-d"]],
				[stopCommand(DOCKER, stack), ["stop"]],
				[restartCommand(DOCKER, stack), ["restart"]],
				[logsCommand(DOCKER, stack, "backend", 50), ["logs", "--no-color", "--tail", "50", "backend"]],
			] as const) {
				childProcess.execFile.mockClear();

				await runLocalServerCommand(nodeExec, spec, ENV);

				const [file, args, options] = childProcess.execFile.mock.calls[0] as [string, string[], Record<string, unknown>];
				expect(file, name).toBe(DOCKER);
				expect(args, name).toEqual(["compose", "-f", stack.file, "--project-directory", stack.dir, ...tail]);
				expect(args[2], name).toBe(stack.file);
				expect(args[4], name).toBe(stack.dir);
				expect(args, name).toHaveLength(5 + tail.length);
				expect(options, name).not.toHaveProperty("shell");
			}
		}
	});

	it("never passes shell, a shell binary or a command string for any command, including Docker Desktop's launcher", async () => {
		const stack = stackIn("a b;c");
		const specs = [dockerVersionCommand(DOCKER), composeVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, stack), upCommand(DOCKER, stack), stopCommand(DOCKER, stack), restartCommand(DOCKER, stack), logsCommand(DOCKER, stack, "frontend", 5), openDockerCommand()];
		for (const spec of specs) {
			childProcess.execFile.mockClear();
			await runLocalServerCommand(nodeExec, spec, ENV);
			const [file, args, options] = childProcess.execFile.mock.calls[0] as [string, string[], Record<string, unknown>];
			expect(["/bin/sh", "/bin/bash", "/bin/zsh", "sh", "bash", "cmd.exe"].some((shell) => file.endsWith(shell)), spec.name).toBe(false);
			expect(args.some((arg) => arg === "-c" || arg === "/c"), spec.name).toBe(false);
			expect(options.shell, spec.name).toBeUndefined();
			expect(options.windowsVerbatimArguments, spec.name).toBeUndefined();
			expect(options.windowsHide, spec.name).toBe(true);
		}
	});

	it("uses no other way to start a process", async () => {
		await runLocalServerCommand(nodeExec, upCommand(DOCKER, STACK), ENV);
		await runLocalServerCommand(nodeExec, openDockerCommand(), ENV);
		for (const name of childProcess.others) expect(childProcess.fns[name], name).not.toHaveBeenCalled();
	});

	it("reports a failed process with its error, stdout and stderr as strings", async () => {
		childProcess.execFile.mockImplementation((_f, _a, _o, callback) => callback(Object.assign(new Error("exit 1"), { code: 1 }), Buffer.from(""), Buffer.from("boom")));
		const result = await runLocalServerCommand(nodeExec, stopCommand(DOCKER, STACK), ENV);
		expect(result.error?.code).toBe(1);
		expect(result.stderr).toBe("boom");
	});

	it("passes the abort signal to execFile for cancel", async () => {
		const controller = new AbortController();
		await runLocalServerCommand(nodeExec, stopCommand(DOCKER, STACK), ENV, controller.signal);
		expect((childProcess.execFile.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal).toBe(controller.signal);
	});

	it("does not reach execFile for a command the module did not issue or without a local endpoint", async () => {
		const forged: CommandSpec = { name: "up", file: "/bin/sh", args: ["-c", "echo hi"], timeoutMs: 1000, engine: false };
		await expect(runLocalServerCommand(nodeExec, forged, ENV)).rejects.toThrow();
		await expect(runLocalServerCommand(nodeExec, upCommand(DOCKER, STACK), { PATH: "/usr/bin" })).rejects.toThrow();
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});
});
