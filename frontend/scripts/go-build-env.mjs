import { spawnSync } from "node:child_process";

export function buildSourceRevision(override, gitRevision) {
	if (override !== undefined) {
		if (!/^tree-[0-9a-f]{40}$/.test(override)) throw new Error("AO_BUILD_SOURCE_REVISION must identify an exact source tree as tree-<40 lowercase hex characters>");
		return override;
	}
	return gitRevision?.trim() || undefined;
}

export function daemonBuildEnv({ platform = process.platform, env = process.env, cwd, run = spawnSync } = {}) {
	if (platform !== "darwin") return env;
	const buildEnv = { ...env, CGO_ENABLED: "1" };
	const result = run("go", ["env", "CGO_ENABLED"], {
		cwd,
		env: buildEnv,
		encoding: "utf8",
		windowsHide: true,
	});
	if (result.error || result.status !== 0 || result.stdout?.trim() !== "1") {
		throw new Error("macOS daemon builds require cgo for managed-policy ACL verification; go env CGO_ENABLED must return 1");
	}
	return buildEnv;
}
