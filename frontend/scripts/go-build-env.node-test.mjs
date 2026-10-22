import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { daemonBuildEnv } from "./go-build-env.mjs";

describe("daemon cgo build environment", () => {
	it("overrides inherited cgo=0 and verifies the effective macOS setting", () => {
		const env = { CGO_ENABLED: "0", KEEP: "value" };
		let calls = 0;
		const result = daemonBuildEnv({
			platform: "darwin", env, cwd: "/scratch/backend",
			run: (command, args, options) => {
				calls++;
				assert.equal(command, "go");
				assert.deepEqual(args, ["env", "CGO_ENABLED"]);
				assert.equal(options.cwd, "/scratch/backend");
				assert.deepEqual(options.env, { CGO_ENABLED: "1", KEEP: "value" });
				return { status: 0, stdout: "1\n" };
			},
		});
		assert.equal(calls, 1);
		assert.deepEqual(result, { CGO_ENABLED: "1", KEEP: "value" });
		assert.equal(env.CGO_ENABLED, "0");
	});
	for (const result of [
		{ status: 0, stdout: "0\n" },
		{ status: 0, stdout: "" },
		{ status: 0, stdout: "unknown\n" },
		{ status: 1, stdout: "1\n" },
		{ status: null, error: new Error("missing toolchain") },
	]) {
		it(`blocks an unverified macOS cgo setting (${result.stdout?.trim() || result.status})`, () => {
			assert.throws(() => daemonBuildEnv({ platform: "darwin", env: {}, run: () => result }), /require cgo/);
		});
	}
	for (const platform of ["linux", "win32"]) {
		it(`preserves ${platform} settings without a cgo probe`, () => {
			const env = { CGO_ENABLED: "0" };
			assert.equal(daemonBuildEnv({ platform, env, run: () => assert.fail("unexpected cgo probe") }), env);
		});
	}
});
