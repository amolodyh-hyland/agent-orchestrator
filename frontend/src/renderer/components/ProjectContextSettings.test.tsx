import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../api/schema";
import { ProjectContextSettings } from "./ProjectContextSettings";

const mocks = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), choose: vi.fn() }));
vi.mock("../lib/host-clients", () => ({ clientForSessionHost: () => mocks }));
vi.mock("../lib/bridge", () => ({ aoBridge: { app: { chooseProjectContextLink: mocks.choose } } }));
const project: components["schemas"]["Project"] = { id: "research", name: "Research", kind: "scratch", path: "", repo: "", defaultBranch: "", folderMissing: false, revision: 3, instructions: { shared: "Original" } };
const onSaved = vi.fn();
const binding = { id: "Notes", sourceRef: "ref", sourceKind: "machine_local_file" as const, machineId: "other-machine", mediaType: "text/plain", position: 0, roles: ["shared" as const], required: false, enabled: true };
beforeEach(() => { vi.clearAllMocks(); });

describe("Project context settings", () => {
	it("saves scoped instructions with the revision the user edited", async () => {
		mocks.PUT.mockResolvedValue({ data: { project: { ...project, revision: 4, instructions: { shared: "Changed" } } } });
		render(<ProjectContextSettings project={project} disabled={false} onSaved={onSaved} />);
		fireEvent.change(screen.getByLabelText("Shared instructions"), { target: { value: "Changed" } });
		fireEvent.click(screen.getByRole("button", { name: "Save context" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
		expect(mocks.PUT).toHaveBeenCalledWith("/api/v1/projects/{id}", expect.objectContaining({ body: { displayName: "Research", config: {}, expectedRevision: 3, instructions: { shared: "Changed" } } }));
	});

	it("preserves a conflicting draft, merges latest guidance, and requires another save", async () => {
		mocks.PUT.mockResolvedValue({ error: { code: "PROJECT_REVISION_CONFLICT", message: "Changed" } });
		mocks.GET.mockResolvedValue({ data: { status: "ok", project: { ...project, revision: 5, instructions: { shared: "Remote", worker: "Remote worker", attachments: [binding] } } } });
		render(<ProjectContextSettings project={project} disabled={false} onSaved={onSaved} />);
		fireEvent.change(screen.getByLabelText("Shared instructions"), { target: { value: "Local" } });
		fireEvent.click(screen.getByRole("button", { name: "Save context" }));
		await screen.findByRole("button", { name: "Merge and review draft" });
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Local");
		expect(screen.getByRole("button", { name: "Save context" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Merge and review draft" }));
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Remote\n\nLocal");
		expect(screen.getByLabelText("Worker instructions")).toHaveValue("Remote worker");
		expect(screen.getByText(/other-machine/)).toBeInTheDocument();
		expect(mocks.PUT).toHaveBeenCalledTimes(1);
	});

	it("reloads the latest version only when explicitly requested", async () => {
		mocks.PUT.mockResolvedValue({ error: { code: "PROJECT_REVISION_CONFLICT" } });
		mocks.GET.mockResolvedValue({ data: { status: "ok", project: { ...project, revision: 4, instructions: { shared: "Remote" } } } });
		render(<ProjectContextSettings project={project} disabled={false} onSaved={onSaved} />);
		fireEvent.change(screen.getByLabelText("Shared instructions"), { target: { value: "Local" } });
		fireEvent.click(screen.getByRole("button", { name: "Save context" }));
		fireEvent.click(await screen.findByRole("button", { name: "Reload latest" }));
		expect(screen.getByLabelText("Shared instructions")).toHaveValue("Remote");
	});

	it.each(["file", "folder"] as const)("registers a %s link with a write-only locator, without uploading or launching", async (kind) => {
		mocks.choose.mockResolvedValue({ localPath: "/private/notes", name: "Notes", mediaType: kind === "folder" ? "inode/directory" : "text/plain" });
		mocks.GET.mockResolvedValue({ data: { hostId: "this-machine" } });
		mocks.PUT.mockResolvedValue({ data: { project: { ...project, revision: 4, instructions: { attachments: [binding] } } } });
		render(<ProjectContextSettings project={project} disabled={false} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: kind === "folder" ? "Link a folder" : "Link a file" }));
		await screen.findByText(/this-machine/);
		fireEvent.click(screen.getByRole("switch", { name: /^Required:/ }));
		fireEvent.click(screen.getByRole("button", { name: "Save context" }));
		await waitFor(() => expect(mocks.PUT).toHaveBeenCalled());
		expect(mocks.PUT.mock.calls[0][1].body.instructions.attachments[0]).toMatchObject({ localPath: "/private/notes", machineId: "this-machine", required: true, sourceKind: "machine_local_file", enabled: true });
		expect(mocks.GET).toHaveBeenCalledWith("/api/v1/identity");
	});

	it("appends links after existing positions even when earlier references were detached", async () => {
		mocks.choose.mockResolvedValue({ localPath: "/private/new.txt", name: "New", mediaType: "text/plain" });
		mocks.GET.mockResolvedValue({ data: { hostId: "this-machine" } });
		mocks.PUT.mockResolvedValue({ data: { project: { ...project, revision: 4 } } });
		render(<ProjectContextSettings project={{ ...project, instructions: { attachments: [{ ...binding, position: 10 }] } }} disabled={false} onSaved={onSaved} />);
		fireEvent.click(screen.getByRole("button", { name: "Link a file" }));
		await screen.findByText(/this-machine/);
		fireEvent.click(screen.getByRole("button", { name: "Save context" }));
		await waitFor(() => expect(mocks.PUT).toHaveBeenCalled());
		expect(mocks.PUT.mock.calls[0][1].body.instructions.attachments.map((item: { position: number }) => item.position)).toEqual([10, 11]);
	});

	it("detaches references without deleting sources and prevents local picking for remote projects", () => {
		render(<ProjectContextSettings project={{ ...project, instructions: { attachments: [binding] } }} hostId="remote" disabled={false} onSaved={onSaved} />);
		expect(screen.getByRole("button", { name: "Link a file" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Remove link Notes" }));
		expect(screen.queryByText(/other-machine/)).not.toBeInTheDocument();
		expect(mocks.PUT).not.toHaveBeenCalled();
		expect(mocks.choose).not.toHaveBeenCalled();
	});
});
