import { execFile as nodeExecFile } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { LOCAL_SERVER_LOG_TAIL_MAX, LOCAL_SERVER_SERVICES, type LocalServerService } from "../shared/multica-local-server";

// The one place a command for the local Multica server is built. Every command is a
// fixed argument array (never a shell string) produced by a function of validated
// values; the runner refuses anything that did not come from here.

export const COMPOSE_FILE_NAME = "docker-compose.selfhost.yml";
/** Multica's Compose project name; passed with -p so a COMPOSE_PROJECT_NAME in the stack's .env cannot target another project. */
export const COMPOSE_PROJECT_NAME = "multica";
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
	/** Talks to the Docker engine, so it may only run against the pinned local endpoint. */
	readonly engine: boolean;
	/** Runs the docker CLI, so it may only run with AO's own HOME and DOCKER_CONFIG. */
	readonly docker: boolean;
	/** Runs `docker compose`, so it may only run when a trusted Compose plugin was found for this very run. */
	readonly compose: boolean;
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

function issue(name: CommandName, file: string, args: string[], timeoutMs: number, engine = true): CommandSpec {
	const spec: CommandSpec = Object.freeze({ name, file, args: Object.freeze(args), timeoutMs, engine, docker: file !== OPEN_BINARY, compose: file !== OPEN_BINARY && args[0] === "compose" });
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
	return ["compose", "-f", stack.file, "--project-directory", stack.dir, "-p", COMPOSE_PROJECT_NAME];
}

export const dockerVersionCommand = (docker: string): CommandSpec => {
	assertAbsolute(docker, "docker binary");
	return issue("dockerVersion", docker, ["version", "--format", "{{.Server.Version}}"], TIMEOUT_MS.version);
};

export const composeVersionCommand = (docker: string): CommandSpec => {
	assertAbsolute(docker, "docker binary");
	return issue("composeVersion", docker, ["compose", "version", "--short"], TIMEOUT_MS.version, false);
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
export const openDockerCommand = (): CommandSpec => issue("openDocker", OPEN_BINARY, ["-a", "Docker"], TIMEOUT_MS.open, false);

/**
 * The only places Docker's CLI and its helpers (the compose plugin, credential helpers)
 * are looked for: fixed install roots, never AO's inherited PATH. A PATH entry such as a
 * world-writable /tmp/bin could otherwise let another user substitute `docker` or a helper.
 */
function trustedInstallDirs(home: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") return ["C:\\Program Files\\Docker\\Docker\\resources\\bin"];
	if (platform === "darwin") {
		return ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin", path.join(home, ".docker", "bin")];
	}
	return ["/usr/bin", "/usr/local/bin", "/snap/bin", path.join(home, ".docker", "bin")];
}

/** Where Docker's Compose plugin is installed, in order of preference; the real home is only used to look. */
function composePluginCandidates(home: string, platform: NodeJS.Platform): string[] {
	if (platform === "win32") return ["C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins\\docker-compose.exe"];
	const user = path.join(home, ".docker", "cli-plugins", "docker-compose");
	if (platform === "darwin") {
		return [
			"/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose",
			"/usr/local/lib/docker/cli-plugins/docker-compose",
			"/usr/local/libexec/docker/cli-plugins/docker-compose",
			"/opt/homebrew/lib/docker/cli-plugins/docker-compose",
			user,
		];
	}
	return [
		"/usr/libexec/docker/cli-plugins/docker-compose",
		"/usr/lib/docker/cli-plugins/docker-compose",
		"/usr/local/libexec/docker/cli-plugins/docker-compose",
		"/usr/local/lib/docker/cli-plugins/docker-compose",
		user,
	];
}

const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export type TrustStat = { isFile: () => boolean; isDirectory: () => boolean; mode: number; uid: number; gid: number };
export type TrustFs = {
	realpath: (file: string) => string;
	stat: (file: string) => TrustStat;
	lstat: (file: string) => TrustStat;
};

export const nodeTrustFs: TrustFs = {
	realpath: (file) => realpathSync(file),
	stat: (file) => statSync(file),
	lstat: (file) => lstatSync(file),
};

export type TrustContext = {
	/** The current user; without one (Windows) ownership and mode are not judged. */
	uid?: number | undefined;
	gid?: number | undefined;
	fs?: TrustFs;
};

/**
 * A file that will be executed or parsed (the docker binary, the Compose plugin, the compose file,
 * `.env`): owned by root or the current user and not writable by group or others. No group is
 * trusted, not `staff`, not the user's own primary group, not `admin`.
 */
export function fileTrusted(info: TrustStat, context: TrustContext): boolean {
	if (context.uid === undefined) return true;
	return (info.uid === 0 || info.uid === context.uid) && (info.mode & 0o022) === 0;
}

// Root-owned system directories such as /Applications (root:admin, group-writable) are the single
// narrow exception: their group is root/wheel or the administrator group, whose members are
// administrators anyway. A user-owned directory (a Homebrew prefix that is group-writable by
// admin, a folder in staff) gets no such exception.
const ROOT_DIRECTORY_GROUP_IDS = new Set([0, 80]);

/** A directory above or holding something that will be executed or parsed. */
export function directoryTrusted(info: TrustStat, context: TrustContext): boolean {
	if (context.uid === undefined) return true;
	if (info.uid !== 0 && info.uid !== context.uid) return false;
	if ((info.mode & 0o002) !== 0) return false;
	return (info.mode & 0o020) === 0 || (info.uid === 0 && ROOT_DIRECTORY_GROUP_IDS.has(info.gid));
}

function directoryChainTrusted(start: string, context: TrustContext): boolean {
	const fs = context.fs ?? nodeTrustFs;
	let dir = start;
	for (;;) {
		let info: TrustStat;
		try {
			info = fs.stat(dir);
		} catch {
			return false;
		}
		if (!info.isDirectory() || !directoryTrusted(info, context)) return false;
		const parent = path.dirname(dir);
		if (parent === dir) return true;
		dir = parent;
	}
}

/**
 * True when running `file` cannot be hijacked by another local user: the file is a
 * regular file after symlinks are resolved, owned by root or the current user, not
 * writable by others, and so is every directory above it, both where it was found and where
 * it really lives (so a symlink in a writable directory, or a binary in a writable one, fails).
 */
export function isTrustedExecutable(file: string, context: TrustContext = {}): boolean {
	const fs = context.fs ?? nodeTrustFs;
	try {
		const canonical = fs.realpath(file);
		const info = fs.stat(canonical);
		if (!info.isFile() || !fileTrusted(info, context)) return false;
		return directoryChainTrusted(path.dirname(file), context) && directoryChainTrusted(path.dirname(canonical), context);
	} catch {
		return false;
	}
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
	home: string;
	platform: NodeJS.Platform;
	uid?: number | undefined;
	gid?: number | undefined;
	isExecutable?: (file: string) => boolean;
	isTrusted?: (file: string) => boolean;
};

/**
 * Looks for the docker CLI in the trusted install roots only. `untrusted` is true when a docker
 * executable exists in one of them but fails the ownership and permission check (for example a
 * group-writable Homebrew prefix), so the UI can say so instead of "not installed".
 */
export function inspectDockerBinary(options: FindDockerOptions): { path: string | null; untrusted: boolean } {
	const isExecutable = options.isExecutable ?? isExecutableFile;
	const isTrusted = options.isTrusted ?? ((file: string) => isTrustedExecutable(file, { uid: options.uid, gid: options.gid }));
	const name = options.platform === "win32" ? "docker.exe" : "docker";
	let untrusted = false;
	for (const dir of trustedInstallDirs(options.home, options.platform)) {
		if (!path.isAbsolute(dir)) continue;
		const candidate = path.join(dir, name);
		if (!isExecutable(candidate)) continue;
		if (isTrusted(candidate)) return { path: candidate, untrusted };
		untrusted = true;
	}
	return { path: null, untrusted };
}

/** The docker CLI in a trusted install root, or null. */
export function findDockerBinary(options: FindDockerOptions): string | null {
	return inspectDockerBinary(options).path;
}

export type TrustedPathOptions = {
	home: string;
	platform: NodeJS.Platform;
	uid?: number | undefined;
	gid?: number | undefined;
	isTrustedDirectory?: (dir: string) => boolean;
};

/** The directories that may be on the child's PATH: trusted install roots and system directories that pass the same chain check. */
export function trustedPathDirs(options: TrustedPathOptions): string[] {
	const context = { uid: options.uid, gid: options.gid };
	const isTrusted = options.isTrustedDirectory ?? ((dir: string) => directoryChainTrusted(dir, context));
	const dirs = [...trustedInstallDirs(options.home, options.platform), ...(options.platform === "win32" ? [] : SYSTEM_DIRS)];
	return [...new Set(dirs.filter((dir) => path.isAbsolute(dir) && isTrusted(dir)))];
}

export type FindComposePluginOptions = {
	home: string;
	platform: NodeJS.Platform;
	uid?: number | undefined;
	gid?: number | undefined;
	isExecutable?: (file: string) => boolean;
	isTrusted?: (file: string) => boolean;
};

/** The Compose plugin in a trusted install location (same check as docker); `untrusted` when one exists but fails it. */
export function inspectComposePlugin(options: FindComposePluginOptions): { path: string | null; untrusted: boolean } {
	const isExecutable = options.isExecutable ?? isExecutableFile;
	const isTrusted = options.isTrusted ?? ((file: string) => isTrustedExecutable(file, { uid: options.uid, gid: options.gid }));
	let untrusted = false;
	for (const candidate of composePluginCandidates(options.home, options.platform)) {
		if (!path.isAbsolute(candidate) || !isExecutable(candidate)) continue;
		if (isTrusted(candidate)) return { path: candidate, untrusted };
		untrusted = true;
	}
	return { path: null, untrusted };
}

/** The Compose plugin binary in a trusted install location; null when none. */
export function findComposePlugin(options: FindComposePluginOptions): string | null {
	return inspectComposePlugin(options).path;
}

/**
 * What was verified about the Compose plugin: where it was found, where it really lives, and which
 * file that is (device, inode, size, mtime). This travels across every await instead of a "found"
 * boolean, and the runner re-checks it immediately before it spawns, so a plugin that was replaced,
 * removed or made untrustworthy after the lookup is never run.
 */
export type ComposePluginIdentity = {
	readonly path: string;
	readonly realPath: string;
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
};

/** The identity of the file at `file` right now, or null when it cannot be read. Synchronous on purpose. */
export function identifyComposePlugin(file: string): ComposePluginIdentity | null {
	try {
		const realPath = realpathSync(file);
		const info = statSync(realPath);
		if (!info.isFile()) return null;
		return { path: file, realPath, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return null;
	}
}

/** Whether the plugin is still exactly the verified file and still passes the ownership and permission check. Synchronous. */
export function composePluginStillTrusted(identity: ComposePluginIdentity, context: TrustContext = {}): boolean {
	const now = identifyComposePlugin(identity.path);
	return (
		now !== null &&
		now.realPath === identity.realPath &&
		now.dev === identity.dev &&
		now.ino === identity.ino &&
		now.size === identity.size &&
		now.mtimeMs === identity.mtimeMs &&
		isTrustedExecutable(identity.path, context)
	);
}

/** The gate a Compose command needs at spawn time: the verified identity and the re-check to run against it. */
export type ComposePluginGate = {
	readonly identity: ComposePluginIdentity;
	readonly stillTrusted: (identity: ComposePluginIdentity) => boolean;
};

/** True only for an environment localServerChildEnv built with AO's Docker home (a copy or a hand-made one is not). */
export function hasPinnedDockerHome(env: NodeJS.ProcessEnv): boolean {
	const home = env.HOME;
	return pinnedEnvs.has(env) && !!home && path.isAbsolute(home) && env.DOCKER_CONFIG === path.join(home, ".docker");
}

// HOME, USERPROFILE, APPDATA and DOCKER_CONFIG are not passed through: Docker resolves its CLI
// plugins (docker-compose) from its config directory, so those come only from AO's own Docker
// home (see multica-local-server-docker-config.ts).
const PASS_THROUGH_ENV = ["USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"] as const;

const WINDOWS_ENGINE_PIPE = "npipe:////./pipe/docker_engine";

/** Sockets a Docker engine on this computer listens on, in order of preference. */
function localSocketCandidates(home: string, platform: NodeJS.Platform, uid: number | undefined): string[] {
	if (platform === "darwin") {
		return [
			path.join(home, ".docker", "run", "docker.sock"),
			"/var/run/docker.sock",
			path.join(home, ".orbstack", "run", "docker.sock"),
			path.join(home, ".colima", "default", "docker.sock"),
			path.join(home, ".rd", "docker.sock"),
		];
	}
	if (platform === "win32") return [];
	return [
		"/var/run/docker.sock",
		...(uid === undefined ? [] : [`/run/user/${uid}/docker.sock`]),
		path.join(home, ".docker", "desktop", "docker.sock"),
		path.join(home, ".colima", "default", "docker.sock"),
	];
}

function isSocketFile(file: string): boolean {
	try {
		return statSync(file).isSocket();
	} catch {
		return false;
	}
}

export type FindEndpointOptions = {
	home: string;
	platform: NodeJS.Platform;
	uid?: number | undefined;
	isSocket?: (file: string) => boolean;
};

/**
 * The Docker endpoint on THIS computer: the first existing socket from a fixed list (or
 * the Windows engine pipe), as a `unix://` / `npipe://` address, or null when no local
 * engine is listening. Never read from AO's environment or from Docker's contexts, so a
 * remote context or DOCKER_HOST cannot redirect the controls to another machine.
 */
export function findLocalDockerEndpoint(options: FindEndpointOptions): string | null {
	if (options.platform === "win32") return WINDOWS_ENGINE_PIPE;
	const isSocket = options.isSocket ?? isSocketFile;
	for (const candidate of localSocketCandidates(options.home, options.platform, options.uid)) {
		if (path.isAbsolute(candidate) && !/[\u0000-\u001f]/.test(candidate) && isSocket(candidate)) return `unix://${candidate}`;
	}
	return null;
}

/** True only for an address on this computer: a unix socket path or the Windows engine pipe. */
export function isLocalDockerEndpoint(value: string | undefined): boolean {
	if (!value) return false;
	if (value === WINDOWS_ENGINE_PIPE) return true;
	return value.startsWith("unix:///") && !/[\u0000-\u001f]/.test(value) && !value.includes("..");
}

/**
 * The child's environment: a short allow-list, a PATH made only of the trusted directories given (so Docker's helpers are found there and nowhere else), and
 * DOCKER_HOST pinned to the local engine endpoint when there is one. With DOCKER_HOST set
 * the Docker CLI ignores the context named in its configuration, so a remote
 * `currentContext` cannot take over. COMPOSE_*, DOCKER_CONTEXT, DOCKER_CONFIG and the TLS
 * variables from AO's own environment are not passed.
 */
// Environments built by localServerChildEnv with AO's Docker home: the runner only runs docker with these.
const pinnedEnvs = new WeakSet<NodeJS.ProcessEnv>();

export function localServerChildEnv(
	env: NodeJS.ProcessEnv,
	_home: string,
	_platform: NodeJS.Platform,
	endpoint: string | null = null,
	pathDirs: readonly string[] = [],
	dockerHome: string | null = null,
): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = {};
	if (dockerHome !== null) {
		if (!path.isAbsolute(dockerHome) || dockerHome.includes("\0")) throw new Error("Docker home must be an absolute path");
		next.HOME = dockerHome;
		next.DOCKER_CONFIG = path.join(dockerHome, ".docker");
		if (_platform === "win32") next.USERPROFILE = dockerHome;
	}
	for (const key of PASS_THROUGH_ENV) if (env[key] !== undefined) next[key] = env[key];
	// PATH is built only from the trusted directories passed in, never from AO's own PATH.
	next.PATH = pathDirs.filter((dir) => dir !== "" && path.isAbsolute(dir)).join(path.delimiter);
	if (endpoint !== null) {
		if (!isLocalDockerEndpoint(endpoint)) throw new Error("Docker endpoint must be a local socket");
		next.DOCKER_HOST = endpoint;
	}
	if (dockerHome !== null) pinnedEnvs.add(next);
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

/** A refusal by the runner: an Error that carries a machine-readable code, so callers can turn it into a result. */
function refusal(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

/** Runs a command built by this module; anything else is refused before a process exists. */
export function runLocalServerCommand(
	exec: ExecFileLike,
	spec: CommandSpec,
	env: NodeJS.ProcessEnv,
	/** Required: the verified Compose plugin for a Compose command (re-checked here, right before the spawn); null for anything else. */
	plugin: ComposePluginGate | null,
	signal?: AbortSignal,
): Promise<CommandResult> {
	if (!isIssuedCommand(spec)) return Promise.reject(refusal("NOT_ALLOWLISTED", "command is not on the local server allow-list"));
	if (spec.engine && !isLocalDockerEndpoint(env.DOCKER_HOST)) return Promise.reject(refusal("NO_LOCAL_ENGINE", "Docker commands only run against the local engine endpoint"));
	if (spec.docker && !hasPinnedDockerHome(env)) return Promise.reject(refusal("UNPINNED_DOCKER_HOME", "Docker commands only run with AO's own HOME and DOCKER_CONFIG"));
	if (signal?.aborted) {
		const error = Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
		return Promise.resolve({ error, stdout: "", stderr: "" });
	}
	// The last check before the spawn. Nothing is awaited between it and exec(): the Promise executor below
	// runs synchronously, so what was verified is what is started (apart from the window Docker itself leaves
	// between this spawn and its own load of the plugin, which AO cannot close).
	if (spec.compose && (plugin === null || !plugin.stillTrusted(plugin.identity))) {
		return Promise.reject(refusal("NO_TRUSTED_COMPOSE", "Docker Compose commands only run with a trusted Compose plugin"));
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
