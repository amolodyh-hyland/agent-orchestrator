import { mkdir, lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMPOSE_FILE_NAME, ownedAndNotWritableByOthers, type StackPaths, type TrustStat } from "./multica-local-server-commands";

export const LOCAL_SERVER_SETTINGS_FILE_NAME = "multica-local-server.json";
export const ENV_FILE_NAME = ".env";
export const ENV_EXAMPLE_FILE_NAME = ".env.example";

const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ENV_EXAMPLE_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 256 * 1024;

export type StackCheckError =
	| "not_absolute"
	| "not_found"
	| "not_directory"
	| "unsafe_directory"
	| "no_compose_file"
	| "unsafe_compose_file"
	| "unsafe_compose_content"
	| "unsafe_env_file"
	| "not_multica";

export type StackCheck = ({ ok: true } & StackPaths) | { ok: false; error: StackCheckError };

type StackStat = TrustStat & { isSymbolicLink: () => boolean; size: number };

export type StackFs = {
	realpath: (file: string) => Promise<string>;
	lstat: (file: string) => Promise<StackStat>;
	stat: (file: string) => Promise<StackStat>;
	readFile: (file: string) => Promise<string>;
};

export const nodeStackFs: StackFs = {
	realpath: (file) => realpath(file),
	lstat: (file) => lstat(file),
	stat: (file) => stat(file),
	readFile: (file) => readFile(file, "utf8"),
};

export type ValidateOptions = {
	fs?: StackFs;
	/** The current user's ids; ownership and mode checks are skipped where there is none (Windows). */
	uid?: number | undefined;
	gid?: number | undefined;
};

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function currentGid(): number | undefined {
	return typeof process.getgid === "function" ? process.getgid() : undefined;
}

// Keys that give a service the host (or other files, or other projects): none is in Multica's own file.
const FORBIDDEN_COMPOSE_KEYS = [
	"include",
	"extends",
	"env_file",
	"privileged",
	"pid",
	"ipc",
	"uts",
	"userns_mode",
	"cgroup_parent",
	"cgroup",
	"devices",
	"cap_add",
	"security_opt",
	"network_mode",
	"volumes_from",
	"sysctls",
	"build",
	"configs",
	"secrets",
	"develop",
	"runtime",
	"gpus",
	"group_add",
	"post_start",
	"pre_stop",
	"label_file",
];
const FORBIDDEN_KEY_PATTERN = new RegExp(`(^|[\\s{,\\[])(${FORBIDDEN_COMPOSE_KEYS.join("|")})\\s*:`, "m");
const NAMED_VOLUME_ITEM = /^[A-Za-z0-9_][A-Za-z0-9_.-]*:\//;
const LOOPBACK_PORT_ITEM = /^(127\.0\.0\.1|\[::1\]|localhost):/;

/**
 * A conservative text check that the compose file hands out nothing beyond named volumes and
 * loopback ports: no include/extends/env_file/privileged/host namespaces/devices/build,
 * no bind mounts (a list item `source:target` must have a plain volume name as its source),
 * no port published beyond loopback, and no flow-style `volumes:`/`ports:` that would hide
 * either. Multica's own file passes; an unusual one is refused rather than guessed at. This
 * is a guard against tampering and mistakes, not a sandbox: the image still comes from the
 * `.env` file the user controls, and Compose runs whatever the file legitimately says.
 */
export function unsafeComposeReason(text: string): string | null {
	if (FORBIDDEN_KEY_PATTERN.test(text)) return "forbidden_key";
	if (/\btype\s*:\s*["']?bind\b/.test(text)) return "bind_mount";
	if (/^[ \t]*(volumes|ports)[ \t]*:[ \t]*[^\s#]/m.test(text)) return "flow_style";
	for (const line of text.split("\n")) {
		const item = /^\s*-\s+(.*?)\s*$/.exec(line);
		if (!item) continue;
		const value = (item[1] ?? "").replace(/^["']|["']$/g, "");
		if (!value.includes(":")) continue;
		if (NAMED_VOLUME_ITEM.test(value) || LOOPBACK_PORT_ITEM.test(value)) continue;
		return "host_path_or_port";
	}
	return null;
}

async function ancestorsTrusted(dir: string, fs: StackFs, uid: number | undefined, gid: number | undefined): Promise<boolean> {
	let current = dir;
	for (;;) {
		const info = await fs.stat(current);
		if (!info.isDirectory() || !ownedAndNotWritableByOthers(info, { uid, gid })) return false;
		const parent = path.dirname(current);
		if (parent === current) return true;
		current = parent;
	}
}

function insideDirectory(dir: string, file: string): boolean {
	const relative = path.relative(dir, file);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** A sanity check that the file is Multica's self-hosting stack; the user picked the folder, so this is not a security boundary. */
export function looksLikeMulticaCompose(text: string): boolean {
	return /^name:\s*multica\s*$/m.test(text) && ["postgres", "backend", "frontend"].every((service) => new RegExp(`^  ${service}:\\s*$`, "m").test(text));
}

/**
 * Validates a stack folder before any command can name it: absolute, canonical,
 * owned by the user and not writable by others, with a plain (non-symlink) compose
 * file of the fixed name that stays inside it and is Multica's. Returns the canonical
 * directory and file, which are the only paths a command is built from.
 */
export async function validateStackDir(dir: string, options: ValidateOptions = {}): Promise<StackCheck> {
	const fs = options.fs ?? nodeStackFs;
	const uid = "uid" in options ? options.uid : currentUid();
	const gid = "gid" in options ? options.gid : currentGid();
	if (typeof dir !== "string" || dir.includes("\0") || !path.isAbsolute(dir)) return { ok: false, error: "not_absolute" };
	let canonical: string;
	try {
		canonical = await fs.realpath(dir);
	} catch {
		return { ok: false, error: "not_found" };
	}
	try {
		const info = await fs.stat(canonical);
		if (!info.isDirectory()) return { ok: false, error: "not_directory" };
		// The folder and every directory above it: someone who can write to a parent can swap the folder.
		if (uid !== undefined && !(await ancestorsTrusted(canonical, fs, uid, gid))) return { ok: false, error: "unsafe_directory" };
	} catch {
		return { ok: false, error: "not_found" };
	}
	const file = path.join(canonical, COMPOSE_FILE_NAME);
	let fileInfo: Awaited<ReturnType<StackFs["lstat"]>>;
	try {
		fileInfo = await fs.lstat(file);
	} catch {
		return { ok: false, error: "no_compose_file" };
	}
	if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.size > MAX_COMPOSE_BYTES) return { ok: false, error: "unsafe_compose_file" };
	if (uid !== undefined && (fileInfo.uid !== uid || !ownedAndNotWritableByOthers(fileInfo, { uid, gid }))) return { ok: false, error: "unsafe_compose_file" };
	try {
		const real = await fs.realpath(file);
		if (real !== file || !insideDirectory(canonical, real)) return { ok: false, error: "unsafe_compose_file" };
		const text = await fs.readFile(file);
		if (!looksLikeMulticaCompose(text)) return { ok: false, error: "not_multica" };
		if (unsafeComposeReason(text) !== null) return { ok: false, error: "unsafe_compose_content" };
	} catch {
		return { ok: false, error: "unsafe_compose_file" };
	}
	// An existing .env is read by Compose: it must be a plain file of the user's that others cannot write. AO never reads it.
	const envFile = path.join(canonical, ENV_FILE_NAME);
	try {
		const envInfo = await fs.lstat(envFile);
		if (envInfo.isSymbolicLink() || !envInfo.isFile() || envInfo.size > MAX_ENV_BYTES) return { ok: false, error: "unsafe_env_file" };
		// Secrets live here, so unlike the folder it is not writable by any group at all.
		if (uid !== undefined && (envInfo.uid !== uid || (envInfo.mode & 0o022) !== 0 || !ownedAndNotWritableByOthers(envInfo, { uid, gid }))) return { ok: false, error: "unsafe_env_file" };
	} catch (error) {
		if ((error as { code?: string } | null)?.code !== "ENOENT") return { ok: false, error: "unsafe_env_file" };
	}
	return { ok: true, dir: canonical, file };
}

// --- the saved stack folder (a separate file from the server switch's settings) ---

let settingsQueue: Promise<void> = Promise.resolve();

export type LocalServerSettings = { stackDir: string };

function coerceSettings(raw: unknown): LocalServerSettings {
	const stackDir = raw && typeof raw === "object" ? (raw as Record<string, unknown>).stackDir : undefined;
	return { stackDir: typeof stackDir === "string" && path.isAbsolute(stackDir) && !stackDir.includes("\0") ? stackDir : "" };
}

export async function readLocalServerSettings(stateDir: string): Promise<LocalServerSettings> {
	try {
		return coerceSettings(JSON.parse(await readFile(path.join(stateDir, LOCAL_SERVER_SETTINGS_FILE_NAME), "utf8")));
	} catch {
		return { stackDir: "" };
	}
}

export function writeLocalServerSettings(stateDir: string, settings: LocalServerSettings): Promise<LocalServerSettings> {
	const operation = async (): Promise<LocalServerSettings> => {
		const next = coerceSettings(settings);
		await mkdir(stateDir, { recursive: true, mode: 0o750 });
		const temporary = path.join(stateDir, `.multica-local-server-${process.pid}-${Date.now()}.json`);
		await writeFile(temporary, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path.join(stateDir, LOCAL_SERVER_SETTINGS_FILE_NAME));
		return next;
	};
	const queued = settingsQueue.then(operation, operation);
	settingsQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

// --- first-time setup: .env with fresh random secrets ---

export type SetupOutcome = "created" | "already_set_up" | "failed";

export type SetupDeps = {
	randomBytes: (size: number) => Buffer;
	readTemplate: (file: string) => Promise<string>;
	statTemplate: (file: string) => Promise<{ isFile: () => boolean; isSymbolicLink: () => boolean; size: number }>;
	/** Creates the file exclusively with mode 0600; rejects with EEXIST when it exists. */
	createFile: (file: string, content: string) => Promise<void>;
};

export const nodeSetupDeps = (randomBytes: SetupDeps["randomBytes"]): SetupDeps => ({
	randomBytes,
	readTemplate: (file) => readFile(file, "utf8"),
	statTemplate: (file) => lstat(file),
	createFile: (file, content) => writeFile(file, content, { flag: "wx", mode: 0o600 }),
});

function replaceKey(text: string, key: string, value: string): { text: string; found: boolean } {
	const pattern = new RegExp(`^${key}=.*$`, "m");
	if (!pattern.test(text)) return { text, found: false };
	return { text: text.replace(pattern, () => `${key}=${value}`), found: true };
}

/**
 * Builds `.env` content from the template as Multica's `make selfhost` does: random
 * JWT_SECRET, POSTGRES_PASSWORD and MULTICA_VCS_SECRET_KEY, and the new password inside
 * DATABASE_URL. JWT_SECRET is required by the compose file, so it is added when the
 * template has no such line.
 */
export function buildEnvContent(template: string, randomBytes: SetupDeps["randomBytes"]): string {
	let text = template.replace(/\r\n/g, "\n");
	const jwt = randomBytes(32).toString("hex");
	const postgres = randomBytes(24).toString("hex");
	const vcs = randomBytes(32).toString("base64");
	const jwtResult = replaceKey(text, "JWT_SECRET", jwt);
	text = jwtResult.found ? jwtResult.text : `${text.replace(/\n*$/, "\n")}JWT_SECRET=${jwt}\n`;
	text = replaceKey(text, "POSTGRES_PASSWORD", postgres).text;
	text = replaceKey(text, "MULTICA_VCS_SECRET_KEY", vcs).text;
	text = text.replace(/^(DATABASE_URL=postgres:\/\/[^:\n]+:)[^@\n]*(@.*)$/m, (_match, head: string, tail: string) => `${head}${postgres}${tail}`);
	return text;
}

/**
 * Creates `.env` in a validated stack folder. Never overwrites, returns nothing about
 * the content, and runs no process.
 */
export async function setupStackEnv(stack: StackPaths, deps: SetupDeps): Promise<SetupOutcome> {
	const template = path.join(stack.dir, ENV_EXAMPLE_FILE_NAME);
	try {
		const info = await deps.statTemplate(template);
		if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_ENV_EXAMPLE_BYTES) return "failed";
		const content = buildEnvContent(await deps.readTemplate(template), deps.randomBytes);
		await deps.createFile(path.join(stack.dir, ENV_FILE_NAME), content);
		return "created";
	} catch (error) {
		return (error as { code?: string } | null)?.code === "EEXIST" ? "already_set_up" : "failed";
	}
}
