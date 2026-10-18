import { after } from "node:test";
import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const roots = new Map();
const identityHelper = fileURLToPath(new URL("./noetaxis-macos-fixture-identity.py", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

function lookupIdentity(args) {
	const result = nativeSpawnSync("/usr/bin/python3", ["-I", "-S", identityHelper, ...args], { encoding: "utf8", timeout: 2_000 });
	if (result.status !== 0) return undefined;
	try { return JSON.parse(result.stdout); } catch { return undefined; }
}

export const readFixtureIdentity = (pid) => lookupIdentity(["read", String(pid)]);

function validIdentity(identity) {
	return identity && Number.isSafeInteger(identity.pid) && identity.pid > 1 && identity.pid !== process.pid
		&& Array.isArray(identity.start) && identity.start.length === 2 && identity.start.every((part) => /^\d+$/.test(part))
		&& typeof identity.executable === "string" && identity.executable.startsWith("/")
		&& Array.isArray(identity.command) && identity.command.length > 0 && identity.command.every((arg) => typeof arg === "string");
}

function sameFixtureIdentity(expected, current) {
	return validIdentity(expected) && validIdentity(current) && expected.pid === current.pid
		&& JSON.stringify(expected.start) === JSON.stringify(current.start)
		&& expected.executable === current.executable && JSON.stringify(expected.command) === JSON.stringify(current.command);
}

function registrations(root) {
	const file = path.join(root, ".fixture-identities");
	const records = new Map();
	for (const line of existsSync(file) ? readFileSync(file, "utf8").split("\n") : []) {
		try { const identity = JSON.parse(line); if (validIdentity(identity)) records.set(identity.pid, identity); } catch { /* An in-progress append cannot authorize a signal. */ }
	}
	return records;
}

export function signalFixtureProcess(expected, signal, { readIdentity = readFixtureIdentity, sendSignal = (pid, value) => process.kill(pid, value) } = {}) {
	if (!validIdentity(expected) || !["SIGTERM", "SIGKILL"].includes(signal)) return false;
	if (!sameFixtureIdentity(expected, readIdentity(expected.pid))) return false;
	try { sendSignal(expected.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; return false; }
	return true;
}

function rootFor(command, args, options) {
	return [...roots.keys()].find((root) => [options.env?.TMPDIR, options.env?.NOETAXIS_SIM, command, ...args].some((value) => typeof value === "string" && (value === root || value.includes(`${root}/`))));
}

function fixtureOptions(root, options) {
	if (!root) return options;
	const env = { ...(options.env ?? process.env), NOETAXIS_FIXTURE_ROOT: root, NOETAXIS_FIXTURE_IDENTITY: identityHelper, BASH_ENV: path.join(root, "fixture-register.sh") };
	env.PERL5OPT = `${env.PERL5OPT ?? ""} -I${root} -MFixtureRegistry`.trim();
	return { ...options, env };
}

export function fixtureSpawn(command, args = [], options = {}) {
	const root = rootFor(command, args, options);
	const child = nativeSpawn(command, args, fixtureOptions(root, options));
	if (root) {
		roots.get(root).children.add(child);
		if (child.pid) lookupIdentity(["register", root, String(child.pid)]);
	}
	return child;
}

export function fixtureSpawnSync(command, args = [], options = {}) {
	const root = rootFor(command, args, options);
	return nativeSpawnSync(command, args, fixtureOptions(root, options));
}

export function fixtureProcesses(root, { readIdentity = readFixtureIdentity, isAlive = alive } = {}) {
	const ids = new Set();
	const records = registrations(root);
	for (const pid of records.keys()) ids.add(pid);
	for (const name of existsSync(root) ? readdirSync(root) : []) {
		if (name !== ".fixture-pids" && name !== "pid" && !name.endsWith(".pid")) continue;
		for (const line of readFileSync(path.join(root, name), "utf8").split("\n")) if (/^\d+$/.test(line)) ids.add(Number(line));
	}
	for (const child of roots.get(root)?.children ?? []) if (child.exitCode === null && child.signalCode === null && child.pid) ids.add(child.pid);
	return [...ids].filter((pid) => {
		if (pid <= 1 || pid === process.pid || !isAlive(pid)) return false;
		const expected = records.get(pid);
		const current = readIdentity(pid);
		// A reused PID is foreign. Unreadable or exec-changed fixtures remain visible but cannot be signalled.
		return !expected || !validIdentity(current) || JSON.stringify(expected.start) === JSON.stringify(current.start);
	});
}

export function assertNoFixtureProcesses(root) {
	const pids = fixtureProcesses(root);
	if (pids.length) throw new Error(`Fixture processes survived cleanup (${root}): ${pids.join(", ")}`);
}

export async function cleanupFixtureProcesses(root, options = {}) {
	await rm(path.join(root, ".fixture-alive"), { force: true });
	const terminated = new Set();
	let quiet = 0;
	for (let attempt = 0; attempt < 100; attempt++) {
		const pids = fixtureProcesses(root, options);
		if (!pids.length) { if (++quiet === 3) return; } else quiet = 0;
		// Forks register in the private root before exec, including detached grandchildren.
		// Re-read during cleanup so a late fork cannot escape the escalation deadline.
		for (const pid of pids.reverse()) {
			const signal = attempt >= 20 ? "SIGKILL" : !terminated.has(pid) ? "SIGTERM" : undefined;
			if (!signal) continue;
			if (signalFixtureProcess(registrations(root).get(pid), signal, options)) terminated.add(pid);
		}
		await pause(100);
	}
	const remaining = fixtureProcesses(root, options);
	if (remaining.length) throw new Error(`Fixture processes survived cleanup (${root}): ${remaining.join(", ")}`);
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
	await writeFile(path.join(root, "fixture-register.sh"), '/usr/bin/python3 -I -S "$NOETAXIS_FIXTURE_IDENTITY" register "$NOETAXIS_FIXTURE_ROOT" "$$" >/dev/null || exit 125\n');
	await writeFile(path.join(root, "FixtureRegistry.pm"), `package FixtureRegistry;
sub record { my $pid = shift; $pid ||= $$; if ($ENV{NOETAXIS_FIXTURE_ROOT}) {
 open(my $f, ">>", "$ENV{NOETAXIS_FIXTURE_ROOT}/.fixture-pids") or die $!; print $f "$pid\\n"; close($f);
 open(my $identity, "-|", "/usr/bin/python3", "-I", "-S", $ENV{NOETAXIS_FIXTURE_IDENTITY}, "register", $ENV{NOETAXIS_FIXTURE_ROOT}, $pid) or die $!;
 local $/; <$identity>; close($identity);
} }
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
