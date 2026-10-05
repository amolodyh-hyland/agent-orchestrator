import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractPreloadSurface } from "./multica-preload-surface.mjs";
import { diffBridge, formatReport } from "./multica-bridge-drift.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "..");
const preloadFile = "apps/desktop/src/preload/index.ts";

function usage() {
	return `Usage: npm run check:multica-bridge -- [--multica <dir>] [--update-baseline] [--help]\n`;
}

function parseArguments(argv) {
	const parsed = { multica: undefined, updateBaseline: false, help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help" || argument === "-h") {
			parsed.help = true;
		} else if (argument === "--update-baseline") {
			parsed.updateBaseline = true;
		} else if (argument === "--multica") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) return { error: true };
			parsed.multica = value;
			index += 1;
		} else {
			return { error: true };
		}
	}
	return parsed;
}

function multicaCommit(root) {
	try {
		return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim() || null;
	} catch {
		return null;
	}
}

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function validateBaseline(baseline) {
	if (!isPlainObject(baseline)) return "expected a plain object";
	if (!("multicaCommit" in baseline) || (baseline.multicaCommit !== null && typeof baseline.multicaCommit !== "string")) {
		return "multicaCommit must be a string or null";
	}
	if (typeof baseline.preload !== "string") return "preload must be a string";
	if (!Array.isArray(baseline.globals) || !baseline.globals.every((value) => typeof value === "string")) {
		return "globals must be an array of strings";
	}
	if (!isPlainObject(baseline.members)) return "members must be a plain object";
	for (const [global, members] of Object.entries(baseline.members)) {
		if (!Array.isArray(members) || !members.every((value) => typeof value === "string")) {
			return `members.${global} must be an array of strings`;
		}
	}
	if (!Array.isArray(baseline.entries)) return "entries must be an array";
	const kinds = new Set(["invoke", "send", "sendSync", "on", "postMessage", "sendToHost"]);
	for (const [index, entry] of baseline.entries.entries()) {
		if (!isPlainObject(entry)) return `entries[${index}] must be an object`;
		if (typeof entry.api !== "string") return `entries[${index}].api must be a string`;
		if (typeof entry.channel !== "string") return `entries[${index}].channel must be a string`;
		if (!kinds.has(entry.kind)) return `entries[${index}].kind is invalid`;
	}
	return null;
}

function loadBaseline(baselinePath) {
	let contents;
	try {
		contents = fs.readFileSync(baselinePath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return { state: "missing", baseline: null };
		return { state: "invalid", reason: error.message, baseline: null };
	}

	let baseline;
	try {
		baseline = JSON.parse(contents);
	} catch (error) {
		return { state: "invalid", reason: `invalid JSON: ${error.message}`, baseline: null };
	}
	const schemaError = validateBaseline(baseline);
	if (schemaError) return { state: "invalid", reason: `invalid schema: ${schemaError}`, baseline: null };
	return { state: "valid", baseline };
}

function sortedEntries(entries) {
	return entries
		.map(({ api, channel, kind }) => ({ api, channel, kind }))
		.sort((left, right) =>
			(left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0) ||
			(left.api < right.api ? -1 : left.api > right.api ? 1 : 0) ||
			(left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0),
		);
}

function baselineData(surface, multicaCommit) {
	return {
		multicaCommit,
		preload: surface.preloadFile,
		globals: surface.globals,
		members: surface.members,
		entries: sortedEntries(surface.entries),
	};
}

function writeBaselineAtomically(baselinePath, baseline) {
	const temporaryPath = `${baselinePath}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
		fs.renameSync(temporaryPath, baselinePath);
	} catch (error) {
		try {
			fs.rmSync(temporaryPath, { force: true });
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

function outboundDifferenceCount(report) {
	return report.added.length + report.removed.length + report.changed.length + report.renamed.length;
}

export async function main(options = {}) {
	let stderr = process.stderr;
	try {
		stderr = options.stderr ?? process.stderr;
		return await runMain(options);
	} catch (error) {
		stderr.write(unexpectedError(error));
		return 2;
	}
}

function unexpectedError(error) {
	return `unexpected error: ${error?.message ?? String(error)}\n`;
}

async function runMain({
	argv = process.argv.slice(2),
	env = process.env,
	cwd = process.cwd(),
	stdout = process.stdout,
	stderr = process.stderr,
	baselinePath = path.join(scriptDirectory, "multica-bridge-baseline.json"),
} = {}) {
	if (!process.features.typescript) {
		stderr.write("Node 22.18+ or 24 is required (TypeScript type stripping)\n");
		return 2;
	}

	const args = parseArguments(argv);
	if (args.error) {
		stderr.write(usage());
		return 2;
	}
	if (args.help) {
		stdout.write(usage());
		return 0;
	}

	const inventoryModule = await import("./multica-bridge-inventory.mjs");
	const multicaValue = args.multica ?? env.MULTICA_DIR ?? path.resolve(frontendDirectory, "../../multica");
	const multicaRoot = path.resolve(cwd, multicaValue);
	const multicaPreloadPath = path.join(multicaRoot, preloadFile);
	if (!fs.existsSync(multicaPreloadPath)) {
		stderr.write(`multica checkout not found at ${multicaRoot}. Pass --multica <dir> or set MULTICA_DIR.\n`);
		return 2;
	}

	const surface = extractPreloadSurface({ root: multicaRoot });
	if (surface.issues.length) {
		for (const issue of surface.issues) {
			stderr.write(`ERROR ${issue.code}: ${issue.message} (${issue.file}:${issue.line})\n`);
		}
		return 2;
	}

	const inventory = inventoryModule.collectBridgeInventory();
	const bridgeError = inventory.issues.find((issue) => issue.code === "bridge-error");
	if (bridgeError) {
		stderr.write(`ERROR ${bridgeError.code}: ${bridgeError.message}\n`);
		return 2;
	}

	const resolvedBaselinePath = path.resolve(cwd, baselinePath);
	const loadedBaseline = loadBaseline(resolvedBaselinePath);
	if (loadedBaseline.state === "invalid" && !args.updateBaseline) {
		stderr.write(`baseline file is invalid: ${loadedBaseline.reason} (${resolvedBaselinePath})\n`);
		return 2;
	}
	const baseline = loadedBaseline.state === "valid" ? loadedBaseline.baseline : null;
	const report = diffBridge({ surface, inventory, baseline });
	const commit = multicaCommit(multicaRoot);
	const reportText = formatReport(report, {
		multicaRoot,
		multicaCommit: commit,
		baselineCommit: baseline?.multicaCommit,
		preloadFile: surface.preloadFile,
		servedCount: Object.keys(inventory.served).length,
	});

	if (args.updateBaseline) {
		if (outboundDifferenceCount(report) > 0) {
			stdout.write(reportText);
			stdout.write("baseline not updated: the outbound check fails\n");
			return 1;
		}
		const updatedBaseline = baselineData(surface, commit);
		try {
			writeBaselineAtomically(resolvedBaselinePath, updatedBaseline);
		} catch (error) {
			stderr.write(`could not write baseline ${resolvedBaselinePath}: ${error.message}\n`);
			return 2;
		}
		const shortCommit = commit ? commit.slice(0, 7) : "unknown";
		stdout.write(`baseline updated: ${updatedBaseline.entries.length} entries @ ${shortCommit}\n`);
		return 0;
	}

	stdout.write(reportText);
	if (loadedBaseline.state === "missing") {
		stderr.write('no baseline file: run "npm run check:multica-bridge -- --update-baseline" once the check passes\n');
		return 2;
	}
	return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then((exitCode) => {
		process.exitCode = exitCode;
	}).catch((error) => {
		process.stderr.write(unexpectedError(error));
		process.exitCode = 2;
	});
}
