import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
} from "./multica-local-server-stack";

const COMPOSE = "name: multica\n\nservices:\n  postgres:\n    image: x\n  backend:\n    image: y\n  frontend:\n    image: z\n";

describe("validateStackDir", () => {
	let root: string;
	let stackDir: string;

	beforeEach(async () => {
		root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ao-local-server-")));
		stackDir = path.join(root, "server");
		await mkdir(stackDir);
		await chmod(stackDir, 0o755);
		await writeFile(path.join(stackDir, "docker-compose.selfhost.yml"), COMPOSE, { mode: 0o644 });
	});

	afterEach(async () => {
		await chmod(stackDir, 0o755).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	});

	it("accepts a Multica stack folder and returns the canonical directory and file", async () => {
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: true, dir: stackDir, file: path.join(stackDir, "docker-compose.selfhost.yml") });
	});

	it("canonicalizes a symlinked folder to its real location", async () => {
		const link = path.join(root, "link");
		await symlink(stackDir, link);
		await expect(validateStackDir(link)).resolves.toMatchObject({ ok: true, dir: stackDir });
	});

	it("rejects a relative path, a NUL byte and a missing folder", async () => {
		await expect(validateStackDir("server")).resolves.toEqual({ ok: false, error: "not_absolute" });
		await expect(validateStackDir(`${stackDir}\0x`)).resolves.toEqual({ ok: false, error: "not_absolute" });
		await expect(validateStackDir(path.join(root, "missing"))).resolves.toEqual({ ok: false, error: "not_found" });
	});

	it("rejects a file where a folder is expected", async () => {
		await expect(validateStackDir(path.join(stackDir, "docker-compose.selfhost.yml"))).resolves.toEqual({ ok: false, error: "not_directory" });
	});

	it("rejects a folder or compose file that others can write", async () => {
		await chmod(stackDir, 0o777);
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "unsafe_directory" });
		await chmod(stackDir, 0o755);
		await chmod(path.join(stackDir, "docker-compose.selfhost.yml"), 0o666);
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a folder owned by another user", async () => {
		await expect(validateStackDir(stackDir, { uid: (process.getuid?.() ?? 1) + 1 })).resolves.toEqual({ ok: false, error: "unsafe_directory" });
	});

	it("rejects a compose file that is a symlink, even to a good file inside the folder", async () => {
		await writeFile(path.join(stackDir, "real.yml"), COMPOSE);
		await rm(path.join(stackDir, "docker-compose.selfhost.yml"));
		await symlink(path.join(stackDir, "real.yml"), path.join(stackDir, "docker-compose.selfhost.yml"));
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a compose file that points outside the folder", async () => {
		const outside = path.join(root, "outside.yml");
		await writeFile(outside, COMPOSE);
		await rm(path.join(stackDir, "docker-compose.selfhost.yml"));
		await symlink(outside, path.join(stackDir, "docker-compose.selfhost.yml"));
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
	});

	it("rejects a folder without the fixed compose file name", async () => {
		await rm(path.join(stackDir, "docker-compose.selfhost.yml"));
		await writeFile(path.join(stackDir, "docker-compose.yml"), COMPOSE);
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "no_compose_file" });
	});

	it("rejects a compose file that is not Multica's, or is too large", async () => {
		await writeFile(path.join(stackDir, "docker-compose.selfhost.yml"), "name: other\nservices:\n  web:\n    image: x\n");
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "not_multica" });
		await writeFile(path.join(stackDir, "docker-compose.selfhost.yml"), `${COMPOSE}${"#".repeat(300 * 1024)}`);
		await expect(validateStackDir(stackDir)).resolves.toEqual({ ok: false, error: "unsafe_compose_file" });
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
