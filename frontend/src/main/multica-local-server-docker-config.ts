import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Docker finds its CLI plugins (docker-compose) in the config directory it is given, in the
// directories that config lists, and in system directories: not through PATH. AO therefore runs
// every Docker command with HOME and DOCKER_CONFIG pointing into a folder of its own, whose
// config.json lists only the Compose plugin directory AO has validated. The user's own
// ~/.docker (plugins, current context, credential helpers) is never consulted.

export const DOCKER_CONFIG_DIR_NAME = ".docker";

export type DockerConfigStat = { isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean; mode: number; uid: number };

export type DockerConfigFs = {
	mkdir: (dir: string, options: { recursive: true; mode: number }) => Promise<unknown>;
	lstat: (file: string) => Promise<DockerConfigStat>;
	readFile: (file: string) => Promise<string>;
	writeFile: (file: string, content: string, options: { mode: number }) => Promise<unknown>;
	rename: (from: string, to: string) => Promise<unknown>;
};

export const nodeDockerConfigFs: DockerConfigFs = {
	mkdir: (dir, options) => mkdir(dir, options),
	lstat: (file) => lstat(file),
	readFile: (file) => readFile(file, "utf8"),
	writeFile: (file, content, options) => writeFile(file, content, options),
	rename: (from, to) => rename(from, to),
};

export type DockerConfigResult = { ok: true; home: string; config: string } | { ok: false };

export type EnsureDockerConfigOptions = {
	/** AO's own folder for this (under its state dir); HOME for the Docker commands. */
	root: string;
	/** The validated directory that holds the docker-compose plugin, or null when there is none. */
	pluginDir: string | null;
	/** The current user; ownership is not judged where there is none (Windows). */
	uid?: number | undefined;
	fs?: DockerConfigFs;
};

/** The exact config.json content: nothing but the extra plugin directory AO validated. */
export function dockerConfigContent(pluginDir: string | null): string {
	return `${JSON.stringify(pluginDir === null ? {} : { cliPluginsExtraDirs: [pluginDir] }, null, 2)}\n`;
}

async function privateDirectory(dir: string, fs: DockerConfigFs, uid: number | undefined): Promise<boolean> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await fs.lstat(dir);
	if (info.isSymbolicLink() || !info.isDirectory()) return false;
	return uid === undefined || (info.uid === uid && (info.mode & 0o077) === 0);
}

/**
 * Makes sure AO's Docker home exists, is private and owned by the user, has an empty
 * `cli-plugins` directory (so nothing is picked up from there), and a config.json that lists
 * only `pluginDir`. Anything unexpected (a symlink, another owner, a readable or writable
 * folder, a config file that is not a plain file) fails closed.
 */
export async function ensureLocalDockerConfig(options: EnsureDockerConfigOptions): Promise<DockerConfigResult> {
	const fs = options.fs ?? nodeDockerConfigFs;
	const config = path.join(options.root, DOCKER_CONFIG_DIR_NAME);
	try {
		for (const dir of [options.root, config, path.join(config, "cli-plugins")]) {
			if (!(await privateDirectory(dir, fs, options.uid))) return { ok: false };
		}
		const file = path.join(config, "config.json");
		const wanted = dockerConfigContent(options.pluginDir);
		let current: string | null = null;
		try {
			const info = await fs.lstat(file);
			if (info.isSymbolicLink() || !info.isFile()) return { ok: false };
			if (options.uid !== undefined && (info.uid !== options.uid || (info.mode & 0o077) !== 0)) return { ok: false };
			current = await fs.readFile(file);
		} catch (error) {
			if ((error as { code?: string } | null)?.code !== "ENOENT") return { ok: false };
		}
		if (current !== wanted) {
			const temporary = path.join(config, `.config-${process.pid}-${Date.now()}.json`);
			await fs.writeFile(temporary, wanted, { mode: 0o600 });
			await fs.rename(temporary, file);
		}
		return { ok: true, home: options.root, config };
	} catch {
		return { ok: false };
	}
}
