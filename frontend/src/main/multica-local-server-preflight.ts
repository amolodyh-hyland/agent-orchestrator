import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { CORE_SCHEMA, load } from "js-yaml";
import { projectEngineCommand, projectContainersCommand, projectNamedContainersCommand, projectInspectCommand, projectResourcesCommand, projectResourceInspectCommand, type CommandResult, type CommandSpec } from "./multica-local-server-commands";

export type ProjectSnapshot = {
	endpoint: string;
	engineId: string;
	containers: Array<{ id: string; name: string; imageId: string; image: string; state: string; service: string; configFiles: string; workingDir: string; mounts: unknown[]; project: string | null }>;
	volumes: string[];
	networks: string[];
	resources: Array<{ kind: "volume" | "network"; name: string; fingerprint: string; project: string | null }>;
};
export type ProjectApprovalRequest = { action: "start" | "stop" | "restart"; stackDir: string; snapshot: ProjectSnapshot; digest: string };
export type ProjectApproval = { digest: string; action: ProjectApprovalRequest["action"]; recoveryReceipt: string };
export const snapshotDigest = (snapshot: ProjectSnapshot): string => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

export type ProjectTargets = { services: string[]; volumes: string[]; networks: string[] };

export function resolveProjectTargets(recipe: string): ProjectTargets {
	const document = load(recipe, { schema: CORE_SCHEMA }) as { name?: unknown; services?: object; volumes?: object };
	if (document?.name !== "multica" || !document.services || typeof document.services !== "object") throw new Error("invalid project recipe");
	const services = Object.keys(document.services).sort();
	const volumes = Object.keys(document.volumes ?? {}).sort();
	if (!services.every((name) => /^[a-z][a-z0-9_-]{0,62}$/.test(name)) || !volumes.every((name) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(name))) throw new Error("invalid target names");
	return { services, volumes: volumes.map((name) => `multica_${name}`), networks: ["multica_default"] };
}

function lines(text: string): string[] {
	return text.trim() === "" ? [] : text.trim().split(/\r?\n/);
}

export async function inspectMulticaProject(endpoint: string, docker: string, run: (command: CommandSpec) => Promise<CommandResult>, targets: ProjectTargets): Promise<ProjectSnapshot> {
	const checked = async (spec: CommandSpec): Promise<string> => {
		const result = await run(spec);
		if (result.error) throw new Error("project inventory failed");
		return result.stdout;
	};
	const engineId = (await checked(projectEngineCommand(docker))).trim();
	if (!/^[a-zA-Z0-9:_-]{8,128}$/.test(engineId)) throw new Error("missing engine identity");
	const labeledIds = lines(await checked(projectContainersCommand(docker)));
	const namedIds = lines(await checked(projectNamedContainersCommand(docker, targets.services)));
	if (new Set(labeledIds).size !== labeledIds.length || new Set(namedIds).size !== namedIds.length) throw new Error("ambiguous project inventory");
	const ids = [...new Set([...labeledIds, ...namedIds])].sort();
	const containers: ProjectSnapshot["containers"] = [];
	if (ids.length > 0) {
		const rows = lines(await checked(projectInspectCommand(docker, ids)));
		for (const row of rows) {
			const value = JSON.parse(row);
			if (!Array.isArray(value) || value.length !== 7) throw new Error("invalid project inventory");
			const [id, name, imageId, image, state, labels, mounts] = value;
			if (![id, name, imageId, image, state].every((field) => typeof field === "string" && field.length > 0) ||
				!/^sha256:[a-f0-9]{64}$/.test(imageId) || !Array.isArray(mounts) || (labels !== null && (typeof labels !== "object" || Array.isArray(labels)))) throw new Error("invalid project identity");
			const label = (key: string): string => typeof labels?.[key] === "string" ? labels[key] : "unknown";
			containers.push({ id, name, imageId, image, state, service: label("com.docker.compose.service"), configFiles: label("com.docker.compose.project.config_files"), workingDir: label("com.docker.compose.project.working_dir"), mounts, project: typeof labels?.["com.docker.compose.project"] === "string" ? labels["com.docker.compose.project"] : null });
		}
		containers.sort((a, b) => a.id.localeCompare(b.id));
		if (JSON.stringify(containers.map((c) => c.id)) !== JSON.stringify(ids)) throw new Error("incomplete project inventory");
	}
	const resources: ProjectSnapshot["resources"] = [];
	const resourceNames = async (kind: "volume" | "network", targetNames: string[]): Promise<string[]> => {
		const parseNames = (text: string): string[] => lines(text).map((line) => {
			const name: unknown = JSON.parse(line);
			if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error("invalid project resource");
			return name;
		});
		const labeled = parseNames(await checked(projectResourcesCommand(docker, kind)));
		const named = parseNames(await checked(projectResourcesCommand(docker, kind, true))).filter((name) => targetNames.includes(name));
		const names = [...new Set([...labeled, ...named])].sort();
		if (names.length > 0) {
			const values = lines(await checked(projectResourceInspectCommand(docker, kind, names))).map((line) => JSON.parse(line));
			if (values.length !== names.length || JSON.stringify(values.map((v) => v?.Name).sort()) !== JSON.stringify(names)) throw new Error("incomplete resource identities");
			for (const value of values) resources.push({ kind, name: value.Name, fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex"), project: typeof value.Labels?.["com.docker.compose.project"] === "string" ? value.Labels["com.docker.compose.project"] : null });
		}
		return names;
	};
	const volumes = await resourceNames("volume", targets.volumes);
	const networks = await resourceNames("network", targets.networks);
	resources.sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
	return { endpoint, engineId, containers, volumes, networks, resources };
}

export const hasProjectConflict = (snapshot: ProjectSnapshot): boolean => snapshot.containers.length + snapshot.volumes.length + snapshot.networks.length > 0;

async function protectedFile(file: string) {
	if (!path.isAbsolute(file) || await realpath(file) !== file) throw new Error("recovery path must be canonical");
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const info = await lstat(file);
	if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))) throw new Error("recovery file must be private and owned");
	for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
		const parent = await lstat(dir);
		if (!parent.isDirectory() || (uid !== undefined && (parent.uid !== uid && parent.uid !== 0 || (parent.mode & 0o022) !== 0))) throw new Error("unsafe recovery directory");
		if (path.dirname(dir) === dir) break;
	}
	const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	const opened = await handle.stat();
	if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.mode !== info.mode || opened.uid !== info.uid) {
		await handle.close();
		throw new Error("recovery file changed");
	}
	return handle;
}

export async function verifyRecoveryReceipt(file: string, digest: string): Promise<void> {
	const handle = await protectedFile(file);
	let receipt;
	try {
		if ((await handle.stat()).size > 64 * 1024) throw new Error("recovery receipt too large");
		receipt = JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
	if (receipt.version !== 1 || receipt.snapshotDigest !== digest || receipt.configurationPreserved !== true || receipt.imageIdentitiesPreserved !== true || receipt.dataBackupComplete !== true || receipt.restoreVerified !== true) throw new Error("incomplete recovery evidence");
	for (const key of ["configurationArchive", "imageArchive", "dataBackup", "restoreProcedure", "restoreVerification"] as const) {
		const artifact = receipt[key];
		if (!artifact || typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("missing recovery artifact");
		const artifactFile = await protectedFile(artifact.path);
		try {
			const before = await artifactFile.stat();
			const hash = createHash("sha256");
			for await (const chunk of artifactFile.createReadStream({ autoClose: false })) hash.update(chunk);
			const after = await artifactFile.stat();
			if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash.digest("hex") !== artifact.sha256) throw new Error("recovery artifact changed");
		} finally {
			await artifactFile.close();
		}
	}
}
