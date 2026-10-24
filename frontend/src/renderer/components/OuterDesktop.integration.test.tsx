import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { components } from "../../api/schema";
import { createMainProcessDelegationAuthority } from "../../main/multica-delegation-authority";
import { registerOuterNative } from "../../main/outer-native";
import {
	OUTER_CANCEL,
	OUTER_READ,
	OUTER_RESULT,
	OUTER_STAGE,
	OUTER_USER_ACTION,
	type OuterResult,
} from "../../shared/outer-native";
import { aoBridge } from "../lib/bridge";
import { setApiBaseUrl } from "../lib/api-client";
import { readOuter } from "../lib/outer-read";
import { toSnapshot } from "../hooks/useConversation";
import { typeInLexicalEditor } from "../test/lexical";
import { ChatWorkspace } from "./chat/ChatWorkspace";
import { ElicitationDock } from "./chat/ElicitationDock";
import { NativeApprovalCard } from "./chat/NativeApprovalCard";
import { OuterConsole } from "./OuterConsole";
import { TooltipProvider } from "./ui/tooltip";
import { DesktopActionConfirmation } from "./DesktopActionConfirmation";
import { TaskComposer } from "./TaskComposer";
import { ProjectSettingsForm } from "./ProjectSettingsForm";
import { agentReadiness } from "../test/agent-readiness-fixtures";

vi.mock("../hooks/useWorkspaceQuery", async (original) => ({
	...(await original<typeof import("../hooks/useWorkspaceQuery")>()),
	useWorkspaceQuery: () => ({
		data: [
			{ id: "a", name: "Alpha", sessions: [] },
			{ id: "b", name: "Beta", sessions: [] },
		],
		refetch: vi.fn(),
	}),
}));
vi.mock("./settings/ProjectAgentRoleControls", () => ({
	AgentModelField: ({
		model,
		effort,
		onModelChange,
		onEffortChange,
	}: {
		model: string;
		effort: string;
		onModelChange: (v: string) => void;
		onEffortChange: (v: string) => void;
	}) => (
		<>
			<input
				aria-label="Test model choice"
				value={model}
				onChange={(e) => onModelChange(e.target.value)}
			/>
			<input
				aria-label="Test effort choice"
				value={effort}
				onChange={(e) => onEffortChange(e.target.value)}
			/>
		</>
	),
}));
vi.mock("./settings/SettingsOptionMenu", () => ({
	SettingsOptionMenu: () => null,
}));

type HTTPResult = {
	status: number;
	body: string;
	headers: Record<string, string>;
};
type Receipt = {
	request: { id: string; sessionId: string; humanMessage: string };
	state: string;
};
type Stats = {
	workers: Array<{
		id: string;
		projectId: string;
		displayName: string;
		metadata: { prompt: string };
	}>;
	launches: number;
	sends: number;
	approvals: number;
	inputs: Record<
		string,
		{ Action: string; Content?: Record<string, unknown> }
	>;
	requests: Receipt[];
	reservations: unknown[];
	starts: Array<{
		model: string;
		effort: string;
		permissions: string;
		nativeId: string;
	}>;
};

async function backend() {
	const child = spawn(
		process.env.AO_OUTER_DESKTOP_TEST_BINARY!,
		[
			"-test.run=^TestOuterDesktopFrontendIntegration$",
			"-test.timeout=180s",
		],
		{
			env: { ...process.env, AO_OUTER_DESKTOP_FRONTEND: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		}
	);
	let output = "",
		sequence = 0;
	const pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	let ready!: () => void, failReady!: (error: Error) => void;
	const started = new Promise<void>((resolve, reject) => {
		ready = resolve;
		failReady = reject;
	});
	createInterface({ input: child.stdout }).on("line", (line) => {
		output += line + "\n";
		if (line === "OUTER_DESKTOP_READY") ready();
		if (line.startsWith("OUTER_DESKTOP_RESULT:")) {
			const result = JSON.parse(
				line.slice("OUTER_DESKTOP_RESULT:".length)
			) as { id: number; data: unknown };
			pending.get(result.id)?.resolve(result.data);
			pending.delete(result.id);
		}
	});
	child.stderr.on("data", (chunk) => {
		output += String(chunk);
	});
	const finished = new Promise<void>((resolve, reject) => {
		const fail = (error: Error) => {
			failReady(error);
			for (const waiter of pending.values()) waiter.reject(error);
			reject(error);
		};
		child.once("error", fail);
		child.once("exit", (code) =>
			code === 0
				? resolve()
				: fail(new Error(`Outer integration exited ${code}: ${output}`))
		);
	});
	void finished.catch(() => {});
	await started;
	const command = <T,>(input: Record<string, unknown>) =>
		new Promise<T>((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
			child.stdin.write(JSON.stringify({ ...input, id }) + "\n");
		});
	return {
		command,
		http: (path: string, init: RequestInit = {}) =>
			command<HTTPResult>({
				path,
				method: init.method ?? "GET",
				body: String(init.body ?? ""),
				headers: init.headers ?? {},
			}),
		stats: () => command<Stats>({ kind: "stats" }),
		finish: async () => {
			child.stdin.end();
			await finished;
		},
		kill: () => {
			child.kill();
		},
	};
}

function desktop(b: Awaited<ReturnType<typeof backend>>) {
	// Every ordinary renderer request also reaches the disposable real router.
	// Metadata catalogs are fixtures; no network, daemon or provider is touched.
	setApiBaseUrl("http://127.0.0.1:9999");
	vi.stubGlobal(
		"fetch",
		async (input: Request | URL | string, init?: RequestInit) => {
			const url = new URL(
				input instanceof Request ? input.url : String(input)
			);
			const method =
				input instanceof Request
					? input.method
					: (init?.method ?? "GET");
			if (method === "GET" && url.pathname === "/api/v1/agents/readiness")
				return Response.json({
					agents: [agentReadiness("codex", "Codex")],
				});
			if (method === "GET" && url.pathname.endsWith("/models"))
				return Response.json({
					agentId: "codex",
					models: [],
					selectionMode: "catalog",
					allowCustom: true,
					customModelEntry: "direct",
					refreshRecommended: false,
				});
			if (
				method === "GET" &&
				url.pathname === "/api/v1/agents/auth-plans"
			)
				return Response.json({ plans: [] });
			if (method === "GET" && url.pathname === "/api/v1/settings")
				return Response.json({
					defaultSessionMode: "chat",
					chatHarnesses: ["codex"],
					cloudEnabled: false,
					localEnabled: true,
				});
			const body =
				input instanceof Request
					? await input.clone().text()
					: init?.body;
			const response = await b.http(url.pathname + url.search, {
				...init,
				method,
				body,
				headers:
					input instanceof Request
						? Object.fromEntries(input.headers)
						: init?.headers,
			});
			return new Response(response.body || null, {
				status: response.status,
				headers: response.headers,
			});
		}
	);
	const handlers = new Map<
		string,
		(event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
	>();
	const listeners = new Set<(result: OuterResult) => void>();
	const results: OuterResult[] = [];
	const shell = {
		id: 11,
		mainFrame: {},
		isDestroyed: () => false,
		isFocused: () => true,
		on: vi.fn(),
		removeListener: vi.fn(),
		send: (channel: string, result: OuterResult) => {
			if (channel === OUTER_RESULT) {
				results.push(result);
				for (const listener of listeners) listener(result);
			}
		},
	};
	const event = {
		sender: { id: shell.id },
		senderFrame: shell.mainFrame,
	} as unknown as IpcMainInvokeEvent;
	const registration = registerOuterNative({
		ipcMain: {
			handle: (channel, callback) => {
				handlers.set(channel, callback);
			},
			removeHandler: vi.fn(),
		},
		shellWebContents: shell as unknown as WebContents,
		authority: createMainProcessDelegationAuthority(Buffer.alloc(32, 13)),
		origin: () => "http://127.0.0.1:9999",
		fetch: (async (url: string, init: RequestInit) => {
			const response = await b.http(new URL(url).pathname, init);
			return new Response(response.body, {
				status: response.status,
				headers: response.headers,
			});
		}) as typeof fetch,
	});
	vi.mocked(aoBridge.outer.read).mockImplementation(
		async (query) =>
			(await handlers.get(OUTER_READ)!(event, query)) as Awaited<
				ReturnType<typeof aoBridge.outer.read>
			>
	);
	vi.mocked(aoBridge.outer.stage).mockImplementation(
		async (slot, draft) =>
			(await handlers.get(OUTER_STAGE)!(event, slot, draft)) as Awaited<
				ReturnType<typeof aoBridge.outer.stage>
			>
	);
	vi.mocked(aoBridge.outer.cancel).mockImplementation(async (id) => {
		await handlers.get(OUTER_CANCEL)!(event, id);
	});
	vi.mocked(aoBridge.outer.onResult).mockImplementation((listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	});
	return {
		registration,
		results,
		gesture: async (name: string) => {
			const button = await screen.findByRole("button", {
				name,
			});
			await waitFor(() => {
				expect(button).toBeEnabled();
				expect(button.dataset.outerStageId).toBeTruthy();
			});
			const identity = {
				id: button.dataset.outerStageId,
				digest: button.dataset.outerStageDigest,
			};
			expect(identity.id).toBeTruthy();
			const before = results.length;
			// JSDOM cannot create a trusted OS gesture. Enter at the isolated
			// preload's private boundary, after using the rendered exact stage.
			await act(async () => {
				await handlers.get(OUTER_USER_ACTION)!(event, identity);
			});
			expect(results).toHaveLength(before + 1);
			await handlers.get(OUTER_USER_ACTION)!(event, identity);
			expect(results).toHaveLength(before + 1);
			return results.at(-1)!;
		},
	};
}

const clients: QueryClient[] = [];
function mount(component = <OuterConsole />, entry = "/outer") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	clients.push(client);
	const root = createRootRoute({
		component: () => (
			<>
				<Outlet />
				<DesktopActionConfirmation />
			</>
		),
	});
	const outer = createRoute({
		getParentRoute: () => root,
		path: "/outer",
		component: () => component,
		validateSearch: (s: Record<string, unknown>) => ({
			auditProjectId: s.auditProjectId,
		}),
	});
	const chat = createRoute({
		getParentRoute: () => root,
		path: "/projects/$projectId/sessions/$sessionId",
		component: () => <p>Chat history link</p>,
	});
	const router = createRouter({
		routeTree: root.addChildren([outer, chat]),
		history: createMemoryHistory({ initialEntries: [entry] }),
	});
	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</QueryClientProvider>
	);
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	setApiBaseUrl(null);
});

it.skipIf(!process.env.AO_OUTER_DESKTOP_TEST_BINARY)(
	"New Task, standalone task and Project Settings require the exact native confirmation after enrollment",
	async () => {
		const b = await backend();
		const d = desktop(b);
		try {
			let ui = mount();
			await screen.findByRole("button", { name: "Set up outer Chat" });
			await userEvent.type(
				screen.getByLabelText("Test model choice"),
				"chosen-model"
			);
			expect((await d.gesture("Set up outer Chat")).ok).toBe(true);
			await userEvent.click(
				await screen.findByRole("checkbox", { name: "Alpha a" })
			);
			expect((await d.gesture("Save exact scope")).ok).toBe(true);
			ui.unmount();

			const onCreated = vi.fn();
			ui = mount(<TaskComposer projectId="a" onCreated={onCreated} />);
			await userEvent.type(
				await screen.findByLabelText("Task"),
				"Read the selected Project reports"
			);
			await userEvent.click(
				await screen.findByRole("button", { name: "Start task" })
			);
			await screen.findByRole("dialog", {
				name: "Confirm desktop action",
			});
			expect(
				screen.getByRole("dialog", { name: "Confirm desktop action" })
			).toHaveTextContent("Read the selected Project reports");
			expect((await b.stats()).workers).toHaveLength(0);
			// Scripted renderer clicks can only display the frozen request.
			await userEvent.click(
				screen.getByRole("button", { name: "Confirm action" })
			);
			expect((await b.stats()).workers).toHaveLength(0);
			expect(onCreated).not.toHaveBeenCalled();
			expect(await d.gesture("Confirm action")).toMatchObject({
				ok: true,
				record: { status: 202 },
			});
			await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
			expect((await b.stats()).workers).toMatchObject([
				{
					projectId: "a",
					metadata: { prompt: "Read the selected Project reports" },
				},
			]);
			ui.unmount();

			ui = mount(
				<TaskComposer
					projectId="__standalone__"
					onCreated={onCreated}
				/>
			);
			await userEvent.type(
				await screen.findByLabelText("Task"),
				"A standalone human task"
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Start task" })
				).toBeEnabled()
			);
			await userEvent.click(
				screen.getByRole("button", { name: "Start task" })
			);
			await screen.findByRole("dialog", {
				name: "Confirm desktop action",
			});
			expect((await b.stats()).workers).toHaveLength(1);
			expect(await d.gesture("Confirm action")).toMatchObject({
				ok: true,
				record: { status: 201 },
			});
			await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(2));
			expect((await b.stats()).workers).toHaveLength(2);
			ui.unmount();

			ui = mount(<ProjectSettingsForm projectId="a" section="general" />);
			await userEvent.click(
				await screen.findByRole("button", {
					name: "Edit Project name",
				})
			);
			const name = screen.getByRole("textbox", { name: "Project name" });
			await userEvent.clear(name);
			await userEvent.type(name, "Human renamed Project");
			await screen.findByRole(
				"dialog",
				{ name: "Confirm desktop action" },
				{ timeout: 5000 }
			);
			const project = async () =>
				JSON.parse((await b.http("/api/v1/projects/a")).body).project;
			expect((await project()).name).toBe("A");
			await userEvent.click(
				screen.getByRole("button", { name: "Confirm action" })
			);
			expect((await project()).name).toBe("A");
			expect((await d.gesture("Confirm action")).ok).toBe(true);
			await waitFor(async () =>
				expect((await project()).name).toBe("Human renamed Project")
			);
			ui.unmount();

			// Identical public calls without a native gesture remain held.
			for (const [path, method, body] of [
				[
					"/api/v1/orchestrators/delegate",
					"POST",
					{
						projectId: "a",
						brief: "Read the selected Project reports",
						agent: "codex",
					},
				],
				[
					"/api/v1/sessions",
					"POST",
					{
						kind: "worker",
						harness: "codex",
						prompt: "A standalone human task",
					},
				],
				[
					"/api/v1/projects/a",
					"PUT",
					{ displayName: "Human renamed Project", config: {} },
				],
			] as const)
				expect(
					(await b.http(path, { method, body: JSON.stringify(body) }))
						.status
				).toBe(409);
			expect((await b.stats()).workers).toHaveLength(2);
			expect(await b.stats()).toMatchObject({ launches: 1, sends: 0 });
		} finally {
			cleanup();
			d.registration.dispose();
			await b.finish();
		}
	},
	40_000
);

it.skipIf(!process.env.AO_OUTER_DESKTOP_TEST_BINARY)(
	"preserves authority and receipts through the desktop to SQLite workflow without native computation on reopen",
	async () => {
		const b = await backend();
		const d = desktop(b);
		const openExternal = vi
			.spyOn(aoBridge.app, "openExternal")
			.mockResolvedValue(undefined);
		const snapshot = async (session: string) => {
			const response = await b.http(
				`/api/v1/sessions/${session}/conversation`
			);
			expect(response.status).toBe(200);
			return toSnapshot(
				JSON.parse(
					response.body
				) as components["schemas"]["ConversationSnapshotResponse"]
			);
		};
		try {
			let ui = mount();
			await screen.findByRole("button", { name: "Set up outer Chat" });
			expect(await b.stats()).toMatchObject({
				launches: 0,
				sends: 0,
				requests: [],
			});
			await userEvent.type(
				screen.getByLabelText("Test model choice"),
				"chosen-model"
			);
			await userEvent.type(
				screen.getByLabelText("Test effort choice"),
				"high"
			);
			expect((await d.gesture("Set up outer Chat")).ok).toBe(true);
			await screen.findByRole("checkbox", { name: "Alpha a" });
			await userEvent.click(
				screen.getByRole("checkbox", { name: "Alpha a" })
			);
			await userEvent.click(
				screen.getByRole("checkbox", { name: "Beta b" })
			);
			expect((await d.gesture("Save exact scope")).ok).toBe(true);
			const view = await readOuter({ projection: "view" });
			const session = view.binding!.sessionId;
			expect(view.binding!.projectIds).toEqual(["a", "b"]);
			expect(await b.stats()).toMatchObject({
				launches: 1,
				sends: 0,
				starts: [
					{
						model: "chosen-model",
						effort: "high",
						permissions: "default",
					},
				],
			});
			ui.unmount();

			ui = mount(
				<ChatWorkspace
					snapshot={await snapshot(session)}
					onSend={vi.fn(() => {
						throw new Error("unbound Chat send");
					})}
				/>
			);
			await typeInLexicalEditor(
				await screen.findByLabelText("Message the agent"),
				"Inspect selected evidence"
			);
			const sent = await d.gesture("Send message");
			expect(sent.ok).toBe(true);
			expect(await b.stats()).toMatchObject({
				sends: 1,
				requests: [
					{
						request: { humanMessage: "Inspect selected evidence" },
						state: "provider_submitted",
					},
				],
			});
			ui.unmount();

			const target = {
				sessionId: session,
				generation: view.session!.controllerGeneration,
			};
			for (const kind of ["approval", "form", "url"] as const) {
				await b.command({ kind: "event", event: kind });
				const activity = (await snapshot(session)).items.find(
					(item) =>
						item.kind === "activity" &&
						item.requestId === `native-${kind}`
				);
				expect(activity?.kind).toBe("activity");
				if (activity?.kind !== "activity")
					throw new Error("pending native interaction missing");
				ui = mount(
					kind === "approval" ? (
						<NativeApprovalCard
							activity={activity}
							target={target}
						/>
					) : (
						<ElicitationDock
							activity={activity}
							nativeTarget={target}
						/>
					)
				);
				if (kind === "form")
					await userEvent.click(
						await screen.findByRole("radio", { name: "reports" })
					);
				if (kind === "url") {
					expect(
						screen.queryByRole("button", { name: "Continue" })
					).not.toBeInTheDocument();
					await userEvent.click(
						await screen.findByRole("button", {
							name: "Open example.invalid",
						})
					);
					await waitFor(() =>
						expect(openExternal).toHaveBeenCalledWith(
							"https://example.invalid/selected-evidence"
						)
					);
					expect(
						(await b.stats()).inputs["native-url"]
					).toBeUndefined();
				}
				expect(
					(
						await d.gesture(
							kind === "approval" ? "Allow once" : "Continue"
						)
					).ok
				).toBe(true);
				ui.unmount();
			}
			expect(await b.stats()).toMatchObject({
				sends: 1,
				approvals: 1,
				inputs: {
					"native-form": {
						Action: "accept",
						Content: { choice: "reports" },
					},
					"native-url": { Action: "accept" },
				},
			});
			await b.command({ kind: "event", event: "settle" });
			expect((await b.stats()).reservations).toHaveLength(0);

			ui = mount();
			await screen.findByRole("checkbox", { name: "Alpha a" });
			await userEvent.click(
				screen.getByRole("checkbox", { name: "Alpha a" })
			);
			expect((await d.gesture("Save exact scope")).ok).toBe(true);
			await screen.findByText(
				/old conversation contains removed sources/
			);
			ui.unmount();
			ui = mount(undefined, "/outer?auditProjectId=a");
			await screen.findByText(/Affected Project: Alpha · a/);
			await waitFor(() =>
				expect(
					screen.getAllByText(/native.turn.started/).length
				).toBeGreaterThan(0)
			);
			expect(await b.stats()).toMatchObject({ launches: 1, sends: 1 });
			expect(
				(await d.gesture("Start a fresh remaining-scope conversation"))
					.ok
			).toBe(true);
			const fresh = await readOuter({ projection: "view" });
			expect(fresh.binding).toMatchObject({
				projectIds: ["b"],
				historyHeld: false,
			});
			expect(fresh.binding!.sessionId).not.toBe(session);
			const starts = (await b.stats()).starts;
			expect(starts[1].nativeId).not.toBe(starts[0].nativeId);
			expect(starts[1]).toMatchObject({
				model: "chosen-model",
				effort: "high",
				permissions: "default",
			});
			ui.unmount();

			await b.command({ kind: "event", event: "uncertain" });
			ui = mount(
				<ChatWorkspace
					snapshot={await snapshot(fresh.binding!.sessionId)}
					onSend={vi.fn()}
				/>
			);
			await typeInLexicalEditor(
				await screen.findByLabelText("Message the agent"),
				"Exact uncertain request"
			);
			expect((await d.gesture("Send message")).ok).toBe(false);
			const uncertain = await b.stats();
			expect(uncertain).toMatchObject({ sends: 2, launches: 2 });
			expect(
				uncertain.requests.some(
					(r) =>
						r.request.humanMessage === "Exact uncertain request" &&
						r.state === "unknown"
				)
			).toBe(true);
			expect(uncertain.reservations).toHaveLength(1);
			ui.unmount();
			await b.command({ kind: "restart" });
			ui = mount();
			await screen.findByText(/ · unknown · /);
			await userEvent.click(
				screen.getByRole("button", { name: "Refresh" })
			);
			expect(await b.stats()).toMatchObject({ sends: 2, launches: 2 });
			expect((await b.stats()).reservations).toHaveLength(1);
			for (const path of [
				"/api/v1/outer",
				"/api/v1/outer/facts?projectId=b&kind=sessions",
				"/api/v1/outer/audit?projectId=a",
			])
				expect((await b.http(path)).status).toBe(409);
			ui.unmount();
			await b.finish();
		} finally {
			openExternal.mockRestore();
			d.registration.dispose();
			b.kill();
		}
	},
	120_000
);
