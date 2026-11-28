import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applySourceSnapshot, exportedSourceTree, matchedBuildEnv, parseArgs, stageMatchedMultica, stampVersion, verifyMatchedModfile } from "./noetaxis-macos/build.mjs";
import { makeBuildFixture } from "./noetaxis-macos-build-fixture.mjs";
import { buildSourceRevision } from "./go-build-env.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (directory, ...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();

async function root(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "ao-source-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function matchedFixture(t) {
	const directory = await root(t);
	const input = { version: 1 };
	for (const name of ["source", "server", "desktop", "notices"]) {
		const dir = path.join(directory, name);
		await mkdir(dir);
		await writeFile(path.join(dir, "content"), `${name} contents`);
		input[name] = { directory: dir };
	}
	await writeFile(path.join(input.server.directory, "go.mod"), "module github.com/multica-ai/multica/server\n\ngo 1.27.4\n");
	await cp(input.server.directory, path.join(input.source.directory, "server"), { recursive: true });
	for (const name of ["LICENSE", "NOTICE"]) await writeFile(path.join(input.notices.directory, name), `${name} contents`);
	for (const name of ["source", "server", "desktop", "notices"]) input[name].tree = await exportedSourceTree(input[name].directory);
	input.source.baseRevision = "b".repeat(40);
	for (const [name, content] of [
		["modfile", `module github.com/aoagents/agent-orchestrator/backend\n\ngo 1.27.4\nreplace github.com/multica-ai/multica/server => ${input.server.directory}\n`],
		["sumfile", "example sum\n"], ["cli", "compiled fixture bytes"], ["overlay", "reviewed full Multica overlay"],
	]) {
		const file = path.join(directory, name);
		await writeFile(file, content);
		const entry = { file, sha256: hash(content) };
		if (name === "overlay") input.source.overlay = entry;
		else input[name] = entry;
	}
	await chmod(input.cli.file, 0o755);
	const file = path.join(directory, "manifest.json");
	const save = async () => {
		const content = JSON.stringify(input);
		await writeFile(file, content);
		return hash(content);
	};
	const stage = path.join(directory, "staged");
	await mkdir(stage);
	return { directory, input, file, stage, save };
}

test("snapshot options require the complete verified overlay and matched input set", () => {
	const snapshot = ["--source-patch", "/patch", "--source-patch-sha256", "a".repeat(64), "--source-tree", "b".repeat(40)];
	assert.throws(() => parseArgs(snapshot), /matched Multica/);
	assert.throws(() => parseArgs(["--source-tree", "b".repeat(40)]), /together/);
	assert.throws(() => parseArgs(["--multica-input", "/manifest"]), /together/);
	const options = parseArgs([...snapshot, "--multica-input", "/manifest", "--multica-input-sha256", "c".repeat(64)]);
	assert.equal(options.sourceTree, "b".repeat(40));
	assert.equal(stampVersion("0.15.3", options.sourceTree), `0.15.3-noetaxis.${"b".repeat(7)}`);
	assert.throws(() => parseArgs([...snapshot, "--source-tree", "bad", "--multica-input", "/manifest", "--multica-input-sha256", "c".repeat(64)]), /full SHA-1/);
});

test("complete binary overlays preserve modes/additions/deletions and produce the exact tree without commits", async t => {
	const directory = await root(t);
	const source = path.join(directory, "source");
	await mkdir(source);
	git(source, "init", "--quiet");
	await writeFile(path.join(source, "removed"), "old");
	await writeFile(path.join(source, "changed"), "before");
	git(source, "add", ".");
	const base = git(source, "write-tree");
	await rm(path.join(source, "removed"));
	await writeFile(path.join(source, "changed"), "after");
	await writeFile(path.join(source, "binary"), Buffer.from([0, 255, 128, 4]));
	await chmod(path.join(source, "changed"), 0o755);
	git(source, "add", ".");
	const expected = git(source, "write-tree");
	const bytes = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", base], { cwd: source });
	const patch = path.join(directory, "overlay.patch");
	await writeFile(patch, bytes);
	git(source, "read-tree", "--reset", "-u", base);
	const options = { sourcePatch: patch, sourcePatchSha256: hash(bytes), sourceTree: expected, multicaInput: "/manifest", multicaInputSha256: "c".repeat(64) };
	const result = await applySourceSnapshot(source, options, directory);
	assert.deepEqual(result, { kind: "staged-tree", tree: expected, patchSha256: hash(bytes) });
	assert.equal(git(source, "write-tree"), expected);
	assert.equal(await readFile(path.join(source, "changed"), "utf8"), "after");
	assert.deepEqual(await readFile(path.join(source, "binary")), Buffer.from([0, 255, 128, 4]));
	await assert.rejects(readFile(path.join(source, "removed")), { code: "ENOENT" });
	assert.throws(() => git(source, "rev-parse", "--verify", "HEAD"), /Command failed/);
	git(source, "read-tree", "--reset", "-u", base);
	await assert.rejects(applySourceSnapshot(source, { ...options, sourcePatchSha256: "0".repeat(64) }, directory), /checksum mismatch/);
	await assert.rejects(applySourceSnapshot(source, { ...options, sourceTree: base }, directory), /reviewed full tree/);
});

test("export hashing matches Git tree objects including executable files and confined symlinks", async t => {
	const directory = await root(t);
	const source = path.join(directory, "export");
	await mkdir(path.join(source, "a"), { recursive: true });
	await mkdir(path.join(source, "empty", "nested"), { recursive: true });
	await writeFile(path.join(source, "a", "child"), "contents");
	await writeFile(path.join(source, "a.txt"), "sibling");
	await writeFile(path.join(source, "executable"), "exec");
	await chmod(path.join(source, "executable"), 0o755);
	await symlink("a/child", path.join(source, "link"));
	const repository = path.join(directory, "repository");
	await mkdir(repository);
	git(repository, "init", "--quiet");
	const tree = execFileSync("git", ["--work-tree", source, "add", "--force", "--all"], { cwd: repository });
	assert.ok(tree);
	assert.equal(await exportedSourceTree(source), git(repository, "write-tree"));
	await symlink("../outside", path.join(source, "escape"));
	await assert.rejects(exportedSourceTree(source), /escapes/);
});

test("matched inputs are copied, verified and rebound privately without historical source downloads", async t => {
	const f = await matchedFixture(t);
	const expected = await f.save();
	const matched = await stageMatchedMultica(f.file, expected, f.stage);
	assert.equal(await exportedSourceTree(matched.server), f.input.server.tree);
	assert.equal(await exportedSourceTree(matched.desktop), f.input.desktop.tree);
	assert.match(await readFile(matched.modfile, "utf8"), new RegExp(matched.server));
	assert.doesNotMatch(await readFile(matched.modfile, "utf8"), new RegExp(f.input.server.directory));
	assert.equal(await readFile(f.input.modfile.file, "utf8"), `module github.com/aoagents/agent-orchestrator/backend\n\ngo 1.27.4\nreplace github.com/multica-ai/multica/server => ${f.input.server.directory}\n`);
	await writeFile(path.join(f.input.desktop.directory, "content"), "later source change");
	assert.equal(await exportedSourceTree(matched.desktop), f.input.desktop.tree);
	const env = matchedBuildEnv(matched, { GOFLAGS: "-modfile=/wrong", GOWORK: "/wrong", AO_MULTICA_CLI_BIN: "/old" });
	assert.equal(env.GOWORK, "off");
	assert.equal(env.GOFLAGS, `-modfile=${matched.modfile} -mod=readonly`);
	assert.equal(env.AO_MULTICA_DESKTOP_OUT, matched.desktop);
	assert.equal(env.AO_MULTICA_CLI_BIN, matched.cli);
	assert.equal(env.AO_MULTICA_NOTICE_DIR, matched.notices);
	assert.equal(matched.provenance.manifestSha256, expected);
});

test("matched input rejects changed manifests, exports, resources and incorrect module bindings", async t => {
	for (const name of ["manifest", "source", "server", "desktop", "notices", "modfile", "sumfile", "cli", "binding"]) {
		const f = await matchedFixture(t);
		let expected = await f.save();
		if (name === "manifest") await writeFile(f.file, "{}");
		else if (name === "binding") {
			await writeFile(f.input.modfile.file, "module github.com/aoagents/agent-orchestrator/backend\nreplace github.com/multica-ai/multica/server => /wrong\n");
			f.input.modfile.sha256 = hash(await readFile(f.input.modfile.file));
			expected = await f.save();
		} else if (f.input[name].directory) await writeFile(path.join(f.input[name].directory, "content"), "changed");
		else await writeFile(f.input[name].file, "changed");
		await assert.rejects(stageMatchedMultica(f.file, expected, f.stage), /mismatch|bind only/);
	}
});

test("a separately valid server export must still match the declared full Multica source", async t => {
	const f = await matchedFixture(t);
	await writeFile(path.join(f.input.server.directory, "content"), "different server");
	f.input.server.tree = await exportedSourceTree(f.input.server.directory);
	await assert.rejects(stageMatchedMultica(f.file, await f.save(), f.stage), /does not match the full source/);
});

test("matched modfile may replace Multica but cannot lower pins or change other dependencies", () => {
	const source = "module example\nrequire dependency v2.0.0\nreplace github.com/multica-ai/multica/server => github.com/fork/multica/server v0.0.0-20260101000000-abcdefabcdef\n";
	const matched = "module example\nrequire dependency v2.0.0\nreplace github.com/multica-ai/multica/server => /verified/export\n";
	verifyMatchedModfile(source, matched);
	assert.throws(() => verifyMatchedModfile(source, matched.replace("v2.0.0", "v1.0.0")), /outside the Multica binding/);
});

test("matched builder wires only verified module/resources and signs the nested dictation app", async t => {
	const input = await matchedFixture(t);
	const fixture = await makeBuildFixture(t);
	await writeFile(path.join(fixture.source, "backend/go.mod"), (await readFile(input.input.modfile.file, "utf8"))
		.replace(input.input.server.directory, "github.com/amolodyh-hyland/multica/server v0.0.0-20261127074222-2e31e5c9d746"));
	await fixture.run(["--public-registry", "--multica-input", input.file, "--multica-input-sha256", await input.save()]);
	assert.equal(fixture.calls.some(({ command, args }) => command === "git" && args[0] === "clone"), false);
	assert.equal(fixture.calls.some(({ command }) => command === "corepack"), false);
	const forge = fixture.calls.find(({ command }) => command.endsWith("/electron-forge"));
	assert.equal(forge.options.env.GOWORK, "off");
	assert.equal(forge.options.env.AO_BUILD_SOURCE_REVISION, undefined);
	assert.match(forge.options.env.GOFLAGS, /^-modfile=.*matched\.mod -mod=readonly$/);
	assert.match(forge.options.env.AO_MULTICA_DESKTOP_OUT, /matched-desktop$/);
	assert.match(forge.options.env.AO_MULTICA_CLI_BIN, /matched-multica$/);
	assert.match(forge.options.env.AO_MULTICA_NOTICE_DIR, /matched-notices$/);
	const signing = fixture.calls.filter(({ command }) => command === "/usr/bin/codesign");
	assert.ok(signing.some(({ args }) => args.at(-1).endsWith("/dictation-helper/Orchestrator.app")));
	assert.ok(signing.some(({ args }) => args[0] === "--verify" && args.at(-1).endsWith("/dictation-helper/Orchestrator.app")));
	assert.equal(signing.some(({ args }) => args.at(-1).endsWith("/ao-dictation")), false);
	const provenance = JSON.parse(await readFile(path.join(fixture.root, "output/SOURCE-PROVENANCE.json")));
	assert.equal(provenance.multica.source.tree, input.input.source.tree);
	assert.equal(provenance.multica.server.tree, input.input.server.tree);
});

test("full mocked snapshot build stamps the staged tree, actual base and overlay checksum", async t => {
	const input = await matchedFixture(t);
	const fixture = await makeBuildFixture(t);
	await writeFile(path.join(fixture.source, "backend/go.mod"), (await readFile(input.input.modfile.file, "utf8"))
		.replace(input.input.server.directory, "github.com/amolodyh-hyland/multica/server v0.0.0-20261127074222-2e31e5c9d746"));
	git(fixture.source, "init", "--quiet");
	git(fixture.source, "add", ".");
	const base = git(fixture.source, "write-tree");
	await writeFile(path.join(fixture.source, "reviewed-overlay"), Buffer.from([0, 128, 255]));
	git(fixture.source, "add", ".");
	const tree = git(fixture.source, "write-tree");
	const patch = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", base], { cwd: fixture.source });
	const file = path.join(input.directory, "ao.patch");
	await writeFile(file, patch);
	git(fixture.source, "read-tree", "--reset", "-u", base);
	await fixture.run(["--public-registry", "--base-version", "0.15.3", "--source-patch", file,
		"--source-patch-sha256", hash(patch), "--source-tree", tree,
		"--multica-input", input.file, "--multica-input-sha256", await input.save()]);
	const provenance = JSON.parse(await readFile(path.join(fixture.root, "output/SOURCE-PROVENANCE.json")));
	assert.equal(provenance.ao.kind, "staged-tree");
	assert.equal(provenance.ao.tree, tree);
	assert.equal(provenance.ao.patchSha256, hash(patch));
	assert.notEqual(provenance.ao.baseRevision, tree);
	const info = await readFile(path.join(fixture.root, "output/BUILD-INFO.txt"), "utf8");
	assert.match(info, /staged Git tree, not a commit/);
	assert.ok(info.includes(`0.15.3-noetaxis.${tree.slice(0, 7)}`));
	const forge = fixture.calls.find(({ command }) => command.endsWith("/electron-forge"));
	assert.equal(forge.options.env.AO_BUILD_SOURCE_REVISION, `tree-${tree}`);
	assert.equal(buildSourceRevision(forge.options.env.AO_BUILD_SOURCE_REVISION), `tree-${tree}`);
	assert.ok(fixture.calls.some(({ command, args }) => command === "/usr/libexec/PlistBuddy" && args[1].includes(`NoetaxisSourceTree string ${tree}`)));
});

test("build rejects a staged resource changed after its initial verification", async t => {
	const input = await matchedFixture(t);
	const fixture = await makeBuildFixture(t, { mutateMatchedDesktop: true });
	await writeFile(path.join(fixture.source, "backend/go.mod"), (await readFile(input.input.modfile.file, "utf8"))
		.replace(input.input.server.directory, "github.com/amolodyh-hyland/multica/server v0.0.0-20261127074222-2e31e5c9d746"));
	await assert.rejects(fixture.run(["--public-registry", "--multica-input", input.file,
		"--multica-input-sha256", await input.save()]), /desktop changed during the build/);
	assert.equal(fixture.calls.some(({ command }) => command === "/usr/bin/codesign"), false);
});
