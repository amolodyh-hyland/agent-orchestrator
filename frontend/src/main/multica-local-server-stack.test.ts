import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildEnvContent,
	nodeSetupDeps,
	readLocalServerSettings,
	setupStackEnv,
	validateStackDir,
	writeLocalServerSettings,
	type SetupDeps,
	type StackFs,
} from "./multica-local-server-stack";

const COMPOSE = "name: multica\n\nservices:\n  postgres:\n    image: x\n  backend:\n    image: y\n  frontend:\n    image: z\n";

type Entry = { type: "file" | "dir" | "link"; mode: number; uid?: number; gid?: number; target?: string; content?: string; lstatError?: string };

/** An in-memory file system: ownership, modes and symlinks can be set at will, whatever the host's /tmp looks like. */
function fakeStackFs(entries: Record<string, Entry>): StackFs {
	const missing = (file: string) => Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
	const resolve = (file: string, depth = 0): string => {
		if (depth > 8) throw missing(file);
		const parts = file.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = `${current}/${part}`;
			const entry = entries[current];
			if (!entry) throw missing(current);
			if (entry.type === "link") {
				const rest = parts.slice(current.split("/").filter(Boolean).length).join("/");
				return resolve(path.posix.join(entry.target as string, rest), depth + 1);
			}
		}
		return current === "" ? "/" : current;
	};
	const info = (entry: Entry) => ({
		isFile: () => entry.type === "file",
		isDirectory: () => entry.type === "dir",
		isSymbolicLink: () => entry.type === "link",
		mode: entry.mode,
		uid: entry.uid ?? 0,
		gid: entry.gid ?? 0,
		size: entry.content?.length ?? 0,
	});
	return {
		realpath: async (file) => resolve(file),
		stat: async (file) => info(entries[resolve(file)] as Entry),
		lstat: async (file) => {
			const parent = resolve(path.posix.dirname(file));
			const entry = entries[path.posix.join(parent, path.posix.basename(file))];
			if (!entry) throw missing(file);
			if (entry.lstatError) throw Object.assign(new Error(entry.lstatError), { code: entry.lstatError });
			return info(entry);
		},
		readFile: async (file) => {
			const entry = entries[resolve(file)];
			if (!entry || entry.type !== "file") throw missing(file);
			return entry.content ?? "";
		},
	};
}

describe("validateStackDir", () => {
	const ME = { uid: 501, gid: 20 };
	const D = "/Users/me/.multica/server";
	const F = `${D}/docker-compose.selfhost.yml`;
	const dir = (mode = 0o755, uid = 501, gid = 20): Entry => ({ type: "dir", mode, uid, gid });
	const file = (content: string, mode = 0o644, uid = 501, gid = 20): Entry => ({ type: "file", mode, uid, gid, content });
	const tree = (patch: Record<string, Entry | null> = {}): Record<string, Entry> => {
		const entries: Record<string, Entry> = {
			"/": dir(0o755, 0, 0),
			"/Users": dir(0o755, 0, 0),
			"/Users/me": dir(),
			"/Users/me/.multica": dir(),
			[D]: dir(),
			[F]: file(COMPOSE),
		};
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete entries[key];
			else entries[key] = value;
		}
		return entries;
	};
	const validate = (entries: Record<string, Entry>, target = D, options: { uid?: number; gid?: number } = ME) => validateStackDir(target, { fs: fakeStackFs(entries), ...options });

	it("accepts a Multica stack folder and returns the canonical directory and file", async () => {
		await expect(validate(tree())).resolves.toEqual({ ok: true, dir: D, file: F });
	});

	it("accepts a private .env and a missing one (that is a setup step, not an error)", async () => {
		await expect(validate(tree({ [`${D}/.env`]: file("JWT_SECRET=x\n", 0o600) }))).resolves.toMatchObject({ ok: true });
		await expect(validate(tree())).resolves.toMatchObject({ ok: true });
	});

	it("canonicalizes a symlinked folder to its real location", async () => {
		await expect(validate(tree({ "/Users/me/link": { type: "link", mode: 0o755, target: D } }), "/Users/me/link")).resolves.toMatchObject({ ok: true, dir: D });
	});

	it("rejects a relative path, a NUL byte and a missing folder", async () => {
		await expect(validate(tree(), "server")).resolves.toEqual({ ok: false, error: "not_absolute" });
		await expect(validate(tree(), `${D}\0x`)).resolves.toEqual({ ok: false, error: "not_absolute" });
		await expect(validate(tree(), "/Users/me/missing")).resolves.toEqual({ ok: false, error: "not_found" });
	});

	it("rejects a file where a folder is expected", async () => {
		await expect(validate(tree(), F)).resolves.toEqual({ ok: false, error: "not_directory" });
	});

	it("rejects a folder or compose file that others can write", async () => {
		await expect(validate(tree({ [D]: dir(0o777) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		await expect(validate(tree({ [F]: file(COMPOSE, 0o666) }))).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
		await expect(validate(tree({ [F]: file(COMPOSE, 0o664, 501, 1234) }))).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a safe folder under a writable ancestor, because whoever can write the parent can swap the folder", async () => {
		for (const [ancestor, mode] of [["/Users/me/.multica", 0o777], ["/Users/me", 0o777], ["/Users", 0o1777], ["/", 0o777]] as const) {
			await expect(validate(tree({ [ancestor]: dir(mode, ancestor === "/" || ancestor === "/Users" ? 0 : 501) })), ancestor).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		}
		await expect(validate(tree({ "/Users/me": dir(0o775, 501, 1234) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
	});

	it("accepts a group-writable ancestor only for an administrator group or the user's own", async () => {
		await expect(validate(tree({ "/Users/me": dir(0o775, 501, 80) }))).resolves.toMatchObject({ ok: true });
		await expect(validate(tree({ "/Users/me": dir(0o775, 501, 20) }))).resolves.toMatchObject({ ok: true });
	});

	it("rejects a folder, ancestor or compose file owned by another user", async () => {
		await expect(validate(tree({ [D]: dir(0o755, 502) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		await expect(validate(tree({ "/Users/me": dir(0o755, 502) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		await expect(validate(tree({ [F]: file(COMPOSE, 0o644, 502) }))).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a .env it cannot inspect, rather than assuming there is none", async () => {
		for (const code of ["EACCES", "EPERM", "EIO"]) {
			await expect(validate(tree({ [`${D}/.env`]: { ...file("x", 0o600), lstatError: code } })), code).resolves.toEqual({ ok: false, error: "unsafe_env_file" });
		}
	});

	it("rejects a .env that is a symlink, even to a private file", async () => {
		const entries = tree({ [`${D}/.env`]: { type: "link", mode: 0o777, target: `${D}/real.env` }, [`${D}/real.env`]: file("JWT_SECRET=x", 0o600) });
		await expect(validate(entries)).resolves.toEqual({ ok: false, error: "unsafe_env_file" });
	});

	it("rejects a .env that is a symlink to a world-writable target", async () => {
		const entries = tree({ [`${D}/.env`]: { type: "link", mode: 0o777, target: "/tmp/shared.env" }, "/tmp": dir(0o1777, 0, 0), "/tmp/shared.env": file("COMPOSE_PROJECT_NAME=other", 0o666) });
		await expect(validate(entries)).resolves.toEqual({ ok: false, error: "unsafe_env_file" });
	});

	it("rejects a .env that others or a group can write, one owned by another user, one that is not a file or too large", async () => {
		for (const [name, entry] of [
			["world-writable", file("x", 0o666)],
			["group-writable", file("x", 0o660)],
			["other owner", file("x", 0o600, 502)],
			["directory", dir()],
			["huge", file("x".repeat(300 * 1024), 0o600)],
		] as const) {
			await expect(validate(tree({ [`${D}/.env`]: entry })), name).resolves.toEqual({ ok: false, error: "unsafe_env_file" });
		}
	});

	it("rejects a compose file that is a symlink, even to a good file inside the folder", async () => {
		const entries = tree({ [F]: { type: "link", mode: 0o777, target: `${D}/real.yml` }, [`${D}/real.yml`]: file(COMPOSE) });
		await expect(validate(entries)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a compose file that points outside the folder", async () => {
		const entries = tree({ [F]: { type: "link", mode: 0o777, target: "/Users/me/outside.yml" }, "/Users/me/outside.yml": file(COMPOSE) });
		await expect(validate(entries)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a folder without the fixed compose file name", async () => {
		await expect(validate(tree({ [F]: null, [`${D}/docker-compose.yml`]: file(COMPOSE) }))).resolves.toEqual({ ok: false, error: "no_compose_file" });
	});

	it("rejects a compose file that is not Multica's, or is too large", async () => {
		await expect(validate(tree({ [F]: file("name: other\nservices:\n  web:\n    image: x\n") }))).resolves.toEqual({ ok: false, error: "not_multica" });
		await expect(validate(tree({ [F]: file(`${COMPOSE}${"#".repeat(300 * 1024)}`) }))).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("does not judge ownership or modes where there is no user id (Windows)", async () => {
		await expect(validate(tree({ [D]: dir(0o777, 999), "/Users/me": dir(0o777, 999) }), D, { uid: undefined, gid: undefined } as never)).resolves.toMatchObject({ ok: true });
	});

	describe("compose content", () => {
		const withService = (extra: string) => `${COMPOSE}${extra}`;
		const rejected = async (text: string) => validate(tree({ [F]: file(text) }));

		it("accepts what Multica's own file contains: named volumes, loopback ports, depends_on, healthchecks", async () => {
			const stock = `name: multica
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-multica}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U x",
        ]
  backend:
    image: b
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:\${BACKEND_PORT:-8080}:8080"
    volumes:
      - backend_uploads:/app/data/uploads
  frontend:
    image: f
    depends_on:
      - backend
    ports:
      - "127.0.0.1:\${FRONTEND_PORT:-3000}:3000"
volumes:
  pgdata:
  backend_uploads:
`;
			await expect(validate(tree({ [F]: file(stock) }))).resolves.toEqual({ ok: true, dir: D, file: F });
		});

		it("rejects keys that hand out the host, other files or other projects", async () => {
			for (const key of ["include: [other.yml]", "extends: {file: x.yml, service: y}", "env_file: .env.evil", "privileged: true", "pid: host", "network_mode: host", "cap_add: [ALL]", "devices: ['/dev/sda']", "security_opt: ['seccomp=unconfined']", "volumes_from: [x]", "build: ./x", "ipc: host", "userns_mode: host"]) {
				expect(await rejected(withService(`\n    ${key}\n`)), key).toEqual({ ok: false, error: "unsafe_compose_content" });
				expect(await rejected(withService(`\n    x: { ${key.replace(/^\s+/, "")} }\n`)), `flow ${key}`).toEqual({ ok: false, error: "unsafe_compose_content" });
			}
		});

		it("rejects a top-level include", async () => {
			expect(await rejected(`include:\n  - evil.yml\n${COMPOSE}`)).toEqual({ ok: false, error: "unsafe_compose_content" });
		});

		it("rejects bind mounts, in short, long and flow form", async () => {
			for (const volume of ["- /:/host", "- ./data:/data", "- ~/x:/x", "- ${HOME}:/h", "- /var/run/docker.sock:/var/run/docker.sock"]) {
				expect(await rejected(withService(`\n    volumes:\n      ${volume}\n`)), volume).toEqual({ ok: false, error: "unsafe_compose_content" });
			}
			expect(await rejected(withService("\n    volumes:\n      - type: bind\n        source: /\n        target: /h\n"))).toEqual({ ok: false, error: "unsafe_compose_content" });
			expect(await rejected(withService('\n    volumes: ["/:/host"]\n'))).toEqual({ ok: false, error: "unsafe_compose_content" });
		});

		it("rejects ports published beyond loopback, in list and flow form", async () => {
			for (const port of ['- "8080:8080"', '- "0.0.0.0:8080:8080"', "- 3000:3000", '- "192.168.1.5:3000:3000"']) {
				expect(await rejected(withService(`\n    ports:\n      ${port}\n`)), port).toEqual({ ok: false, error: "unsafe_compose_content" });
			}
			expect(await rejected(withService('\n    ports: ["0.0.0.0:80:80"]\n'))).toEqual({ ok: false, error: "unsafe_compose_content" });
		});
	});
});

describe("saved stack folder", () => {
	let state: string;
	beforeEach(async () => {
		state = await mkdtemp(path.join(os.tmpdir(), "ao-local-server-state-"));
	});
	afterEach(() => rm(state, { recursive: true, force: true }));

	it("round-trips an absolute folder in a 0600 file and reads nothing else from it", async () => {
		await writeLocalServerSettings(state, { stackDir: "/Users/me/multica" });
		expect(await readLocalServerSettings(state)).toEqual({ stackDir: "/Users/me/multica" });
		expect((await stat(path.join(state, "multica-local-server.json"))).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(path.join(state, "multica-local-server.json"), "utf8"))).toEqual({ version: 1, stackDir: "/Users/me/multica" });
	});

	it("treats a missing, relative or malformed value as no folder", async () => {
		expect(await readLocalServerSettings(state)).toEqual({ stackDir: "" });
		await writeFile(path.join(state, "multica-local-server.json"), JSON.stringify({ stackDir: "relative/dir" }));
		expect(await readLocalServerSettings(state)).toEqual({ stackDir: "" });
		await writeFile(path.join(state, "multica-local-server.json"), "{not json");
		expect(await readLocalServerSettings(state)).toEqual({ stackDir: "" });
	});
});

describe("first-time setup", () => {
	const TEMPLATE = [
		"# example",
		"DATABASE_URL=postgres://multica:multica@localhost:5432/multica?sslmode=disable",
		"POSTGRES_PASSWORD=multica",
		"JWT_SECRET=change-me-in-production",
		"MULTICA_VCS_SECRET_KEY=",
		"FRONTEND_ORIGIN=http://localhost:3000",
		"",
	].join("\n");
	const counter = () => {
		let n = 0;
		return (size: number) => Buffer.alloc(size, ++n);
	};

	it("replaces the secrets like make selfhost does and leaves everything else alone", () => {
		const content = buildEnvContent(TEMPLATE, counter());

		expect(content).toContain(`JWT_SECRET=${"01".repeat(32)}`);
		expect(content).toContain(`POSTGRES_PASSWORD=${"02".repeat(24)}`);
		expect(content).toContain(`MULTICA_VCS_SECRET_KEY=${Buffer.alloc(32, 3).toString("base64")}`);
		expect(content).toContain(`DATABASE_URL=postgres://multica:${"02".repeat(24)}@localhost:5432/multica?sslmode=disable`);
		expect(content).toContain("FRONTEND_ORIGIN=http://localhost:3000");
		expect(content).not.toContain("change-me-in-production");
	});

	it("adds JWT_SECRET when the template has none, because the compose file requires it", () => {
		expect(buildEnvContent("FRONTEND_ORIGIN=http://localhost:3000", counter())).toContain(`JWT_SECRET=${"01".repeat(32)}\n`);
	});

	describe("on disk", () => {
		let dir: string;
		beforeEach(async () => {
			dir = await mkdtemp(path.join(os.tmpdir(), "ao-local-server-setup-"));
			await writeFile(path.join(dir, ".env.example"), TEMPLATE);
		});
		afterEach(() => rm(dir, { recursive: true, force: true }));
		const stack = () => ({ dir, file: path.join(dir, "docker-compose.selfhost.yml") });

		it("creates .env with mode 0600 and the generated secrets", async () => {
			expect(await setupStackEnv(stack(), nodeSetupDeps((size) => Buffer.alloc(size, 7)))).toBe("created");
			expect((await stat(path.join(dir, ".env"))).mode & 0o777).toBe(0o600);
			expect(await readFile(path.join(dir, ".env"), "utf8")).toContain(`JWT_SECRET=${"07".repeat(32)}`);
		});

		it("never overwrites an existing .env", async () => {
			await writeFile(path.join(dir, ".env"), "JWT_SECRET=mine\n");
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("already_set_up");
			expect(await readFile(path.join(dir, ".env"), "utf8")).toBe("JWT_SECRET=mine\n");
		});

		it("fails without writing when the template is missing or a symlink", async () => {
			await rm(path.join(dir, ".env.example"));
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("failed");
			await writeFile(path.join(dir, "elsewhere"), TEMPLATE);
			await symlink(path.join(dir, "elsewhere"), path.join(dir, ".env.example"));
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("failed");
			await expect(stat(path.join(dir, ".env"))).rejects.toThrow();
		});

		it("returns only an outcome word, never the content", async () => {
			const deps: SetupDeps = { ...nodeSetupDeps(counter()), createFile: async () => undefined };
			expect(await setupStackEnv(stack(), deps)).toBe("created");
		});
	});
});
