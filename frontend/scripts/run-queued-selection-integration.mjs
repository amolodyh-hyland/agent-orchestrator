import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const frontendRoot = path.resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "ao-queued-selection-"));
const binary = path.join(temporary, process.platform === "win32" ? "chat.test.exe" : "chat.test");
function run(command, args, cwd, env = process.env) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
	});
}
try {
	await run("go", ["test", "-p", "2", "-c", "-o", binary, "./internal/service/chat"], path.join(frontendRoot, "..", "backend"));
	await run(process.execPath, [path.join(frontendRoot, "node_modules", "vitest", "vitest.mjs"), "run", "--config", "vite.renderer.config.ts", "src/renderer/components/chat/ChatWorkspace.test.tsx", "-t", "frontend to backend argument-only", "--maxWorkers=1"], frontendRoot, { ...process.env, AO_QUEUED_SELECTION_TEST_BINARY: binary });
} finally {
	await rm(temporary, { recursive: true, force: true });
}
