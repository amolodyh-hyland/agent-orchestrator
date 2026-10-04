import { existsSync } from "node:fs";
import path from "node:path";

export const UPDATES_DISABLED_MARKER = "ao-updates-disabled";

/**
 * Builds that must never self-update (for example, builds that bundle Multica's
 * desktop UI) ship this marker in Resources; runtime detection needs no environment variables.
 */
export function isUpdatesDisabledBuild(
	resourcesPath: string | undefined = process.resourcesPath,
	exists: (file: string) => boolean = existsSync,
): boolean {
	if (!resourcesPath) return false;
	return exists(path.join(resourcesPath, UPDATES_DISABLED_MARKER));
}
