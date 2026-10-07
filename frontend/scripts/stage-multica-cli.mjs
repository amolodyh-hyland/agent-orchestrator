import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export const MULTICA_CLI_STAGE_DIR = path.join("multica-desktop", "multica-cli");

function requireFile(file, label) {
	if (!existsSync(file)) throw new Error(`${label} is missing: ${file}`);
	if (!statSync(file).isFile()) throw new Error(`${label} is not a file: ${file}`);
}

export function stageMulticaCli(binaryPath, noticeDir, destDir, platform) {
	if (!binaryPath) throw new Error("AO_MULTICA_CLI_BIN is required to stage the Multica CLI");
	if (!path.isAbsolute(binaryPath)) throw new Error(`AO_MULTICA_CLI_BIN must be an absolute path: ${binaryPath}`);
	requireFile(binaryPath, "Multica CLI binary");
	try {
		accessSync(binaryPath, constants.X_OK);
	} catch {
		throw new Error(`Multica CLI binary is not executable: ${binaryPath}`);
	}
	if (!noticeDir?.trim()) throw new Error("AO_MULTICA_NOTICE_DIR is required when AO_MULTICA_CLI_BIN is set");
	if (!existsSync(noticeDir) || !statSync(noticeDir).isDirectory()) {
		throw new Error(`AO_MULTICA_NOTICE_DIR is not a directory: ${noticeDir}`);
	}
	const licensePath = path.join(noticeDir, "LICENSE");
	const noticePath = path.join(noticeDir, "NOTICE");
	requireFile(licensePath, "Multica LICENSE");
	requireFile(noticePath, "Multica NOTICE");

	const binaryName = platform === "win32" ? "multica.exe" : "multica";
	const binaryMode = statSync(binaryPath).mode & 0o777;
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	copyFileSync(binaryPath, path.join(destDir, binaryName));
	chmodSync(path.join(destDir, binaryName), binaryMode);
	copyFileSync(licensePath, path.join(destDir, "LICENSE"));
	copyFileSync(noticePath, path.join(destDir, "NOTICE"));
	return destDir;
}
