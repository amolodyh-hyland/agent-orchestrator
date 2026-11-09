import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function entrypoint(action, platform = process.platform) {
	if (!["build", "install", "update"].includes(action)) throw new Error("Expected build, install or update");
	if (!["darwin", "win32"].includes(platform)) throw new Error("Custom desktop wrappers support macOS arm64 and Windows x64");
	return path.join(path.dirname(fileURLToPath(import.meta.url)), platform === "win32" ? "noetaxis-windows" : "noetaxis-macos", action === "build" ? "build.mjs" : "app.mjs");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [action, ...args] = process.argv.slice(2);
		const result = spawnSync(process.execPath, [entrypoint(action), ...(action === "build" ? [] : [action]), ...args], { stdio: "inherit", windowsHide: true });
		if (result.error) throw result.error;
		process.exitCode = result.status ?? 1;
	} catch (error) { console.error(error.message); process.exitCode = 1; }
}
