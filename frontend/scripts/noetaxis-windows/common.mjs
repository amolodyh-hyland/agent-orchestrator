import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const repository = "https://github.com/amolodyh-hyland/agent-orchestrator";
export const executable = "agent-orchestrator.exe";
export const manifestName = "build-manifest.json";

export function safeRelative(name) {
	if (typeof name !== "string" || !name || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe Windows manifest path");
	return name;
}

export async function hash(file) {
	const result = createHash("sha256");
	for await (const chunk of createReadStream(file)) result.update(chunk);
	return result.digest("hex");
}

export async function inventory(root, prefix = "") {
	const info = await lstat(path.join(root, prefix));
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Manifest root must be a real directory");
	const files = [];
	for (const name of (await readdir(path.join(root, prefix))).sort()) {
		const relative = safeRelative(prefix ? `${prefix}/${name}` : name);
		const file = path.join(root, relative);
		const stat = await lstat(file);
		if (stat.isSymbolicLink()) throw new Error(`Links are forbidden in distribution: ${relative}`);
		if (stat.isDirectory()) files.push(...await inventory(root, relative));
		else if (stat.isFile()) files.push({ path: relative, size: stat.size, sha256: await hash(file) });
		else throw new Error(`Unsupported distribution entry: ${relative}`);
	}
	const names = files.map((file) => file.path.toLowerCase());
	if (new Set(names).size !== names.length) throw new Error("Case-colliding distribution paths");
	return files;
}

export function validateManifest(value) {
	if (value.schemaVersion !== 1 || value.platform !== "win32" || value.arch !== "x64" || value.appDirectory !== "app" || value.executable !== executable || value.source?.repository !== repository || !/^[a-f0-9]{40}$/.test(value.source.revision) || !/^[a-f0-9]{40}$/.test(value.source.tree) || !/^\d+\.\d+\.\d+-noetaxis\.[a-f0-9]{7}$/.test(value.version) || !value.version.endsWith(value.source.revision.slice(0, 7)) || !/^\d+$/.test(value.databaseSchema) || value.multica?.repository !== "https://github.com/amolodyh-hyland/multica" || !/^[a-f0-9]{40}$/.test(value.multica.revision) || !["https://registry.npmjs.org/", "https://proget.onbase.net/npm/npm"].includes(value.registry) || !Array.isArray(value.files) || !value.files.length) throw new Error("Invalid Windows build manifest or fork provenance");
	const seen = new Set();
	for (const file of value.files) {
		safeRelative(file.path);
		if (seen.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || file.path === manifestName || file.path === "SHA256SUMS") throw new Error("Invalid manifest file entry");
		seen.add(file.path.toLowerCase());
	}
	for (const name of [`app/${executable}`, "app/resources/app.asar", "app/resources/daemon/ao.exe", "app/resources/ao-updates-disabled", "app/resources/multica-desktop/renderer/index.html", "app/resources/multica-cli/multica.exe", "app/resources/multica-cli/LICENSE", "app/resources/multica-cli/NOTICE", "app/resources/multica-cli/multica.sha256", "app/resources/dictation-helper/ao-dictation.exe", "app/resources/acp-runtime/node/node.exe", "app/resources/agent-browser/agent-browser.exe", "app/resources/agent-browser/LICENSE-agent-browser", "app/resources/agent-browser/LICENSE-axe-core", "app/resources/agent-browser/LICENSE-axe-core-THIRD-PARTY", "app/resources/browser-extension/manifest.json", "app/resources/browser-extension/background.js", "app/resources/browser-extension/content.js"]) {
		if (!seen.has(name.toLowerCase())) throw new Error(`Manifest missing integrated resource: ${name}`);
	}
	if (!seen.has("app/resources/multica-desktop/preload/index.js") && !seen.has("app/resources/multica-desktop/preload/index.cjs")) throw new Error("Missing Multica preload");
	if (!value.files.some((file) => /^installers\/.+\.exe$/i.test(file.path))) throw new Error("Missing NSIS Windows installer");
	return value;
}

export async function verifyPE(file) {
	const fd = await open(file, "r");
	try {
		const header = Buffer.alloc(64);
		if ((await fd.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString("ascii", 0, 2) !== "MZ") throw new Error("Expected Windows x64 PE executable");
		const pe = Buffer.alloc(6);
		if ((await fd.read(pe, 0, 6, header.readUInt32LE(60))).bytesRead !== 6 || pe.toString("ascii", 0, 4) !== "PE\0\0" || pe.readUInt16LE(4) !== 0x8664) throw new Error("Expected Windows x64 PE executable");
	} finally { await fd.close(); }
}

export async function writeManifest(directory, metadata) {
	const value = validateManifest({ ...metadata, schemaVersion: 1, platform: "win32", arch: "x64", appDirectory: "app", executable, files: await inventory(directory) });
	await verifyResources(directory, value);
	await writeFile(path.join(directory, manifestName), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
	await writeFile(path.join(directory, "SHA256SUMS"), `${await hash(path.join(directory, manifestName))}  ${manifestName}\n`, { flag: "wx" });
	return value;
}

export async function verifyBuild(directory) {
	const sums = await readFile(path.join(directory, "SHA256SUMS"), "utf8");
	if (sums !== `${await hash(path.join(directory, manifestName))}  ${manifestName}\n`) throw new Error("Invalid Windows completion checksum");
	const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, manifestName), "utf8")));
	const actual = (await inventory(directory)).filter((file) => ![manifestName, "SHA256SUMS"].includes(file.path));
	const expected = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path, "en"));
	actual.sort((a, b) => a.path.localeCompare(b.path, "en"));
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Distribution files differ from build manifest");
	await verifyResources(directory, manifest);
	return manifest;
}

async function verifyResources(directory, manifest) {
	for (const name of [`app/${executable}`, "app/resources/daemon/ao.exe", "app/resources/multica-cli/multica.exe", "app/resources/dictation-helper/ao-dictation.exe", "app/resources/acp-runtime/node/node.exe", "app/resources/agent-browser/agent-browser.exe"]) await verifyPE(path.join(directory, name));
	if ((await readFile(path.join(directory, "app/resources/multica-cli/multica.sha256"), "utf8")).trim().split(/\s+/)[0] !== await hash(path.join(directory, "app/resources/multica-cli/multica.exe"))) throw new Error("Multica CLI resource checksum mismatch");
	for (const file of manifest.files.filter((file) => /(?:LICENSE|NOTICE|\/index\.(?:html|cjs|js)|\/browser-extension\/(?:manifest.json|background.js|content.js))$/.test(file.path))) if (file.size === 0) throw new Error(`Empty packaged app resource: ${file.path}`);
}
