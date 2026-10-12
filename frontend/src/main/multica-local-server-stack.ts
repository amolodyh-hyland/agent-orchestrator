import { mkdir, lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMPOSE_FILE_NAME, type StackPaths } from "./multica-local-server-commands";

export const LOCAL_SERVER_SETTINGS_FILE_NAME = "multica-local-server.json";
export const ENV_FILE_NAME = ".env";
export const ENV_EXAMPLE_FILE_NAME = ".env.example";

const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_ENV_EXAMPLE_BYTES = 64 * 1024;

export type StackCheckError =
	| "not_absolute"
	| "not_found"
	| "not_directory"
	| "unsafe_directory"
	| "no_compose_file"
	| "unsafe_compose_file"
	| "not_multica";

export type StackCheck = ({ ok: true } & StackPaths) | { ok: false; error: StackCheckError };

export type StackFs = {
	realpath: (file: string) => Promise<string>;
	lstat: (file: string) => Promise<{ isFile: () => boolean; isDirectory: () => boolean; isSymbolicLink: () => boolean; mode: number; uid: number; size: number }>;
	stat: (file: string) => Promise<{ isDirectory: () => boolean; mode: number; uid: number }>;
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
	/** The current user's id; ownership and mode checks are skipped where there is none (Windows). */
	uid?: number | undefined;
};

function currentUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
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
		if (uid !== undefined && (info.uid !== uid || (info.mode & 0o022) !== 0)) return { ok: false, error: "unsafe_directory" };
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
	if (uid !== undefined && (fileInfo.uid !== uid || (fileInfo.mode & 0o022) !== 0)) return { ok: false, error: "unsafe_compose_file" };
	try {
		const real = await fs.realpath(file);
		if (real !== file || !insideDirectory(canonical, real)) return { ok: false, error: "unsafe_compose_file" };
		if (!looksLikeMulticaCompose(await fs.readFile(file))) return { ok: false, error: "not_multica" };
	} catch {
		return { ok: false, error: "unsafe_compose_file" };
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
