import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { signingIdentity } from "./noetaxis-macos/build.mjs";
import { makeBuildFixture } from "./noetaxis-macos-build-fixture.mjs";

test("local signing is opt-in and rejects multiline identities", () => {
	assert.equal(signingIdentity({}), "-");
	assert.equal(signingIdentity({ NOETAXIS_SIGN_IDENTITY: "  Noetaxis Local Code Signing  " }), "Noetaxis Local Code Signing");
	assert.throws(() => signingIdentity({ NOETAXIS_SIGN_IDENTITY: "name\nother" }));
});

for (const identity of ["-", "Noetaxis Local Code Signing"]) test(`the mocked build signs both helper and app using ${identity}`, async (t) => {
	const previous = process.env.NOETAXIS_SIGN_IDENTITY;
	process.env.NOETAXIS_SIGN_IDENTITY = identity;
	t.after(() => { if (previous === undefined) delete process.env.NOETAXIS_SIGN_IDENTITY; else process.env.NOETAXIS_SIGN_IDENTITY = previous; });
	const fixture = await makeBuildFixture(t);
	const output = await fixture.run(["--public-registry"]);
	const calls = fixture.calls.filter((call) => call.command === "/usr/bin/codesign" && call.args.includes("--sign"));
	assert.equal(calls.length, 2);
	for (const call of calls) assert.equal(call.args[call.args.indexOf("--sign") + 1], identity);
	assert.match(await readFile(new URL("BUILD-INFO.txt", `file://${output.outputDir}/`), "utf8"), new RegExp(`Signature: ${identity === "-" ? "ad-hoc" : identity}; not notarized`));
});

test("the user certificate helper only prints commands and never invokes keychain tools", async () => {
	const helper = new URL("./noetaxis-macos/local-signing-commands.sh", import.meta.url);
	const source = await readFile(helper, "utf8");
	assert.match(source, /^#!\/bin\/sh\nset -eu\ncat <<'COMMANDS'\n/);
	assert.ok(source.endsWith("\nCOMMANDS\n"));
	const result = spawnSync("/bin/sh", [helper.pathname], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /extendedKeyUsage = critical,codeSigning/);
	assert.match(result.stdout, /security import/);
	assert.match(result.stdout, /export NOETAXIS_SIGN_IDENTITY=/);
});
