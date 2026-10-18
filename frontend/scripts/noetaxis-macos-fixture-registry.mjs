import { after } from "node:test";
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const roots = new Map();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

function rootFor(command, args, options) {
	return [...roots.keys()].find((root) => [options.env?.TMPDIR, options.env?.NOETAXIS_SIM, command, ...args].some((value) => typeof value === "string" && (value === root || value.includes(`${root}/`))));
}

function fixtureOptions(root, options) {
	if (!root) return options;
	const env = { ...(options.env ?? process.env), NOETAXIS_FIXTURE_ROOT: root };
	env.PERL5OPT = `${env.PERL5OPT ?? ""} -I${root} -MFixtureRegistry`.trim();
	return { ...options, env };
}

export function fixtureSpawn(command, args = [], options = {}) {
	const root = rootFor(command, args, options);
	const child = nativeSpawn(command, args, fixtureOptions(root, options));
	if (root) roots.get(root).children.add(child);
	return child;
}

export function fixtureSpawnSync(command, args = [], options = {}) {
	const root = rootFor(command, args, options);
	return nativeSpawnSync(command, args, fixtureOptions(root, options));
}

export function fixtureProcesses(root) {
	const ids = new Set();
	for (const name of existsSync(root) ? readdirSync(root) : []) {
		if (name !== ".fixture-pids" && name !== "pid" && !name.endsWith(".pid")) continue;
		for (const line of readFileSync(path.join(root, name), "utf8").split("\n")) if (/^\d+$/.test(line)) ids.add(Number(line));
	}
	for (const child of roots.get(root)?.children ?? []) if (child.exitCode === null && child.signalCode === null && child.pid) ids.add(child.pid);
	return [...ids].filter((pid) => pid > 1 && pid !== process.pid && alive(pid));
}

export function assertNoFixtureProcesses(root) {
	const pids = fixtureProcesses(root);
	if (pids.length) throw new Error(`Fixture processes survived cleanup (${root}): ${pids.join(", ")}`);
}

export async function cleanupFixtureProcesses(root) {
	await rm(path.join(root, ".fixture-alive"), { force: true });
	const terminated = new Set();
	let quiet = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		const pids = fixtureProcesses(root);
		if (!pids.length) { if (++quiet === 3) return; } else quiet = 0;
		// Forks register in the private root before exec, including detached grandchildren.
		// Re-read during cleanup so a late fork cannot escape the escalation deadline.
		for (const pid of pids.reverse()) {
			const signal = attempt >= 20 ? "SIGKILL" : !terminated.has(pid) ? "SIGTERM" : undefined;
			if (!signal) continue;
			try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
			terminated.add(pid);
		}
		await pause(100);
	}
	assertNoFixtureProcesses(root);
}

async function writable(directory) {
	const entry = await lstat(directory).catch(() => undefined);
	if (!entry || entry.isSymbolicLink()) return;
	await chmod(directory, entry.isDirectory() ? 0o755 : 0o644);
	if (entry.isDirectory()) for (const name of await readdir(directory)) await writable(path.join(directory, name));
}

export async function fixtureRoot(t, prefix, options = {}) {
	const root = options.root ?? await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.set(root, { children: new Set() });
	await writeFile(path.join(root, ".fixture-alive"), "alive");
	await writeFile(path.join(root, "FixtureRegistry.pm"), `package FixtureRegistry;
sub record { my $pid = shift; $pid ||= $$; if ($ENV{NOETAXIS_FIXTURE_ROOT}) { open(my $f, ">>", "$ENV{NOETAXIS_FIXTURE_ROOT}/.fixture-pids") or die $!; print $f "$pid\\n"; close($f); } }
BEGIN { record(); my $previous = *CORE::GLOBAL::fork{CODE}; no warnings 'redefine'; *CORE::GLOBAL::fork = sub { my $pid = $previous ? $previous->() : CORE::fork(); record($pid) if defined($pid); return $pid; }; }
1;
`);
	t.after(async () => {
		await cleanupFixtureProcesses(root);
		assertNoFixtureProcesses(root);
		if (!options.retain) {
			await writable(root);
			await rm(root, { recursive: true, force: true });
		}
		roots.delete(root);
	});
	return root;
}

after(() => { for (const root of roots.keys()) assertNoFixtureProcesses(root); });
