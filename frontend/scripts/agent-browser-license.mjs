import { copyFile } from "node:fs/promises";
import path from "node:path";

export const AGENT_BROWSER_LICENSE_FILES = [
	["LICENSE-agent-browser", "LICENSE-agent-browser"],
	["LICENSE-axe-core", "LICENSE-axe-core"],
	["LICENSE-axe-core-THIRD-PARTY", "LICENSE-axe-core-THIRD-PARTY"],
];

export async function copyAgentBrowserLicenses(sourceDir, outputDir) {
	for (const [sourceName, outputName] of AGENT_BROWSER_LICENSE_FILES) {
		await copyFile(path.join(sourceDir, sourceName), path.join(outputDir, outputName));
	}
}
