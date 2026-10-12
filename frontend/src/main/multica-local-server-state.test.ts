import { describe, expect, it } from "vitest";
import {
	classifyDockerError,
	deriveLocalServerState,
	isComposeMissing,
	isPortConflict,
	parseComposeList,
	parseComposePs,
	probeOutcomeFromCheck,
	publishedWebPort,
	redactCommandText,
	STARTING_GRACE_MS,
	type ContainerInfo,
	type DeriveInput,
} from "./multica-local-server-state";

const up = (service: string, extra: Partial<ContainerInfo> = {}): ContainerInfo => ({ service, state: "running", health: "", exitCode: 0, publishedPorts: [], ...extra });
const ALL_UP = [up("postgres", { health: "healthy" }), up("backend", { publishedPorts: [8080] }), up("frontend", { publishedPorts: [3000] })];

const base: DeriveInput = {
	op: null,
	folder: "ok",
	hasEnv: true,
	docker: "ok",
	composeInstalled: true,
	containers: [],
	inspected: true,
	probe: "unreachable",
	unreadyForMs: 0,
	portFailure: false,
};
const derive = (patch: Partial<DeriveInput>) => deriveLocalServerState({ ...base, ...patch });

describe("deriveLocalServerState", () => {
	it("reports an operation in flight above everything else", () => {
		for (const op of ["setting_up", "starting_server", "stopping", "restarting", "docker_starting"] as const) {
			expect(derive({ op, docker: "not_installed", containers: ALL_UP })).toBe(op);
		}
	});

	it("reports Docker problems first, then the folder, then setup", () => {
		expect(derive({ docker: "not_installed", folder: "none" })).toBe("docker_not_installed");
		expect(derive({ composeInstalled: false })).toBe("compose_missing");
		expect(derive({ docker: "not_running" })).toBe("docker_not_running");
		expect(derive({ docker: "not_running", folder: "none" })).toBe("docker_not_running");
		expect(derive({ folder: "none" })).toBe("no_folder");
		expect(derive({ folder: "invalid" })).toBe("invalid_folder");
		expect(derive({ hasEnv: false })).toBe("needs_setup");
	});

	it("is unknown, never stopped, when the stack could not be inspected", () => {
		expect(derive({ inspected: false })).toBe("unknown");
		expect(derive({ inspected: false, probe: "unreachable", containers: [] })).toBe("unknown");
		expect(derive({ inspected: false, probe: "ok" })).toBe("unknown");
		expect(derive({ docker: "unknown" })).toBe("unknown");
	});

	it("still reports the things that do not need an inspection first", () => {
		expect(derive({ inspected: false, docker: "not_running" })).toBe("docker_not_running");
		expect(derive({ inspected: false, hasEnv: false })).toBe("needs_setup");
		expect(derive({ inspected: false, folder: "invalid" })).toBe("invalid_folder");
		expect(derive({ inspected: false, op: "stopping" })).toBe("stopping");
	});

	it("is stopped when there are no running containers and nothing answers", () => {
		expect(derive({})).toBe("stopped");
		expect(derive({ containers: [up("postgres", { state: "exited", exitCode: 0 })] })).toBe("stopped");
		expect(derive({ probe: "unknown" })).toBe("stopped");
	});

	it("tells a copy running elsewhere from a port taken by something else", () => {
		expect(derive({ probe: "ok" })).toBe("running_elsewhere");
		expect(derive({ probe: "not_ready" })).toBe("running_elsewhere");
		expect(derive({ probe: "other_listener" })).toBe("port_conflict");
		expect(derive({ probe: "unreachable", portFailure: true })).toBe("port_conflict");
	});

	it("is healthy only when all three services run and the server answers", () => {
		expect(derive({ containers: ALL_UP, probe: "ok" })).toBe("healthy");
		expect(derive({ containers: ALL_UP.filter((c) => c.service !== "frontend"), probe: "ok", unreadyForMs: STARTING_GRACE_MS + 1 })).toBe("unhealthy");
	});

	it("is starting while running containers do not answer yet, and unhealthy after the grace period", () => {
		expect(derive({ containers: ALL_UP, probe: "unreachable", unreadyForMs: 0 })).toBe("starting");
		expect(derive({ containers: ALL_UP, probe: "not_ready", unreadyForMs: STARTING_GRACE_MS - 1 })).toBe("starting");
		expect(derive({ containers: ALL_UP, probe: "unreachable", unreadyForMs: STARTING_GRACE_MS })).toBe("unhealthy");
	});

	it("treats created containers and Compose health 'starting' as starting", () => {
		expect(derive({ containers: [up("postgres", { health: "starting" })] })).toBe("starting");
		expect(derive({ containers: [up("postgres"), up("backend", { state: "created" })] })).toBe("starting");
		expect(derive({ containers: [{ ...up("backend"), state: "created" }] })).toBe("starting");
	});

	it("is unhealthy at once when a service exited, restarts or reports unhealthy", () => {
		expect(derive({ containers: [up("postgres"), up("backend", { state: "exited", exitCode: 1 }), up("frontend")], probe: "ok" })).toBe("unhealthy");
		expect(derive({ containers: [up("postgres"), up("backend", { state: "restarting" }), up("frontend")] })).toBe("unhealthy");
		expect(derive({ containers: [up("postgres", { health: "unhealthy" }), up("backend"), up("frontend")], probe: "ok" })).toBe("unhealthy");
	});
});

describe("parseComposePs", () => {
	const line = (service: string, state: string, extra = "") => `{"Service":"${service}","State":"${state}","Health":"","ExitCode":0${extra}}`;

	it("reads newline-delimited JSON (newer Compose)", () => {
		const out = [line("postgres", "running"), line("frontend", "running", ',"Publishers":[{"URL":"127.0.0.1","TargetPort":3000,"PublishedPort":3001,"Protocol":"tcp"}]')].join("\n");
		const parsed = parseComposePs(out);
		expect(parsed?.map((c) => c.service)).toEqual(["postgres", "frontend"]);
		expect(publishedWebPort(parsed ?? [])).toBe(3001);
	});

	it("reads a JSON array (older Compose) and an empty result", () => {
		expect(parseComposePs(`[${line("backend", "Exited")}]`)?.[0]).toMatchObject({ service: "backend", state: "exited" });
		expect(parseComposePs("")).toEqual([]);
		expect(parseComposePs("[]")).toEqual([]);
	});

	it("rejects output that is not Compose JSON", () => {
		expect(parseComposePs("error: nope")).toBeNull();
		expect(parseComposePs(`${line("a", "running")}\nnot json`)).toBeNull();
		expect(parseComposePs("42")).toBeNull();
	});

	it("reports no web port when the frontend publishes nothing", () => {
		expect(publishedWebPort([up("backend", { publishedPorts: [8080] })])).toBeNull();
	});
});

describe("parseComposeList", () => {
	it("reads projects with their config files", () => {
		const out = JSON.stringify([{ Name: "multica", Status: "running(3)", ConfigFiles: "/a/docker-compose.selfhost.yml, /a/override.yml" }]);
		expect(parseComposeList(out)).toEqual([{ name: "multica", status: "running(3)", configFiles: ["/a/docker-compose.selfhost.yml", "/a/override.yml"] }]);
		expect(parseComposeList("garbage")).toBeNull();
	});
});

describe("docker error classification", () => {
	it("tells a missing docker from a stopped engine", () => {
		expect(classifyDockerError(null)).toBe("ok");
		expect(classifyDockerError({ code: "ENOENT" })).toBe("not_installed");
		expect(classifyDockerError({ code: 1 }, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe("not_running");
		expect(classifyDockerError({ code: 1 }, "dial unix /Users/me/.docker/run/docker.sock: connect: connection refused")).toBe("not_running");
		expect(classifyDockerError({ code: "NO_LOCAL_ENGINE" })).toBe("not_running");
		expect(classifyDockerError({ code: 1 }, "")).toBe("not_running");
	});

	it("does not call an error that proves nothing a stopped engine", () => {
		expect(classifyDockerError({ code: 1 }, "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock")).toBe("unknown");
		expect(classifyDockerError({ code: 1 }, "Got permission denied")).toBe("unknown");
		expect(classifyDockerError({ code: 1 }, 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.24/version": dial unix /var/run/docker.sock: connect: permission denied')).toBe("unknown");
		expect(classifyDockerError({ code: 1 }, "request returned 500 Internal Server Error for API route")).toBe("unknown");
	});

	it("recognizes a missing Compose plugin and a taken port", () => {
		expect(isComposeMissing("docker: 'compose' is not a docker command.")).toBe(true);
		expect(isComposeMissing("something else")).toBe(false);
		expect(isPortConflict("Bind for 127.0.0.1:3000 failed: port is already allocated")).toBe(true);
		expect(isPortConflict("listen tcp 127.0.0.1:8080: bind: address already in use")).toBe(true);
		expect(isPortConflict("no such image")).toBe(false);
	});

	it("maps the server check onto the probe outcomes", () => {
		expect(probeOutcomeFromCheck({ ok: true })).toBe("ok");
		expect(probeOutcomeFromCheck({ ok: false, error: "not_ready" })).toBe("not_ready");
		expect(probeOutcomeFromCheck({ ok: false, error: "unreachable" })).toBe("unreachable");
		expect(probeOutcomeFromCheck({ ok: false, error: "not_multica" })).toBe("other_listener");
		expect(probeOutcomeFromCheck({ ok: false, error: "timeout" })).toBe("other_listener");
		expect(probeOutcomeFromCheck({ ok: false, error: "invalid_url" })).toBe("unknown");
	});
});

describe("redactCommandText", () => {
	it("removes secret-looking assignments, URL credentials and bearer tokens", () => {
		const text = [
			"error: JWT_SECRET=abc123def is invalid",
			'POSTGRES_PASSWORD="p w d"',
			"MULTICA_VCS_SECRET_KEY: s3cr3t",
			"DATABASE_URL postgres://multica:hunter2@postgres:5432/db",
			"Authorization: Bearer eyJhbGciOi.abc.def",
		].join("\n");
		const redacted = redactCommandText(text);

		for (const secret of ["abc123def", "p w d", "s3cr3t", "hunter2", "eyJhbGciOi"]) expect(redacted).not.toContain(secret);
		expect(redacted).toContain("JWT_SECRET=[redacted]");
		expect(redacted).toContain("postgres://[redacted]@postgres");
	});

	it("keeps ordinary messages and caps the length at the tail", () => {
		expect(redactCommandText("required variable JWT_SECRET is missing a value")).toBe("required variable JWT_SECRET is missing a value");
		const long = `${"x".repeat(1000)}END`;
		expect(redactCommandText(long)).toHaveLength(400);
		expect(redactCommandText(long).endsWith("END")).toBe(true);
	});
});
