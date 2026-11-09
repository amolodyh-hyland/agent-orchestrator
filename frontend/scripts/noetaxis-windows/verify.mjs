import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuild } from "./common.mjs";

export function verifySource(manifest, source) {
	if (source && (!/^[a-f0-9]{40}$/.test(source) || manifest.source.revision !== source)) throw new Error("Requested full AO source revision does not match the build");
	return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [directory, flag, source, ...extra] = process.argv.slice(2);
		if (!directory || flag && (flag !== "--source" || !source) || extra.length) throw new Error("Usage: verify.mjs <build-directory> [--source <full-commit>]");
		console.log(JSON.stringify(verifySource(await verifyBuild(path.resolve(directory)), source), null, 2));
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
