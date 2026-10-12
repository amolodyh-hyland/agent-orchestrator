import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { LOCAL_SERVER_LOG_TAIL_MAX, LOCAL_SERVER_SERVICES, type LocalServerService } from "../shared/multica-local-server";

// The one place a command for the local Multica server is built. Every command is a
// fixed argument array (never a shell string) produced by a function of validated
// values; the runner refuses anything that did not come from here.

export const COMPOSE_FILE_NAME = "docker-compose.selfhost.yml";
export const OPEN_BINARY = "/usr/bin/open";

const MAX_BUFFER = 512 * 1024;

const TIMEOUT_MS = {
	version: 10_000,
	list: 10_000,
	ps: 15_000,
	logs: 15_000,
	stop: 60_000,
	restart: 120_000,
	// The first start pulls the images.
	up: 10 * 60_000,
	open: 15_000,
} as const;

export type CommandName = "dockerVersion" | "composeVersion" | "composeList" | "ps" | "up" | "stop" | "restart" | "logs" | "openDocker";

export type CommandSpec = {
	readonly name: CommandName;
	readonly file: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
};

export type StackPaths = {
	/** Canonical stack directory. */
	dir: string;
	/** Canonical path of docker-compose.selfhost.yml inside `dir`. */
	file: string;
};

// Specs made by the builders below. The runner only executes members of this set,
// so a hand-built object (or one spread from a built spec) is refused.
const issued = new WeakSet<CommandSpec>();

function issue(name: CommandName, file: string, args: string[], timeoutMs: number): CommandSpec {
	const spec: CommandSpec = Object.freeze({ name, file, args: Object.freeze(args), timeoutMs });
	issued.add(spec);
	return spec;
}

export function isIssuedCommand(spec: CommandSpec): boolean {
	return issued.has(spec);
}

function assertAbsolute(value: string, what: string): void {
	if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${what} must be an absolute path`);
}

function composeBase(docker: string, stack: StackPaths): string[] {
	assertAbsolute(docker, "docker binary");
	assertAbsolute(stack.dir, "stack directory");
	assertAbsolute(stack.file, "compose file");
	if (path.dirname(stack.file) !== stack.dir || path.basename(stack.file) !== COMPOSE_FILE_NAME) {
		throw new Error("compose file must be the Multica self-hosting file inside the stack directory");
	}
	return ["compose", "-f", stack.file, "--project-directory", stack.dir];
}

export const dockerVersionCommand = (docker: string): CommandSpec => {
	assertAbsolute(docker, "docker binary");
	return issue("dockerVersion", docker, ["version", "--format", "{{.Server.Version}}"], TIMEOUT_MS.version);
};

export const composeVersionCommand = (docker: string): CommandSpec => {
	assertAbsolute(docker, "docker binary");
	return issue("composeVersion", docker, ["compose", "version", "--short"], TIMEOUT_MS.version);
};

export const composeListCommand = (docker: string): CommandSpec => {
	assertAbsolute(docker, "docker binary");
	return issue("composeList", docker, ["compose", "ls", "--all", "--format", "json"], TIMEOUT_MS.list);
};

export const psCommand = (docker: string, stack: StackPaths): CommandSpec =>
	issue("ps", docker, [...composeBase(docker, stack), "ps", "--all", "--format", "json"], TIMEOUT_MS.ps);

export const upCommand = (docker: string, stack: StackPaths): CommandSpec =>
	issue("up", docker, [...composeBase(docker, stack), "up", "-d"], TIMEOUT_MS.up);

export const stopCommand = (docker: string, stack: StackPaths): CommandSpec =>
	issue("stop", docker, [...composeBase(docker, stack), "stop"], TIMEOUT_MS.stop);

export const restartCommand = (docker: string, stack: StackPaths): CommandSpec =>
	issue("restart", docker, [...composeBase(docker, stack), "restart"], TIMEOUT_MS.restart);

export function logsCommand(docker: string, stack: StackPaths, service: LocalServerService, tail: number): CommandSpec {
	if (!(LOCAL_SERVER_SERVICES as readonly string[]).includes(service)) throw new Error("unknown service");
	if (!Number.isInteger(tail) || tail < 1 || tail > LOCAL_SERVER_LOG_TAIL_MAX) throw new Error("tail out of range");
	return issue("logs", docker, [...composeBase(docker, stack), "logs", "--no-color", "--tail", String(tail), service], TIMEOUT_MS.logs);
}

/** Starts Docker Desktop (macOS only; the caller checks the platform). */
export const openDockerCommand = (): CommandSpec => issue("openDocker", OPEN_BINARY, ["-a", "Docker"], TIMEOUT_MS.open);

/** Directories a GUI-launched app does not have on PATH. */
function dockerFallbackDirs(home: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") return [];
	return ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", path.join(home, ".docker", "bin")];
}

function isExecutableFile(file: string): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export type FindDockerOptions = {
	pathEnv?: string;
	home: string;
	platform: NodeJS.Platform;
	isExecutable?: (file: string) => boolean;
};

/** Locates the docker CLI among absolute candidates only; relative PATH entries are ignored. */
export function findDockerBinary(options: FindDockerOptions): string | null {
	const isExecutable = options.isExecutable ?? isExecutableFile;
	const name = options.platform === "win32" ? "docker.exe" : "docker";
	const dirs = [...(options.pathEnv ?? "").split(path.delimiter), ...dockerFallbackDirs(options.home, options.platform)].filter(
		(dir) => dir && path.isAbsolute(dir),
	);
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

const PASS_THROUGH_ENV = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "DOCKER_CONFIG", "SystemRoot", "USERPROFILE", "APPDATA"] as const;

/**
 * The child's environment: a short allow-list plus a PATH that finds Docker's helpers.
 * COMPOSE_* and DOCKER_HOST are deliberately dropped so AO's own environment cannot
 * point a "local" stack at another project or another machine.
 */
export function localServerChildEnv(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {};
	for (const key of PASS_THROUGH_ENV) if (env[key] !== undefined) next[key] = env[key];
	const dirs = [...(env.PATH ?? "").split(path.delimiter), ...dockerFallbackDirs(home, platform), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	next.PATH = [...new Set(dirs.filter((dir) => dir && path.isAbsolute(dir)))].join(path.delimiter);
	return next;
}

export type ExecError = Error & { code?: string | number | null; killed?: boolean };

export type ExecOptions = {
	timeout: number;
	maxBuffer: number;
	windowsHide: boolean;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
};

export type ExecFileLike = (
	file: string,
	args: string[],
	options: ExecOptions,
	callback: (error: ExecError | null, stdout: string, stderr: string) => void,
) => unknown;

export type CommandResult = {
	error: ExecError | null;
	stdout: string;
	stderr: string;
};

export const nodeExec: ExecFileLike = (file, args, options, callback) =>
	nodeExecFile(file, args, options, (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));

/** Runs a command built by this module; anything else is refused before a process exists. */
export function runLocalServerCommand(
	exec: ExecFileLike,
	spec: CommandSpec,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<CommandResult> {
	if (!isIssuedCommand(spec)) return Promise.reject(new Error("command is not on the local server allow-list"));
	if (signal?.aborted) {
		const error = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
		return Promise.resolve({ error, stdout: "", stderr: "" });
	}
	return new Promise((resolve) => {
		exec(
			spec.file,
			[...spec.args],
			{ timeout: spec.timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true, env, ...(signal ? { signal } : {}) },
			(error, stdout, stderr) => resolve({ error, stdout, stderr }),
		);
	});
}
