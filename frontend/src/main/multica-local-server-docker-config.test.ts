import { describe, expect, it } from "vitest";
import { dockerConfigContent, ensureLocalDockerConfig, type DockerConfigFs } from "./multica-local-server-docker-config";

type Entry = { type: "dir" | "file" | "link"; mode: number; uid: number; content?: string };

/** An in-memory file system that records what the code creates and writes. */
function fakeFs(initial: Record<string, Entry> = {}) {
	const entries: Record<string, Entry> = { ...initial };
	const writes: string[] = [];
	const enoent = (file: string) => Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
	const fs: DockerConfigFs = {
		mkdir: async (dir, options) => {
			const parts = dir.split("/").filter(Boolean);
			let current = "";
			for (const part of parts) {
				current = `${current}/${part}`;
				entries[current] ??= { type: "dir", mode: options.mode, uid: 501 };
			}
		},
		lstat: async (file) => {
			const entry = entries[file];
			if (!entry) throw enoent(file);
			return { isDirectory: () => entry.type === "dir", isFile: () => entry.type === "file", isSymbolicLink: () => entry.type === "link", mode: entry.mode, uid: entry.uid };
		},
		readFile: async (file) => {
			const entry = entries[file];
			if (!entry || entry.type !== "file") throw enoent(file);
			return entry.content ?? "";
		},
		writeFile: async (file, content, options) => {
			writes.push(file);
			entries[file] = { type: "file", mode: options.mode, uid: 501, content };
		},
		rename: async (from, to) => {
			entries[to] = entries[from] as Entry;
			delete entries[from];
		},
	};
	return { fs, entries, writes };
}

const ROOT = "/Users/me/.ao/local-server-docker";
const PLUGINS = "/Applications/Docker.app/Contents/Resources/cli-plugins";
const dir = (mode = 0o700, uid = 501): Entry => ({ type: "dir", mode, uid });

describe("ensureLocalDockerConfig", () => {
	it("creates a private Docker home with an empty cli-plugins directory and a config listing only the validated plugin directory", async () => {
		const { fs, entries } = fakeFs();

		const result = await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs });

		expect(result).toEqual({ ok: true, home: ROOT, config: `${ROOT}/.docker` });
		for (const created of [ROOT, `${ROOT}/.docker`, `${ROOT}/.docker/cli-plugins`]) expect(entries[created]).toMatchObject({ type: "dir", mode: 0o700 });
		expect(JSON.parse(entries[`${ROOT}/.docker/config.json`]?.content ?? "")).toEqual({ cliPluginsExtraDirs: [PLUGINS] });
		expect(entries[`${ROOT}/.docker/config.json`]?.mode).toBe(0o600);
	});

	it("writes nothing but the plugin directory: no context, no credential helper, no other plugin directory", async () => {
		expect(JSON.parse(dockerConfigContent(PLUGINS))).toEqual({ cliPluginsExtraDirs: [PLUGINS] });
		expect(JSON.parse(dockerConfigContent(null))).toEqual({});
	});

	it("rewrites the config when the plugin directory changes, and leaves a correct one untouched", async () => {
		const { fs, writes, entries } = fakeFs();
		await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs });
		writes.length = 0;

		await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs });
		expect(writes).toEqual([]);

		await ensureLocalDockerConfig({ root: ROOT, pluginDir: "/usr/local/lib/docker/cli-plugins", uid: 501, fs });
		expect(writes).toHaveLength(1);
		expect(JSON.parse(entries[`${ROOT}/.docker/config.json`]?.content ?? "")).toEqual({ cliPluginsExtraDirs: ["/usr/local/lib/docker/cli-plugins"] });
	});

	it("repairs a config that someone changed (extra plugin directories, a current context)", async () => {
		const tampered = JSON.stringify({ cliPluginsExtraDirs: ["/tmp/evil"], currentContext: "remote" });
		const { fs, entries } = fakeFs({
			"/Users": dir(0o755, 0),
			[ROOT]: dir(),
			[`${ROOT}/.docker`]: dir(),
			[`${ROOT}/.docker/cli-plugins`]: dir(),
			[`${ROOT}/.docker/config.json`]: { type: "file", mode: 0o600, uid: 501, content: tampered },
		});

		expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs })).toMatchObject({ ok: true });
		expect(JSON.parse(entries[`${ROOT}/.docker/config.json`]?.content ?? "")).toEqual({ cliPluginsExtraDirs: [PLUGINS] });
	});

	it("fails closed when a directory is a symlink, owned by another user or readable/writable by others", async () => {
		for (const [name, entry] of [
			["symlink", { type: "link", mode: 0o700, uid: 501 } as Entry],
			["other owner", dir(0o700, 502)],
			["group readable", dir(0o750)],
			["world writable", dir(0o777)],
			["not a directory", { type: "file", mode: 0o700, uid: 501 } as Entry],
		] as const) {
			for (const target of [ROOT, `${ROOT}/.docker`, `${ROOT}/.docker/cli-plugins`]) {
				const initial: Record<string, Entry> = { [ROOT]: dir(), [`${ROOT}/.docker`]: dir(), [`${ROOT}/.docker/cli-plugins`]: dir(), [target]: entry };
				const { fs } = fakeFs(initial);
				expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs }), `${name} at ${target}`).toEqual({ ok: false });
			}
		}
	});

	it("fails closed when config.json is a symlink, a directory, owned by another user or group/world accessible", async () => {
		for (const [name, entry] of [
			["symlink", { type: "link", mode: 0o600, uid: 501 } as Entry],
			["directory", dir()],
			["other owner", { type: "file", mode: 0o600, uid: 502, content: "{}" } as Entry],
			["world readable", { type: "file", mode: 0o644, uid: 501, content: "{}" } as Entry],
			["group writable", { type: "file", mode: 0o660, uid: 501, content: "{}" } as Entry],
		] as const) {
			const { fs, writes } = fakeFs({ [ROOT]: dir(), [`${ROOT}/.docker`]: dir(), [`${ROOT}/.docker/cli-plugins`]: dir(), [`${ROOT}/.docker/config.json`]: entry });
			expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs }), name).toEqual({ ok: false });
			expect(writes, name).toEqual([]);
		}
	});

	it("fails closed when the file system errors, rather than throwing", async () => {
		const { fs } = fakeFs();
		fs.writeFile = async () => {
			throw new Error("EROFS");
		};
		expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs })).toEqual({ ok: false });
		const { fs: unreadable } = fakeFs({ [ROOT]: dir(), [`${ROOT}/.docker`]: dir(), [`${ROOT}/.docker/cli-plugins`]: dir() });
		unreadable.lstat = async () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		};
		expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs: unreadable })).toEqual({ ok: false });
	});

	it("fails closed, and writes nothing, when only config.json cannot be inspected", async () => {
		for (const code of ["EACCES", "EPERM", "EIO"]) {
			const { fs, writes } = fakeFs({ [ROOT]: dir(), [`${ROOT}/.docker`]: dir(), [`${ROOT}/.docker/cli-plugins`]: dir() });
			const lstat = fs.lstat;
			fs.lstat = async (file) => {
				if (file.endsWith("config.json")) throw Object.assign(new Error(code), { code });
				return lstat(file);
			};
			expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: PLUGINS, uid: 501, fs }), code).toEqual({ ok: false });
			expect(writes, code).toEqual([]);
		}
	});

	it("does not judge ownership or modes where there is no user id (Windows)", async () => {
		const { fs } = fakeFs({ [ROOT]: dir(0o777, 999) });
		expect(await ensureLocalDockerConfig({ root: ROOT, pluginDir: null, uid: undefined, fs })).toMatchObject({ ok: true });
	});
});
