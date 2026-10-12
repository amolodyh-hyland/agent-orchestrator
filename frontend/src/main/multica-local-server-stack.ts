import { mkdir, lstat, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { load } from "js-yaml";
import path from "node:path";
import { COMPOSE_FILE_NAME, directoryTrusted, fileTrusted, type StackPaths, type TrustStat } from "./multica-local-server-commands";

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

const ALLOWED_TOP_LEVEL = new Set(["name", "services", "volumes"]);
const ALLOWED_SERVICE_KEYS = new Set(["image", "environment", "volumes", "ports", "restart", "depends_on", "healthcheck"]);
const ALLOWED_HEALTHCHECK_KEYS = new Set(["test", "interval", "timeout", "retries", "start_period", "start_interval", "disable"]);
const ALLOWED_DEPENDS_CONDITIONS = new Set(["service_started", "service_healthy", "service_completed_successfully"]);
const RESTART_POLICIES = new Set(["no", "always", "unless-stopped", "on-failure"]);
// A `<<` key, quoted or not (YAML merge): refused because it pulls keys in from elsewhere.
const MERGE_KEY = /(^|[\s{,\[])["']?<<["']?[ \t]*:/m;
const MAX_STRING = 4096;
const SERVICE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
// <named volume>:<absolute container path>[:ro|rw]; a host path, ./relative or ~ cannot match a bare volume name.
const VOLUME_ITEM = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,62}):(\/[^:\s]*)(?::(?:ro|rw))?$/;
// Loopback only: <127.0.0.1|[::1]>:<host port or ${interpolation}>:<container port>[/tcp].
// ${...} groups are collapsed to X first (innermost out), so an interpolation can only stand for the host port.
const PORT_ITEM = /^(?:127\.0\.0\.1|\[::1\]):(?:\d{1,5}|X):\d{1,5}(?:\/tcp)?$/;

function collapseInterpolations(value: string): string {
	let current = value;
	for (let guard = 0; guard < 32; guard += 1) {
		const next = current.replace(/\$\{[^${}]*\}/g, "X");
		if (next === current) break;
		current = next;
	}
	return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/**
 * Parses the compose file and accepts only the structure Multica's self-hosting stack
 * uses, by an allow-list over the DECODED document (so quoting, flow style, anchors and
 * key order cannot hide anything): top level `name: multica`, `services`, and `volumes`
 * whose entries are bare named volumes; per service only image, environment, restart,
 * depends_on, healthcheck, ports bound to loopback, and volumes that mount a declared
 * named volume at an absolute container path. Everything else (including `include`,
 * `privileged`, bind or `driver_opts` volumes, other published ports, `build`, `extends`,
 * extension fields) refuses the file. A file that does not parse, repeats a key, or is
 Returns null when accepted, else a short reason.
 * This is a guard against tampering, not a sandbox: the image still comes from the `.env`.
 */
export function unsafeComposeReason(text: string): string | null {
	let document: unknown;
	let sawAnchor = false;
	try {
		document = load(text, {
			listener: (event, state) => {
				if (event === "close" && state.anchorMap && Object.keys(state.anchorMap).length > 0) sawAnchor = true;
			},
		});
	} catch {
		return "unparseable";
	}
	// No anchors or aliases (so no shared or expanded structure), no merge keys: what is read is what is there.
	if (sawAnchor) return "anchor";
	if (MERGE_KEY.test(text)) return "merge_key";
	if (!isPlainObject(document)) return "not_a_mapping";
	for (const key of Object.keys(document)) if (!ALLOWED_TOP_LEVEL.has(key)) return `top_level_${key}`;
	if (document.name !== "multica") return "name";

	const declared = new Set<string>();
	if (document.volumes !== undefined && document.volumes !== null) {
		if (!isPlainObject(document.volumes)) return "volumes_shape";
		for (const [name, definition] of Object.entries(document.volumes)) {
			if (!VOLUME_NAME.test(name)) return "volume_name";
			// A bare declaration only: driver, driver_opts (a bind in disguise), external, name... are not allowed.
			if (definition !== null && !(isPlainObject(definition) && Object.keys(definition).length === 0)) return "volume_definition";
			declared.add(name);
		}
	}

	if (!isPlainObject(document.services)) return "services";
	const serviceNames = new Set(Object.keys(document.services));
	for (const [name, rawService] of Object.entries(document.services)) {
		if (!SERVICE_NAME.test(name) || !isPlainObject(rawService)) return "service_shape";
		for (const key of Object.keys(rawService)) if (!ALLOWED_SERVICE_KEYS.has(key)) return `service_key_${key}`;
		const service = rawService;
		if (typeof service.image !== "string" || service.image === "") return "image";
		if (service.restart !== undefined && !(typeof service.restart === "string" && RESTART_POLICIES.has(service.restart.split(":")[0] ?? ""))) return "restart";

		const env = service.environment;
		if (env !== undefined && env !== null) {
			if (Array.isArray(env)) {
				if (!env.every((item) => typeof item === "string")) return "environment";
			} else if (!isPlainObject(env) || !Object.values(env).every(isScalar)) return "environment";
		}

		const volumes = service.volumes;
		if (volumes !== undefined) {
			if (!Array.isArray(volumes)) return "service_volumes";
			for (const item of volumes) {
				const match = typeof item === "string" ? VOLUME_ITEM.exec(item) : null;
				if (!match || !declared.has(match[1] as string)) return "service_volume_item";
			}
		}

		const ports = service.ports;
		if (ports !== undefined) {
			if (!Array.isArray(ports)) return "ports";
			for (const item of ports) if (typeof item !== "string" || !PORT_ITEM.test(collapseInterpolations(item))) return "port_item";
		}

		const dependsOn = service.depends_on;
		if (dependsOn !== undefined) {
			if (Array.isArray(dependsOn)) {
				if (!dependsOn.every((item) => typeof item === "string" && serviceNames.has(item))) return "depends_on";
			} else if (isPlainObject(dependsOn)) {
				for (const [dependency, options] of Object.entries(dependsOn)) {
					if (!serviceNames.has(dependency) || !isPlainObject(options)) return "depends_on";
					for (const [key, value] of Object.entries(options)) {
						if (key === "condition" && typeof value === "string" && ALLOWED_DEPENDS_CONDITIONS.has(value)) continue;
						if (key === "restart" && typeof value === "boolean") continue;
						return "depends_on";
					}
				}
			} else return "depends_on";
		}

		const healthcheck = service.healthcheck;
		if (healthcheck !== undefined) {
			if (!isPlainObject(healthcheck)) return "healthcheck";
			for (const [key, value] of Object.entries(healthcheck)) {
				if (!ALLOWED_HEALTHCHECK_KEYS.has(key)) return "healthcheck";
				if (key === "test" ? !(typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) : !isScalar(value)) return "healthcheck";
			}
		}
	}
	return longestString(document) > MAX_STRING ? "long_string" : null;
}

function longestString(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) return value.reduce<number>((longest, item) => Math.max(longest, longestString(item)), 0);
	if (isPlainObject(value)) return Object.entries(value).reduce((longest, [key, item]) => Math.max(longest, key.length, longestString(item)), 0);
	return 0;
}

/** The folder itself must be strictly the user's (no group or other write); the directories above it follow the directory rule. */
async function ancestorsTrusted(dir: string, fs: StackFs, uid: number | undefined, gid: number | undefined): Promise<boolean> {
	const context = { uid, gid };
	let current = dir;
	for (let leaf = true; ; leaf = false) {
		const info = await fs.stat(current);
		if (!info.isDirectory() || !(leaf ? fileTrusted(info, context) : directoryTrusted(info, context))) return false;
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
	if (uid !== undefined && (fileInfo.uid !== uid || !fileTrusted(fileInfo, { uid, gid }))) return { ok: false, error: "unsafe_compose_file" };
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
		if (uid !== undefined && (envInfo.uid !== uid || !fileTrusted(envInfo, { uid, gid }))) return { ok: false, error: "unsafe_env_file" };
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
	statTemplate: (file: string) => Promise<TrustStat & { isSymbolicLink: () => boolean; size: number }>;
	/** Creates the file exclusively with mode 0600; rejects with EEXIST when it exists. */
	createFile: (file: string, content: string) => Promise<void>;
	/** The current user; the template's ownership and mode are not judged where there is none (Windows). */
	uid?: number | undefined;
	gid?: number | undefined;
};

export const nodeSetupDeps = (randomBytes: SetupDeps["randomBytes"]): SetupDeps => ({
	randomBytes,
	readTemplate: (file) => readFile(file, "utf8"),
	statTemplate: (file) => lstat(file),
	createFile: (file, content) => writeFile(file, content, { flag: "wx", mode: 0o600 }),
	uid: currentUid(),
	gid: currentGid(),
});

/** The values `.env` gets fresh: a second (or differently written) assignment of one would override them. */
const MANAGED_KEYS = ["JWT_SECRET", "POSTGRES_PASSWORD", "MULTICA_VCS_SECRET_KEY", "DATABASE_URL"] as const;

/** Any way a dotenv-style file can assign `key`: `KEY=`, `export KEY=`, ` KEY =`, `KEY:`; comments do not count. */
function assignments(text: string, key: string): number {
	return [...text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*[=:]`, "gm"))].length;
}

function canonicalAssignments(text: string, key: string): number {
	return [...text.matchAll(new RegExp(`^${key}=`, "gm"))].length;
}

/**
 * Whether the template defines each managed key at most once, and only in the plain `KEY=value`
 * form: a duplicate or an `export KEY=` / indented / `KEY:` variant would survive next to the
 * fresh secret and could win when the file is read (dotenv parsers keep the last assignment).
 */
export function templateAssignsManagedKeysOnce(text: string): boolean {
	return MANAGED_KEYS.every((key) => assignments(text, key) <= 1 && assignments(text, key) === canonicalAssignments(text, key));
}

function replaceKey(text: string, key: string, value: string): { text: string; found: boolean } {
	const pattern = new RegExp(`^${key}=.*$`, "m");
	if (!pattern.test(text)) return { text, found: false };
	return { text: text.replace(pattern, () => `${key}=${value}`), found: true };
}

/**
 * Builds `.env` content from the template as Multica's `make selfhost` does: random
 * JWT_SECRET, POSTGRES_PASSWORD and MULTICA_VCS_SECRET_KEY, and the new password inside
 * DATABASE_URL. JWT_SECRET is required by the compose file, so it is added when the
 * template has no such line. Returns null when the template assigns a managed key twice or
 * in a form that would sit next to the fresh value, or when the result does not hold each
 * managed key exactly once.
 */
export function buildEnvContent(template: string, randomBytes: SetupDeps["randomBytes"]): string | null {
	let text = template.replace(/\r\n/g, "\n");
	if (!templateAssignsManagedKeysOnce(text)) return null;
	const jwt = randomBytes(32).toString("hex");
	const postgres = randomBytes(24).toString("hex");
	const vcs = randomBytes(32).toString("base64");
	const jwtResult = replaceKey(text, "JWT_SECRET", jwt);
	text = jwtResult.found ? jwtResult.text : `${text.replace(/\n*$/, "\n")}JWT_SECRET=${jwt}\n`;
	text = replaceKey(text, "POSTGRES_PASSWORD", postgres).text;
	text = replaceKey(text, "MULTICA_VCS_SECRET_KEY", vcs).text;
	text = text.replace(/^(DATABASE_URL=postgres:\/\/[^:\n]+:)[^@\n]*(@.*)$/m, (_match, head: string, tail: string) => `${head}${postgres}${tail}`);
	// Whatever the input, the result must carry each managed key at most once and JWT_SECRET exactly once.
	if (!MANAGED_KEYS.every((key) => assignments(text, key) <= 1) || assignments(text, "JWT_SECRET") !== 1) return null;
	return text;
}

/**
 * Creates `.env` in a validated stack folder. The template must be a plain file owned by root or
 * the user that group and others cannot write (it is the source of everything AO copies into
 * `.env`). Never overwrites, returns nothing about the content, and runs no process.
 */
export async function setupStackEnv(stack: StackPaths, deps: SetupDeps): Promise<SetupOutcome> {
	const template = path.join(stack.dir, ENV_EXAMPLE_FILE_NAME);
	try {
		const info = await deps.statTemplate(template);
		if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_ENV_EXAMPLE_BYTES) return "failed";
		if (deps.uid !== undefined && !fileTrusted(info, { uid: deps.uid, gid: deps.gid })) return "failed";
		const content = buildEnvContent(await deps.readTemplate(template), deps.randomBytes);
		if (content === null) return "failed";
		await deps.createFile(path.join(stack.dir, ENV_FILE_NAME), content);
		return "created";
	} catch (error) {
		return (error as { code?: string } | null)?.code === "EEXIST" ? "already_set_up" : "failed";
	}
}
