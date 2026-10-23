import { createHash } from "node:crypto";
import type { ProjectSnapshot, ProjectTargets } from "./multica-local-server-preflight";
import { composeConfigCommand, imageInspectCommand, type CommandResult, type CommandSpec, type StackPaths } from "./multica-local-server-commands";

export type PlannedMount = { name: string; destination: string; writable: boolean };
export type ProjectMutationPlan = {
	services: Array<{ service: string; image: string; imageId: string; mounts: PlannedMount[] }>;
	volumes: string[];
	networks: string[];
};

const sorted = (values: readonly string[]) => [...values].sort();
const sameNames = (a: readonly string[], b: readonly string[]) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
export const mutationApprovalDigest = (snapshot: ProjectSnapshot, plan: ProjectMutationPlan, targetIdentity: string, action: string, stack: StackPaths): string =>
	createHash("sha256").update(JSON.stringify({ snapshot, plan, targetIdentity, action, stack })).digest("hex");

export async function resolveMutationPlan(action: "start" | "stop" | "restart", before: ProjectSnapshot, targets: ProjectTargets, docker: string, stack: StackPaths, run: (spec: CommandSpec) => Promise<CommandResult>): Promise<ProjectMutationPlan> {
	if (action !== "start") return { services: [], volumes: before.volumes, networks: before.networks };
	const config = await run(composeConfigCommand(docker, stack));
	if (config.error) throw new Error("Cannot resolve Compose configuration");
	const value = JSON.parse(config.stdout);
	if (value?.name !== "multica" || !value.services || !sameNames(Object.keys(value.services), targets.services)) throw new Error("Unexpected Compose services");
	const volumes = Object.values(value.volumes ?? {}).map((volume) => (volume as { name?: unknown })?.name);
	if (!volumes.every((name): name is string => typeof name === "string") || !sameNames(volumes, targets.volumes)) throw new Error("Unexpected Compose volumes");
	if (!sameNames(Object.keys(value.networks ?? {}), ["default"]) || value.networks.default.name !== "multica_default") throw new Error("Unexpected Compose networks");
	const services: ProjectMutationPlan["services"] = [];
	for (const service of targets.services) {
		const definition = value.services[service];
		if (typeof definition.image !== "string") throw new Error("Missing image reference");
		const inspected = await run(imageInspectCommand(docker, definition.image));
		const imageId = inspected.stdout.trim();
		if (inspected.error || !/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Image unavailable; approve a separate pull or build first");
		if (!Array.isArray(definition.volumes ?? [])) throw new Error("Unexpected mount shape");
		const mounts = (definition.volumes ?? []).map((mount: { type?: string; source?: string; target?: string; read_only?: boolean }) => {
			const name = mount.source === undefined ? undefined : value.volumes?.[mount.source]?.name;
			if (mount.type !== "volume" || typeof name !== "string" || !targets.volumes.includes(name) || typeof mount.target !== "string" || !mount.target.startsWith("/")) throw new Error("Unexpected Compose mount");
			return { name, destination: mount.target, writable: mount.read_only !== true };
		});
		services.push({ service, image: definition.image, imageId, mounts });
	}
	return { services, volumes, networks: targets.networks };
}

function mountsMatch(actual: unknown[], expected: PlannedMount[]): boolean {
	if (actual.length !== expected.length) return false;
	return expected.every((want) => actual.some((entry) => {
		const mount = entry as { Type?: unknown; Name?: unknown; Destination?: unknown; RW?: unknown };
		return mount?.Type === "volume" && mount.Name === want.name && mount.Destination === want.destination && mount.RW === want.writable;
	}));
}

export function projectMatchesMutation(action: "start" | "stop" | "restart", before: ProjectSnapshot, after: ProjectSnapshot, targets: ProjectTargets, plan: ProjectMutationPlan, stack: StackPaths): boolean {
	if (before.endpoint !== after.endpoint || before.engineId !== after.engineId) return false;
	const volumes = action === "start" ? [...new Set([...before.volumes, ...plan.volumes])] : before.volumes;
	const networks = action === "start" ? [...new Set([...before.networks, ...plan.networks])] : before.networks;
	if (!sameNames(volumes, after.volumes) || !sameNames(networks, after.networks)) return false;
	for (const original of before.resources) {
		if (!after.resources.some((now) => now.kind === original.kind && now.name === original.name && now.fingerprint === original.fingerprint)) return false;
	}
	for (const resource of after.resources) {
		if (!before.resources.some((original) => original.kind === resource.kind && original.name === resource.name) && resource.project !== "multica") return false;
	}
	const untouched = before.containers.filter((c) => !targets.services.includes(c.service));
	for (const original of untouched) {
		if (!after.containers.some((now) => JSON.stringify(now) === JSON.stringify(original))) return false;
	}
	const changed = after.containers.filter((c) => !untouched.some((original) => original.id === c.id));
	if (action === "start") {
		if (changed.length !== plan.services.length) return false;
		return plan.services.every((want) => changed.some((now) => now.service === want.service && now.project === "multica" &&
			(now.name === `/multica-${want.service}-1` || now.name === `/multica_${want.service}_1`) && now.imageId === want.imageId && now.state === "running" && now.configFiles === stack.file && now.workingDir === stack.dir && mountsMatch(now.mounts, want.mounts)));
	}
	const originalTargets = before.containers.filter((c) => targets.services.includes(c.service));
	if (changed.length !== originalTargets.length) return false;
	return originalTargets.every((original) => changed.some((now) => {
		const expectedState = action === "stop" ? now.state === "exited" || now.state === "created" : now.state === "running";
		return expectedState && JSON.stringify({ ...now, state: original.state }) === JSON.stringify(original);
	}));
}
