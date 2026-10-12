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
	findComposePlugin,
	findDockerBinary,
	findLocalDockerEndpoint,
	inspectComposePlugin,
	inspectDockerBinary,
	hasPinnedDockerHome,
	hasTrustedComposePlugin,
	isIssuedCommand,
	isLocalDockerEndpoint,
	isTrustedExecutable,
	localServerChildEnv,
	logsCommand,
	nodeExec,
	openDockerCommand,
	psCommand,
	restartCommand,
	runLocalServerCommand,
	stopCommand,
	trustedPathDirs,
	upCommand,
	type CommandSpec,
	type TrustFs,
	type ExecFileLike,
	type StackPaths,
} from "./multica-local-server-commands";

const DOCKER = "/usr/local/bin/docker";
const STACK: StackPaths = { dir: "/Users/me/.multica/server", file: "/Users/me/.multica/server/docker-compose.selfhost.yml" };
const AO_HOME = "/ao/docker-home";
const LOCAL_SOCKET = "unix:///Users/me/.docker/run/docker.sock";
/** An environment as the service builds it: AO's Docker home, trusted PATH, local endpoint. */
const pinnedEnv = (endpoint: string | null = LOCAL_SOCKET, composePlugin = true) => localServerChildEnv({}, "/Users/me", "darwin", endpoint, ["/usr/bin"], AO_HOME, composePlugin);
const BASE = ["compose", "-f", STACK.file, "--project-directory", STACK.dir, "-p", "multica"];

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

	it("always names the project, so a COMPOSE_PROJECT_NAME in the stack's .env cannot target another one", () => {
		for (const spec of [psCommand(DOCKER, STACK), upCommand(DOCKER, STACK), stopCommand(DOCKER, STACK), restartCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5)]) {
			const at = spec.args.indexOf("-p");
			expect(at, spec.name).toBeGreaterThan(-1);
			expect(spec.args[at + 1], spec.name).toBe("multica");
			// before the verb, where Compose reads global options
			expect(at, spec.name).toBeLessThan(spec.args.indexOf(spec.name === "ps" ? "ps" : spec.name === "up" ? "up" : spec.name === "stop" ? "stop" : spec.name === "restart" ? "restart" : "logs"));
		}
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
			expect(spec.args).toEqual(["compose", "-f", stack.file, "--project-directory", dir, "-p", "multica", "up", "-d"]);
			expect(spec.args.every((arg) => arg === "up" || arg === "-d" || arg === "compose" || arg === "-f" || arg === "--project-directory" || arg === "-p" || arg === "multica" || arg.startsWith("/"))).toBe(true);
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
	const env = pinnedEnv();

	it("runs an issued command through execFile with timeout, buffer cap, hidden window and the given environment", async () => {
		const exec = vi.fn<ExecFileLike>((_file, _args, _options, callback) => callback(null, "ok", ""));
		const spec = stopCommand(DOCKER, STACK);
		const result = await runLocalServerCommand(exec, spec, env);

		expect(result).toEqual({ error: null, stdout: "ok", stderr: "" });
		expect(exec).toHaveBeenCalledExactlyOnceWith(DOCKER, [...spec.args], { timeout: 60_000, maxBuffer: 512 * 1024, windowsHide: true, env }, expect.any(Function));
	});

	it("refuses a command that was not built by this module, including a copy of a built one", async () => {
		const exec = vi.fn<ExecFileLike>();
		const forged: CommandSpec = { name: "up", file: DOCKER, args: ["compose", "down", "-v"], timeoutMs: 1000, engine: true, docker: true, compose: true };
		const copied: CommandSpec = { ...upCommand(DOCKER, STACK) };

		await expect(runLocalServerCommand(exec, forged, env)).rejects.toThrow(/allow-list/);
		await expect(runLocalServerCommand(exec, copied, env)).rejects.toThrow(/allow-list/);
		expect(isIssuedCommand(forged)).toBe(false);
		expect(exec).not.toHaveBeenCalled();
	});

	it("refuses an engine command without a local endpoint, whatever the environment says", async () => {
		const exec = vi.fn<ExecFileLike>();
		const remote = (host: string) => {
			const pinned = pinnedEnv();
			pinned.DOCKER_HOST = host;
			return pinned;
		};
		for (const bad of [pinnedEnv(null), remote("tcp://10.0.0.5:2375"), remote("ssh://me@box")]) {
			for (const spec of [dockerVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, STACK), upCommand(DOCKER, STACK), stopCommand(DOCKER, STACK), restartCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5)]) {
				await expect(runLocalServerCommand(exec, spec, bad)).rejects.toThrow(/local engine/);
			}
		}
		expect(exec).not.toHaveBeenCalled();
	});

	it("lets the commands that never contact the engine run without an endpoint", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		await runLocalServerCommand(exec, composeVersionCommand(DOCKER), pinnedEnv(null));
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

	it("keeps a short allow-list and drops secrets, COMPOSE_*, DOCKER_CONTEXT, remote engine settings and the inherited HOME and DOCKER_CONFIG", () => {
		const env = localServerChildEnv(
			{
				PATH: "/usr/bin:relative/bin",
				HOME: "/tmp/evil-home",
				USERPROFILE: "C:\\evil",
				APPDATA: "C:\\evil\\appdata",
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
			["/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin", "relative/bin"],
			"/Users/me/.ao/local-server-docker",
		);

		expect(Object.keys(env).sort()).toEqual(["DOCKER_CONFIG", "DOCKER_HOST", "HOME", "LANG", "PATH"]);
		expect(env.DOCKER_HOST).toBe(SOCKET);
		expect(env.HOME).toBe("/Users/me/.ao/local-server-docker");
		expect(env.DOCKER_CONFIG).toBe("/Users/me/.ao/local-server-docker/.docker");
		expect(env.PATH).toBe("/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin");
	});

	it("gives no HOME or DOCKER_CONFIG at all when AO's Docker home is not given, never the inherited ones", () => {
		const env = localServerChildEnv({ HOME: "/tmp/evil-home", DOCKER_CONFIG: "/tmp/evil-config" }, "/Users/me", "darwin", SOCKET, ["/usr/bin"]);
		expect(env.HOME).toBeUndefined();
		expect(env.DOCKER_CONFIG).toBeUndefined();
	});

	it("refuses a Docker home that is not an absolute path, and sets USERPROFILE with it on Windows", () => {
		expect(() => localServerChildEnv({}, "/Users/me", "darwin", null, [], "relative/home")).toThrow();
		expect(localServerChildEnv({}, "C:\\Users\\me", "win32", null, [], "/ao/home").USERPROFILE).toBe("/ao/home");
	});

	it("builds PATH only from the trusted directories given, never from AO's own PATH", () => {
		const env = localServerChildEnv({ PATH: "/tmp/bin:/usr/bin:/home/evil/bin" }, "/Users/me", "darwin", null, ["/usr/bin"]);
		expect(env.PATH).toBe("/usr/bin");
		expect(localServerChildEnv({ PATH: "/tmp/bin" }, "/Users/me", "darwin").PATH).toBe("");
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

describe("inspecting for an untrusted docker or Compose plugin", () => {
	const executable = (file: string) => file === "/opt/homebrew/bin/docker" || file === "/opt/homebrew/lib/docker/cli-plugins/docker-compose";

	it("says when docker exists but fails the check, instead of reporting it as missing", () => {
		expect(inspectDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: () => false })).toEqual({ path: null, untrusted: true });
		expect(inspectDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: () => true })).toEqual({ path: "/opt/homebrew/bin/docker", untrusted: false });
		expect(inspectDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: () => false, isTrusted: () => false })).toEqual({ path: null, untrusted: false });
	});

	it("takes a later trusted docker and still notes nothing is wrong", () => {
		const both = (file: string) => file === "/usr/local/bin/docker" || file === "/opt/homebrew/bin/docker";
		const result = inspectDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: both, isTrusted: (file) => file === "/opt/homebrew/bin/docker" });
		expect(result.path).toBe("/opt/homebrew/bin/docker");
	});

	it("says the same for the Compose plugin", () => {
		expect(inspectComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: () => false })).toEqual({ path: null, untrusted: true });
		expect(inspectComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: () => false, isTrusted: () => false })).toEqual({ path: null, untrusted: false });
	});

	it("a group-writable Homebrew layout is reported untrusted by the real check on a fake tree", () => {
		const entries: Record<string, FakeEntry> = {
			"/": { type: "dir", mode: 0o755 },
			"/opt": { type: "dir", mode: 0o755 },
			"/opt/homebrew": { type: "dir", mode: 0o775, uid: 501, gid: 80 },
			"/opt/homebrew/bin": { type: "dir", mode: 0o755, uid: 501, gid: 80 },
			"/opt/homebrew/bin/docker": { type: "file", mode: 0o755, uid: 501, gid: 80 },
		};
		const fs = fakeTree(entries);
		const result = inspectDockerBinary({ home: "/Users/me", platform: "darwin", uid: 501, gid: 20, isExecutable: (file) => file in entries, isTrusted: (file) => isTrustedExecutable(file, { uid: 501, gid: 20, fs }) });
		expect(result).toEqual({ path: null, untrusted: true });
	});
});

describe("findComposePlugin", () => {
	const only = (target: string) => (file: string) => file === target;
	const ever = () => true;

	it("finds the plugin in Docker Desktop's bundle or a system plugin directory, never in an inherited location", () => {
		expect(findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: only("/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose"), isTrusted: ever })).toBe(
			"/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose",
		);
		expect(findComposePlugin({ home: "/home/me", platform: "linux", isExecutable: only("/usr/libexec/docker/cli-plugins/docker-compose"), isTrusted: ever })).toBe("/usr/libexec/docker/cli-plugins/docker-compose");
		expect(findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: only("/tmp/evil/cli-plugins/docker-compose"), isTrusted: ever })).toBeNull();
	});

	it("looks in the user's own ~/.docker/cli-plugins only after the system locations, and only if it is trusted", () => {
		const user = "/Users/me/.docker/cli-plugins/docker-compose";
		expect(findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: only(user), isTrusted: ever })).toBe(user);
		expect(findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: only(user), isTrusted: () => false })).toBeNull();
	});

	it("skips a plugin that fails the ownership and permission check and takes the next trusted one", () => {
		const executable = (file: string) => file.endsWith("/docker-compose");
		const found = findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: (file) => file.startsWith("/opt/homebrew/") });
		expect(found).toBe("/opt/homebrew/lib/docker/cli-plugins/docker-compose");
	});

	it("only ever considers the fixed install locations, whatever PATH or HOME says", () => {
		const allowed: Record<string, string[]> = {
			darwin: ["/Applications/Docker.app/Contents/Resources/cli-plugins/", "/usr/local/lib/docker/cli-plugins/", "/usr/local/libexec/docker/cli-plugins/", "/opt/homebrew/lib/docker/cli-plugins/", "/Users/me/.docker/cli-plugins/"],
			linux: ["/usr/libexec/docker/cli-plugins/", "/usr/lib/docker/cli-plugins/", "/usr/local/libexec/docker/cli-plugins/", "/usr/local/lib/docker/cli-plugins/", "/home/me/.docker/cli-plugins/"],
		};
		for (const platform of ["darwin", "linux"] as const) {
			const probed: string[] = [];
			const home = platform === "darwin" ? "/Users/me" : "/home/me";
			findComposePlugin({ home, platform, isExecutable: (file) => (probed.push(file), false), isTrusted: () => true });
			expect(probed.length, platform).toBeGreaterThan(3);
			for (const file of probed) {
				expect(allowed[platform]?.some((prefix) => file === `${prefix}docker-compose`), file).toBe(true);
			}
		}
	});

	it("is null when nothing is trusted", () => {
		expect(findComposePlugin({ home: "/Users/me", platform: "darwin", isExecutable: () => true, isTrusted: () => false })).toBeNull();
	});
});

describe("hasPinnedDockerHome and the runner guard", () => {
	it("recognizes only an environment built with AO's Docker home", () => {
		expect(hasPinnedDockerHome(pinnedEnv())).toBe(true);
		expect(hasPinnedDockerHome(pinnedEnv(null))).toBe(true);
		const handMade = { HOME: AO_HOME, DOCKER_CONFIG: `${AO_HOME}/.docker`, DOCKER_HOST: LOCAL_SOCKET };
		expect(hasPinnedDockerHome(handMade)).toBe(false);
		expect(hasPinnedDockerHome({ ...pinnedEnv() })).toBe(false);
		expect(hasPinnedDockerHome({})).toBe(false);
		expect(hasPinnedDockerHome(localServerChildEnv({ HOME: "/Users/me", DOCKER_CONFIG: "/Users/me/.docker" }, "/Users/me", "darwin", LOCAL_SOCKET, ["/usr/bin"]))).toBe(false);
	});

	it("an environment that was changed after it was built is no longer AO's", () => {
		const env = pinnedEnv();
		env.HOME = "/Users/me";
		expect(hasPinnedDockerHome(env)).toBe(false);
		const config = pinnedEnv();
		config.DOCKER_CONFIG = "/Users/me/.docker";
		expect(hasPinnedDockerHome(config)).toBe(false);
	});

	it("refuses every docker command whose environment is not AO's own, even with the user's real HOME/.docker and a local endpoint", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		const real = localServerChildEnv({ HOME: "/Users/me" }, "/Users/me", "darwin", LOCAL_SOCKET, ["/usr/bin"]);
		for (const bad of [
			{ ...real, HOME: "/Users/me", DOCKER_CONFIG: "/Users/me/.docker" },
			{ ...pinnedEnv() },
			{ PATH: "/usr/bin", DOCKER_HOST: LOCAL_SOCKET },
			{ PATH: "/usr/bin", DOCKER_HOST: LOCAL_SOCKET, HOME: "/tmp/evil", DOCKER_CONFIG: "/tmp/evil/.docker" },
		]) {
			for (const spec of [dockerVersionCommand(DOCKER), composeVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, STACK), upCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5)]) {
				await expect(runLocalServerCommand(exec, spec, bad), spec.name).rejects.toThrow(/HOME and DOCKER_CONFIG/);
			}
		}
		expect(exec).not.toHaveBeenCalled();
		await runLocalServerCommand(exec, openDockerCommand(), { PATH: "/usr/bin" });
		expect(exec).toHaveBeenCalledOnce();
	});
});

describe("Compose commands need a trusted Compose plugin for the run", () => {
	const COMPOSE_SPECS = () => [composeVersionCommand(DOCKER), composeListCommand(DOCKER), psCommand(DOCKER, STACK), upCommand(DOCKER, STACK), stopCommand(DOCKER, STACK), restartCommand(DOCKER, STACK), logsCommand(DOCKER, STACK, "backend", 5)];

	it("marks exactly the docker compose commands as Compose commands", () => {
		for (const spec of COMPOSE_SPECS()) expect(spec.compose, spec.name).toBe(true);
		expect(dockerVersionCommand(DOCKER).compose).toBe(false);
		expect(openDockerCommand().compose).toBe(false);
	});

	it("refuses every Compose command when the environment was built without a trusted plugin, and runs docker version", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		const noPlugin = pinnedEnv(LOCAL_SOCKET, false);
		for (const spec of COMPOSE_SPECS()) await expect(runLocalServerCommand(exec, spec, noPlugin), spec.name).rejects.toThrow(/trusted Compose plugin/);
		expect(exec).not.toHaveBeenCalled();
		await runLocalServerCommand(exec, dockerVersionCommand(DOCKER), noPlugin);
		expect(exec).toHaveBeenCalledOnce();
	});

	it("runs them with an environment that has one, and refuses a copy of it", async () => {
		const exec = vi.fn<ExecFileLike>((_f, _a, _o, callback) => callback(null, "", ""));
		for (const spec of COMPOSE_SPECS()) await runLocalServerCommand(exec, spec, pinnedEnv(LOCAL_SOCKET, true));
		expect(exec).toHaveBeenCalledTimes(7);
		await expect(runLocalServerCommand(exec, upCommand(DOCKER, STACK), { ...pinnedEnv() })).rejects.toThrow();
	});

	it("an environment that was built without the plugin cannot be upgraded afterwards", async () => {
		const exec = vi.fn<ExecFileLike>();
		const env = pinnedEnv(LOCAL_SOCKET, false);
		env.COMPOSE_PLUGIN = "1";
		await expect(runLocalServerCommand(exec, psCommand(DOCKER, STACK), env)).rejects.toThrow();
		expect(hasTrustedComposePlugin(env)).toBe(false);
		expect(hasTrustedComposePlugin(pinnedEnv(LOCAL_SOCKET, true))).toBe(true);
	});
});

describe("findDockerBinary", () => {
	const only = (target: string) => (file: string) => file === target;
	const ever = () => true;

	it("finds docker in the usual trusted install roots", () => {
		expect(findDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: only("/opt/homebrew/bin/docker"), isTrusted: ever })).toBe("/opt/homebrew/bin/docker");
		expect(findDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: only("/Applications/Docker.app/Contents/Resources/bin/docker"), isTrusted: ever })).toBe(
			"/Applications/Docker.app/Contents/Resources/bin/docker",
		);
		expect(findDockerBinary({ home: "/home/me", platform: "linux", isExecutable: only("/usr/bin/docker"), isTrusted: ever })).toBe("/usr/bin/docker");
	});

	it("never looks anywhere else: a docker in a PATH directory such as /tmp/bin is not found", () => {
		const original = process.env.PATH;
		process.env.PATH = "/tmp/bin:/home/evil/bin:relative/bin";
		try {
			const looked: string[] = [];
			const result = findDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: (file) => (looked.push(file), file.startsWith("/tmp/") || file.startsWith("/home/evil/")), isTrusted: ever });
			expect(result).toBeNull();
			expect(looked.some((file) => file.startsWith("/tmp/") || file.startsWith("/home/evil/") || !file.startsWith("/"))).toBe(false);
		} finally {
			process.env.PATH = original;
		}
	});

	it("skips a candidate that is not trusted and takes the next one", () => {
		const executable = (file: string) => file === "/usr/local/bin/docker" || file === "/opt/homebrew/bin/docker";
		expect(findDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: (file) => file !== "/usr/local/bin/docker" })).toBe("/opt/homebrew/bin/docker");
		expect(findDockerBinary({ home: "/Users/me", platform: "darwin", isExecutable: executable, isTrusted: () => false })).toBeNull();
	});

	it("returns null when nothing is executable", () => {
		expect(findDockerBinary({ home: "/Users/me", platform: "linux", isExecutable: () => false, isTrusted: ever })).toBeNull();
	});
});

type FakeEntry = { type: "file" | "dir" | "link"; mode: number; uid?: number; gid?: number; target?: string };

/** An in-memory file system, so ownership, modes and symlinks can be set at will. */
function fakeTree(entries: Record<string, FakeEntry>): TrustFs {
	const get = (file: string): FakeEntry => {
		const entry = entries[file];
		if (!entry) throw new Error(`ENOENT ${file}`);
		return entry;
	};
	const resolve = (file: string): string => {
		const entry = get(file);
		return entry.type === "link" ? resolve(entry.target as string) : file;
	};
	const stat = (file: string) => {
		const entry = get(resolve(file));
		return { isFile: () => entry.type === "file", isDirectory: () => entry.type === "dir", mode: entry.mode, uid: entry.uid ?? 0, gid: entry.gid ?? 0 };
	};
	return { realpath: resolve, stat, lstat: stat };
}

describe("isTrustedExecutable", () => {
	const ME = { uid: 501, gid: 20 };
	const dir = (mode = 0o755, uid = 0, gid = 0): FakeEntry => ({ type: "dir", mode, uid, gid });
	const file = (mode = 0o755, uid = 0, gid = 0): FakeEntry => ({ type: "file", mode, uid, gid });
	const base: Record<string, FakeEntry> = { "/": dir(), "/usr": dir(), "/usr/local": dir(), "/usr/local/bin": dir(), "/usr/local/bin/docker": file() };
	const trusted = (entries: Record<string, FakeEntry>, target = "/usr/local/bin/docker", context = ME) => isTrustedExecutable(target, { ...context, fs: fakeTree(entries) });

	it("accepts a root-owned binary in root-owned, non-writable directories", () => {
		expect(trusted(base)).toBe(true);
	});

	it("accepts a binary owned by the current user (Homebrew) and the Docker Desktop symlink into /Applications (admin group)", () => {
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o755, 501, 20) })).toBe(true);
		const entries: Record<string, FakeEntry> = {
			...base,
			"/usr/local/bin/docker": { type: "link", mode: 0o755, target: "/Applications/Docker.app/Contents/Resources/bin/docker" },
			"/Applications": dir(0o775, 0, 80),
			"/Applications/Docker.app": dir(0o755, 0, 80),
			"/Applications/Docker.app/Contents": dir(0o755, 0, 80),
			"/Applications/Docker.app/Contents/Resources": dir(0o755, 0, 80),
			"/Applications/Docker.app/Contents/Resources/bin": dir(0o755, 0, 80),
			"/Applications/Docker.app/Contents/Resources/bin/docker": file(0o755, 0, 80),
		};
		expect(trusted(entries)).toBe(true);
	});

	it("rejects a world-writable directory holding the binary, such as /tmp/bin", () => {
		const entries = { "/": dir(), "/tmp": dir(0o1777), "/tmp/bin": dir(0o777, 502), "/tmp/bin/docker": file(0o755, 502) };
		expect(trusted(entries, "/tmp/bin/docker")).toBe(false);
	});

	it("rejects a binary under a world-writable or sticky world-writable ancestor, even if the leaf directory is private", () => {
		for (const mode of [0o777, 0o1777]) {
			const entries = { "/": dir(), "/tmp": dir(mode), "/tmp/me": dir(0o700, 501, 20), "/tmp/me/docker": file(0o700, 501, 20) };
			expect(trusted(entries, "/tmp/me/docker"), String(mode)).toBe(false);
		}
	});

	it("accepts a group-writable directory only when it is root-owned with group root/wheel or admin (/Applications is root:admin 775)", () => {
		const withDir = (uid: number, gid: number) => ({ ...base, "/usr/local/bin": dir(0o775, uid, gid) });
		expect(trusted(withDir(0, 0))).toBe(true);
		expect(trusted(withDir(0, 80))).toBe(true);
	});

	it("rejects every group-writable directory that is not root-owned, whatever the group: Homebrew admin 775, staff, the primary group", () => {
		const withDir = (uid: number, gid: number) => ({ ...base, "/usr/local/bin": dir(0o775, uid, gid) });
		for (const gid of [0, 20, 50, 80, 1234]) {
			expect(trusted(withDir(501, gid)), `user-owned dir gid ${gid}`).toBe(false);
		}
		expect(trusted(withDir(501, 20), "/usr/local/bin/docker", { uid: 501, gid: 20 })).toBe(false);
		expect(trusted(withDir(501, 80), "/opt/homebrew/bin/docker")).toBe(false);
	});

	it("rejects a root-owned group-writable directory for a shared group", () => {
		for (const gid of [20, 50, 1234]) expect(trusted({ ...base, "/usr/local/bin": dir(0o775, 0, gid) }), String(gid)).toBe(false);
	});

	it("rejects a docker binary that is group-writable, for every group including root and admin, owned by root or the user", () => {
		for (const gid of [0, 20, 50, 80, 1234]) {
			for (const uid of [0, 501]) expect(trusted({ ...base, "/usr/local/bin/docker": file(0o775, uid, gid) }), `uid ${uid} gid ${gid}`).toBe(false);
		}
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o755, 501, 80) })).toBe(true);
	});

	it("rejects files or directories owned by another user", () => {
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o755, 502) })).toBe(false);
		expect(trusted({ ...base, "/usr/local/bin": dir(0o755, 502) })).toBe(false);
		expect(trusted({ ...base, "/usr": dir(0o755, 502) })).toBe(false);
	});

	it("rejects a binary that others can write", () => {
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o757) })).toBe(false);
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o775, 0, 1234) })).toBe(false);
	});

	it("rejects a symlink in a writable directory even when it points into a trusted place", () => {
		const entries: Record<string, FakeEntry> = { ...base, "/tmp": dir(0o1777), "/tmp/bin": dir(0o777, 502), "/tmp/bin/docker": { type: "link", mode: 0o777, target: "/usr/local/bin/docker" } };
		expect(trusted(entries, "/tmp/bin/docker")).toBe(false);
	});

	it("rejects a trusted-looking symlink whose real location is writable", () => {
		const entries: Record<string, FakeEntry> = {
			...base,
			"/usr/local/bin/docker": { type: "link", mode: 0o755, target: "/tmp/real/docker" },
			"/tmp": dir(0o1777),
			"/tmp/real": dir(0o777, 502),
			// The file itself looks fine (root-owned, 0755): only the writable directory it lives in gives it away.
			"/tmp/real/docker": file(0o755),
		};
		expect(trusted(entries)).toBe(false);
	});

	it("rejects something that is not a regular file, a missing path and a dangling link", () => {
		expect(trusted({ ...base, "/usr/local/bin/docker": dir() })).toBe(false);
		expect(trusted({ "/": dir() }, "/usr/local/bin/docker")).toBe(false);
		expect(trusted({ ...base, "/usr/local/bin/docker": { type: "link", mode: 0o755, target: "/nowhere" } })).toBe(false);
	});

	it("does not judge ownership where there is no user id (Windows)", () => {
		expect(trusted({ ...base, "/usr/local/bin/docker": file(0o777, 999) }, "/usr/local/bin/docker", {} as typeof ME)).toBe(true);
	});
});

describe("trustedPathDirs", () => {
	it("keeps only install roots and system directories that pass the check, and no inherited PATH", () => {
		const dirs = trustedPathDirs({ home: "/Users/me", platform: "darwin", isTrustedDirectory: (dir) => dir !== "/opt/homebrew/bin" && dir !== "/usr/sbin" });
		expect(dirs).toEqual(["/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin", "/Users/me/.docker/bin", "/usr/bin", "/bin", "/sbin"]);
	});

	it("is empty when nothing is trusted", () => {
		expect(trustedPathDirs({ home: "/home/me", platform: "linux", isTrustedDirectory: () => false })).toEqual([]);
	});
});

describe("the production adapter (nodeExec) with a mocked child_process", () => {
	const ENV = pinnedEnv();
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
				expect(args, name).toEqual(["compose", "-f", stack.file, "--project-directory", stack.dir, "-p", "multica", ...tail]);
				expect(args[2], name).toBe(stack.file);
				expect(args[4], name).toBe(stack.dir);
				expect(args, name).toHaveLength(7 + tail.length);
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
		const forged: CommandSpec = { name: "up", file: "/bin/sh", args: ["-c", "echo hi"], timeoutMs: 1000, engine: false, docker: false, compose: false };
		await expect(runLocalServerCommand(nodeExec, forged, ENV)).rejects.toThrow();
		await expect(runLocalServerCommand(nodeExec, upCommand(DOCKER, STACK), pinnedEnv(null))).rejects.toThrow();
		expect(childProcess.execFile).not.toHaveBeenCalled();
	});
});
