import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentReadinessQueryKey } from "../hooks/useAgentReadinessQuery";
import { agentAuthPlansQueryKey } from "../hooks/useAgentAuth";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient } from "../lib/api-client";
import { useUiStore } from "../stores/ui-store";
import { agentReadiness } from "../test/agent-readiness-fixtures";
import { CreateProjectAgentSheet } from "./CreateProjectAgentSheet";
import { NewTaskDialog } from "./NewTaskDialog";
import { SettingsDialog } from "./SettingsPageTestHarness";
import { TooltipProvider } from "./ui/tooltip";

// Routing and daemon requests are external boundaries; every modal, settings
// form, selector, and recovery action in these tests is the real component.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...await importOriginal<typeof import("@tanstack/react-router")>(),
	useNavigate: () => vi.fn(),
}));

const project = {
	id: "proj-1", name: "Project One", revision: 1, instructions: { shared: "Original", attachments: [{ id: "notes", sourceKind: "machine_local_file", sourceRef: "notes-ref", machineId: "this-machine", mediaType: "text/plain", position: 0, roles: ["shared"], enabled: true, required: false }] }, kind: "single_repo", path: "/repo/project-one", repo: "",
	config: { worker: { agent: "codex" }, orchestrator: { agent: "claude-code" } },
};
let catalog = { agents: [agentReadiness("claude-code", "Claude Code"), agentReadiness("codex", "Codex")] };

function RecoveryDialogs({ origin }: { origin?: "create-project" | "new-task" }) {
	const [open, setOpen] = useState(true);
	return (
		<>
			{origin === "create-project" && <CreateProjectAgentSheet open={open} onOpenChange={setOpen} isCreating={false} kind="single_repo" path="/repo/new-project" onSubmit={async () => undefined} />}
			{origin === "new-task" && <NewTaskDialog open={open} onOpenChange={setOpen} projectId="proj-1" onCreated={() => undefined} />}
			<SettingsDialog />
		</>
	);
}

function renderDialogs(origin?: "create-project" | "new-task") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
	client.setQueryData(agentReadinessQueryKey, catalog);
	client.setQueryData(workspaceQueryKey, []);
	render(<QueryClientProvider client={client}><TooltipProvider><RecoveryDialogs origin={origin} /></TooltipProvider></QueryClientProvider>);
	return client;
}

async function openAgentManagement(label: string) {
	await userEvent.click(await screen.findByLabelText(label));
	const action = screen.queryByRole("menuitem", { name: /^Manage agents(?:…)?$/ }) ?? screen.getByRole("option", { name: /^Manage agents(?:…)?$/ });
	await userEvent.click(action);
	await screen.findByRole("textbox", { name: "Search harnesses" });
}

function requireCodexLogin(client?: QueryClient) {
	catalog = { agents: [agentReadiness("claude-code", "Claude Code"), agentReadiness("codex", "Codex", { authentication: "unauthorized" })] };
	if (client) act(() => client.setQueryData(agentReadinessQueryKey, catalog));
}

beforeEach(() => {
	useUiStore.setState({ settingsModal: null });
	catalog = { agents: [agentReadiness("claude-code", "Claude Code"), agentReadiness("codex", "Codex")] };
	vi.spyOn(apiClient, "GET").mockImplementation(async (path) => {
		if (path === "/api/v1/identity") return { data: { hostId: "this-machine" } } as never;
		if (path === "/api/v1/projects/{id}") return { data: { status: "ok", project } } as never;
		if (path === "/api/v1/agents/readiness") return { data: catalog } as never;
		if (path === "/api/v1/agents/installers") return { data: { agents: [] } } as never;
		if (path === "/api/v1/agents/install-jobs") return { data: { jobs: [] } } as never;
		if (path === "/api/v1/agents/auth-plans") return { data: { plans: [{ agentId: "codex", action: "login", available: true, launchMode: "terminal" }] } } as never;
		if (path === "/api/v1/agents/{agent}/models") return { data: { agentId: "codex", models: [], selectionMode: "text", allowCustom: true, source: "manual", fetchedAt: "2026-09-19T00:00:00Z", stale: false } } as never;
		if (path === "/api/v1/settings") return { data: { defaultSessionMode: "tui", chatHarnesses: [], cloudEnabled: false, localEnabled: true, trackerIntakeEnabled: true } } as never;
		throw new Error(`Unexpected GET ${path}`);
	});
	vi.spyOn(apiClient, "POST").mockImplementation(async (path) => {
		if (path === "/api/v1/agents/readiness/ensure") return { data: catalog } as never;
		if (path === "/api/v1/agents/codex/accounts/ensure") return { data: { accountRevision: 0, accounts: [], capabilities: {}, deviceReconciliation: { status: "verified", activeAccountVerified: false, reasonCode: "verified", retryable: false } } } as never;
		throw new Error(`Unexpected POST ${path}`);
	});
	vi.spyOn(apiClient, "PUT").mockResolvedValue({ data: { project } } as never);
});

afterEach(() => vi.restoreAllMocks());

describe("Settings recovery modal integration", () => {
	it("closes clean project settings without writing", async () => {
		const put = vi.spyOn(apiClient, "PUT");
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await screen.findByRole("button", { name: "Edit Project name" });
		expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
		await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
		expect(put).not.toHaveBeenCalled();
	});

	it.each(["close button", "Escape"])("saves edited project settings on %s", async (dismiss) => {
		const put = vi.spyOn(apiClient, "PUT").mockResolvedValue({ data: { status: "ok" } } as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Edit Project name" }));
		const name = screen.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(name);
		await userEvent.type(name, "Renamed project");

		if (dismiss === "Escape") await userEvent.keyboard("{Escape}");
		else await userEvent.click(screen.getByRole("button", { name: "Close settings" }));

		await waitFor(() => expect(put).toHaveBeenCalledWith(
			"/api/v1/projects/{id}",
			expect.objectContaining({ body: expect.objectContaining({ displayName: "Renamed project" }) }),
		));
		await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
	});

	it("keeps edited project settings open when saving fails", async () => {
		vi.spyOn(apiClient, "PUT").mockResolvedValue({ error: { message: "Save rejected" } } as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Edit Project name" }));
		const name = screen.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(name);
		await userEvent.type(name, "Renamed project");
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");
		expect(name).toHaveValue("Renamed project");
		expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", projectId: "proj-1" });
	});

	it("leaves focus on the targeted Harness action when readiness is already cached", async () => {
		requireCodexLogin();
		const client = renderDialogs();
		act(() => {
			client.setQueryData(agentReadinessQueryKey, catalog);
			client.setQueryData(["agent-installers"], []);
			client.setQueryData(["agent-install-jobs"], []);
			client.setQueryData(agentAuthPlansQueryKey, [
				{ agentId: "codex", action: "login", available: true, launchMode: "terminal" },
			]);
			useUiStore.getState().openGlobalSettings("harness", { focusAgentId: "codex" });
		});

		const row = (await screen.findByText("Codex")).closest('[data-agent="codex"]') as HTMLElement;
		const login = await within(row).findByRole("button", { name: "Login" });
		await waitFor(() => expect(document.activeElement).toBe(login));
	});

	it("returns focus to the project selector after setup and refreshes its choices", async () => {
		requireCodexLogin();
		useUiStore.getState().openProjectSettings("proj-1");
		const client = renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Agents" }));
		const trigger = await screen.findByLabelText("Worker agent");
		await openAgentManagement("Worker agent");
		await screen.findByRole("tab", { name: "Account" });

		act(() => client.setQueryData(agentReadinessQueryKey, {
			agents: [agentReadiness("claude-code", "Claude Code"), agentReadiness("codex", "Codex")],
		}));
		await waitFor(() => expect(trigger).not.toHaveTextContent("Needs setup"));
		await userEvent.click(screen.getByRole("button", { name: "Back" }));

		await waitFor(() => expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", projectId: "proj-1", section: undefined }));
		await userEvent.click(trigger);
		expect(await screen.findByRole("menuitem", { name: /Codex/ })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument());
	});

	it("allows pointer interaction above create-project and restores its selections and intake draft on close", async () => {
		const client = renderDialogs("create-project");
		await userEvent.click(screen.getByRole("combobox", { name: "Worker agent" }));
		await userEvent.click(await screen.findByRole("option", { name: /Codex/i }));
		await userEvent.click(screen.getByLabelText("Automatically work on assigned issues"));
		await userEvent.type(screen.getByLabelText("Assignee"), "octocat");
		requireCodexLogin(client);
		await openAgentManagement("Worker agent");

		await userEvent.click(await screen.findByRole("button", { name: "All harnesses" }));
		const search = await screen.findByRole("textbox", { name: "Search harnesses" });
		await userEvent.type(search, "Claude");
		expect(search).toHaveValue("Claude");
		await userEvent.click(screen.getByRole("button", { name: "Back" }));

		expect(await screen.findByRole("combobox", { name: "Worker agent" })).toHaveTextContent("Codex");
		expect(screen.getByLabelText("Assignee")).toHaveValue("octocat");
		expect(useUiStore.getState().settingsModal).toBeNull();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument());
	});

	it("Escape dismisses recovery settings and brings the new-task dialog back", async () => {
		requireCodexLogin();
		renderDialogs("new-task");
		await openAgentManagement("Agent");
		await screen.findByRole("tab", { name: "Account" });
		await userEvent.keyboard("{Escape}");

		expect(await screen.findByRole("textbox", { name: "Task" })).toBeInTheDocument();
		expect(useUiStore.getState().settingsModal).toBeNull();
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument());
	});

	it.each(["close button", "Escape"])("keeps the real project form mounted beneath recovery and returns to its draft via %s", async (dismiss) => {
		const put = vi.spyOn(apiClient, "PUT").mockResolvedValue({ data: { status: "ok" } } as never);
		requireCodexLogin();
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Edit Project name" }));
		const name = screen.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(name);
		await userEvent.type(name, "Unsaved project name");
		await userEvent.click(screen.getByRole("button", { name: "Agents" }));
		const form = document.getElementById("project-settings-form");
		await openAgentManagement("Worker agent");
		await screen.findByRole("tab", { name: "Account" });

		expect(form).not.toBeNull();
		if (dismiss === "Escape") await userEvent.keyboard("{Escape}");
		else await userEvent.click(screen.getByRole("button", { name: "Back" }));

		expect(await screen.findByRole("button", { name: "Worker agent" })).toHaveTextContent("Codex");
		expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true");
		expect(document.getElementById("project-settings-form")).toBe(form);
		await userEvent.click(screen.getByRole("button", { name: "General" }));
		expect(await screen.findByRole("button", { name: "Edit Project name" })).toHaveTextContent("Unsaved project name");
		expect(useUiStore.getState().settingsModal).toEqual({ scope: "project", projectId: "proj-1" });
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
		await waitFor(() => expect(put).toHaveBeenCalledWith(
			"/api/v1/projects/{id}",
			expect.objectContaining({ body: expect.objectContaining({ displayName: "Unsaved project name" }) }),
		));
		await waitFor(() => expect(screen.queryByTestId("settings-page")).not.toBeInTheDocument());
	});
});


describe("Project context settings navigation guards", () => {
	it.each(["Close settings", "Escape", "Agents"])("flushes context before %s and waits for the write", async (leave) => {
		let finish!: (value: unknown) => void;
		const put = vi.spyOn(apiClient, "PUT").mockImplementation(() => new Promise((resolve) => { finish = resolve as typeof finish; }) as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		fireEvent.change(await screen.findByLabelText("Shared instructions"), { target: { value: "Draft instructions" } });
		if (leave === "Escape") await userEvent.keyboard("{Escape}");
		else await userEvent.click(screen.getByRole("button", { name: leave }));
		await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
		expect(put).toHaveBeenNthCalledWith(1, "/api/v1/projects/{id}", expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 1, instructions: expect.objectContaining({ shared: "Draft instructions" }) }) }));
		expect(useUiStore.getState().settingsModal).not.toBeNull();
		expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("data-active", "true");
		await act(async () => finish({ data: { project: { ...project, revision: 2, instructions: { ...project.instructions, shared: "Draft instructions" } } } }));
		if (leave === "Agents") await waitFor(() => expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true"));
		else await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
		expect(put).toHaveBeenCalledTimes(1);
	});

	it.each(["Close settings", "Agents"])("persists detached links before %s", async (leave) => {
		const put = vi.spyOn(apiClient, "PUT").mockResolvedValue({ data: { project: { ...project, revision: 2, instructions: { shared: "Original", attachments: [] } } } } as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Remove link notes" }));
		expect(put).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: leave }));
		await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
		expect(put).toHaveBeenNthCalledWith(1, "/api/v1/projects/{id}", expect.objectContaining({ body: expect.objectContaining({ instructions: expect.objectContaining({ attachments: [] }) }) }));
		if (leave === "Agents") await waitFor(() => expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true"));
		else await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
	});

	it.each(["Close settings", "Agents"])("waits for a pending native link selection before %s", async (leave) => {
		let choose!: (value: { localPath: string; name: string; mediaType: string }) => void;
		vi.spyOn(window.ao!.app, "chooseProjectContextLink").mockImplementation(() => new Promise((resolve) => { choose = resolve; }));
		const put = vi.spyOn(apiClient, "PUT").mockImplementation(async (_path, input) => ({ data: { project: { ...project, revision: 2, instructions: (input as { body?: { instructions?: typeof project.instructions } })?.body?.instructions } } }) as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Link a file" }));
		await userEvent.click(screen.getByRole("button", { name: leave }));
		expect(useUiStore.getState().settingsModal).not.toBeNull();
		expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("data-active", "true");
		await act(async () => choose({ localPath: "/private/reference.md", name: "Reference", mediaType: "text/markdown" }));
		await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
		expect(put).toHaveBeenNthCalledWith(1, "/api/v1/projects/{id}", expect.objectContaining({ body: expect.objectContaining({ instructions: expect.objectContaining({ attachments: expect.arrayContaining([expect.objectContaining({ localPath: "/private/reference.md" })]) }) }) }));
		if (leave === "Agents") await waitFor(() => expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true"));
		else await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
	});

	it.each(["Close settings", "Agents"])("continues %s when a pending link picker is canceled", async (leave) => {
		let choose!: (value: null) => void;
		vi.spyOn(window.ao!.app, "chooseProjectContextLink").mockImplementation(() => new Promise((resolve) => { choose = resolve; }));
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		await userEvent.click(await screen.findByRole("button", { name: "Link a file" }));
		await userEvent.click(screen.getByRole("button", { name: leave }));
		await act(async () => choose(null));
		if (leave === "Agents") await waitFor(() => expect(screen.getByRole("button", { name: "Agents" })).toHaveAttribute("data-active", "true"));
		else await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
		expect(apiClient.PUT).not.toHaveBeenCalled();
	});

	it("flushes both context and other General settings before closing", async () => {
		const put = vi.spyOn(apiClient, "PUT").mockImplementation(async (_path, input) => ({ data: { project: { ...project, revision: 2, instructions: (input as { body?: { instructions?: typeof project.instructions } })?.body?.instructions ?? project.instructions } } }) as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		fireEvent.change(await screen.findByLabelText("Shared instructions"), { target: { value: "Draft instructions" } });
		await userEvent.click(screen.getByRole("button", { name: "Edit Project name" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Renamed project" } });
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
		await waitFor(() => expect(useUiStore.getState().settingsModal).toBeNull());
		expect(put).toHaveBeenCalledTimes(2);
		expect(put).toHaveBeenNthCalledWith(1, "/api/v1/projects/{id}", expect.objectContaining({ body: expect.objectContaining({ instructions: expect.objectContaining({ shared: "Draft instructions" }) }) }));
		expect(put).toHaveBeenNthCalledWith(2, "/api/v1/projects/{id}", expect.objectContaining({ body: expect.objectContaining({ displayName: "Renamed project" }) }));
	});

	it.each(["Close settings", "Agents"])("retains conflicted drafts when attempting %s and does not submit a merge automatically", async (leave) => {
		const put = vi.spyOn(apiClient, "PUT").mockResolvedValue({ error: { code: "PROJECT_REVISION_CONFLICT", message: "Project changed" } } as never);
		useUiStore.getState().openProjectSettings("proj-1");
		const client = renderDialogs();
		fireEvent.change(await screen.findByLabelText("Shared instructions"), { target: { value: "Local draft" } });
		act(() => client.setQueryData(["project", "proj-1"], { ...project, revision: 2, instructions: { shared: "Remote" } }));
		const get = vi.mocked(apiClient.GET).getMockImplementation()! as (path: unknown, input: unknown) => Promise<unknown>;
		vi.mocked(apiClient.GET).mockImplementation(async (path, input) => path === "/api/v1/projects/{id}" ? { data: { status: "ok", project: { ...project, revision: 2, instructions: { shared: "Remote" } } } } as never : await get(path, input) as never);
		await userEvent.click(screen.getByRole("button", { name: leave }));
		await screen.findByRole("button", { name: "Merge and review draft" });
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Local draft");
		expect(useUiStore.getState().settingsModal).not.toBeNull();
		expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("data-active", "true");
		// Repeating the leave request while the conflict is already displayed
		// must not leave a close/navigation intent armed for the merged draft.
		await userEvent.click(screen.getByRole("button", { name: leave }));
		await userEvent.click(screen.getByRole("button", { name: "Merge and review draft" }));
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
		expect(put).toHaveBeenCalledTimes(1);
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Remote\n\nLocal draft");
	});

	it("reports failed context writes to the close guard without losing the draft", async () => {
		vi.spyOn(apiClient, "PUT").mockResolvedValue({ error: { message: "Context write failed" } } as never);
		useUiStore.getState().openProjectSettings("proj-1");
		renderDialogs();
		fireEvent.change(await screen.findByLabelText("Shared instructions"), { target: { value: "Draft" } });
		await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
		await screen.findAllByText("Context write failed");
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Draft");
		expect(useUiStore.getState().settingsModal).not.toBeNull();
	});
});
