import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { components } from "../../api/schema";
import { LibrarySettings } from "./LibrarySettings";

const mocks = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), host: vi.fn() }));
vi.mock("../lib/host-clients", () => ({ clientForSessionHost: (host?: string) => { mocks.host(host); return mocks; } }));
const rootIdentity = { resolverId: "resolver-one", rootRef: "root-one", rootGeneration: 1 };
const entry: components["schemas"]["LibraryEntry"] = {
	schemaVersion: 1, entryId: "entry-one", sourceId: "source-one", kind: "skill", format: "skill-v1", displayName: "Review", entryPoint: "review/SKILL.md",
	files: [{ path: "review/SKILL.md", sizeBytes: 13, sha256: "file-hash", mode: "text" }], contentHash: "content-hash",
	provenance: { originAuthorityId: "authority", originSourceId: "source-one", originEntryId: "entry-one", originKind: "machine_local", resolverId: "resolver-one", sourceRevision: 2, adapterVersion: "v1", verification: "observed" },
	requirements: [], status: "unsupported_provider", reasonCode: "version_evidence_required",
};
const catalog: components["schemas"]["LibraryResult"] = {
	status: "ok", reasonCode: "", revision: 3, trustEpoch: 1, warnings: [], bindings: [], runtimeBindings: [],
	sources: [{ sourceId: "source-one", scope: "personal", ownerId: "local_user", ...rootIdentity, revision: 2, inspectionState: "inspection_allowed", originKind: "machine_local", detached: false }],
	entries: [entry], approvals: [],
};
function setup() {
	const queryClient = new QueryClient();
	return render(<LibrarySettings projectId="no-repo-project" disabled={false} />, { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
}
beforeEach(() => { vi.clearAllMocks(); mocks.GET.mockResolvedValue({ data: catalog }); });

it("inspects only after confirmation and approves the exact preview with no managed-policy prerequisite", async () => {
	mocks.POST.mockResolvedValueOnce({ data: { ...catalog, revision: 4, preview: [{ entry, rootIdentity, present: true, content: { "review/SKILL.md": "Exact bytes.\n" } }] } })
		.mockResolvedValueOnce({ data: { ...catalog, revision: 5 } });
	setup();
	expect(mocks.GET).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Review library sources" }));
	fireEvent.click(await screen.findByRole("button", { name: "Inspect files" }));
	expect(mocks.POST).not.toHaveBeenCalled();
	expect(screen.getByRole("region", { name: "Review exact selection" })).toHaveTextContent("root-one");
	fireEvent.click(screen.getByRole("button", { name: "Confirm selection" }));
	await screen.findByText("Exact bytes.");
	fireEvent.click(screen.getByRole("button", { name: "Approve exact revision" }));
	const review = screen.getByRole("region", { name: "Review exact selection" });
	expect(review).toHaveTextContent("content-hash");
	expect(review).toHaveTextContent("materialize_skill");
	expect(review).toHaveTextContent("no-repo-project");
	fireEvent.click(within(review).getByRole("button", { name: "Confirm selection" }));
	await waitFor(() => expect(mocks.POST).toHaveBeenCalledTimes(2));
	expect(mocks.POST.mock.calls[1]?.[1].body).toEqual({ operation: "approve", sourceId: "source-one", rootIdentity, entries: [{ entryId: "entry-one", contentHash: "content-hash" }], purposes: ["materialize_skill"], expectedRevision: 4 });
});

it("reviews the exact Project binding and surfaces a managed lock refusal", async () => {
	mocks.POST.mockResolvedValue({ error: { code: "LIBRARY_UNAVAILABLE", message: "managed_lock" } });
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Review library sources" }));
	fireEvent.click(await screen.findByRole("button", { name: "Bind revision to project chat" }));
	const review = screen.getByRole("region", { name: "Review exact selection" });
	expect(review).toHaveTextContent("no-repo-project");
	expect(review).toHaveTextContent("content-hash");
	fireEvent.click(within(review).getByRole("button", { name: "Confirm selection" }));
	await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("managed_lock"));
	expect(mocks.POST.mock.calls[0]?.[1].body.binding).toMatchObject({ ownerId: "local_user", projectId: "no-repo-project", entryId: "entry-one", approvedContentHash: "content-hash", roles: ["chat"] });
});

it("discards a pending review when the destination changes", async () => {
	const view = setup();
	fireEvent.click(screen.getByRole("button", { name: "Review library sources" }));
	fireEvent.click(await screen.findByRole("button", { name: "Bind revision to project chat" }));
	expect(screen.getByRole("region", { name: "Review exact selection" })).toBeInTheDocument();
	view.rerender(<LibrarySettings projectId="different-project" hostId="different-host" disabled={false} />);
	expect(screen.queryByRole("region", { name: "Review exact selection" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Confirm selection" })).toBeNull();
	expect(mocks.POST).not.toHaveBeenCalled();
});

it("reviews revocation separately from Project binding", async () => {
	mocks.GET.mockResolvedValue({ data: { ...catalog, approvals: [{ approvalId: "approval-one", state: "approved", policyRevision: "absent" }] } });
	mocks.POST.mockResolvedValue({ data: { ...catalog, revision: 4, trustEpoch: 2 } });
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Review library sources" }));
	fireEvent.click(await screen.findByRole("button", { name: "Revoke approval" }));
	expect(mocks.POST).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Confirm selection" }));
	await waitFor(() => expect(mocks.POST).toHaveBeenCalledWith("/api/v1/library/operations", { body: { operation: "revoke", approvalId: "approval-one", expectedRevision: 3 } }));
});

it.each(["content-hash", "new-content-hash"])("updates the existing binding without allocating another ID for %s", async (hash) => {
	const binding = { bindingId: "existing-binding", projectId: "no-repo-project", sourceId: "source-one", entryId: "entry-one", ownerId: "local_user", approvedContentHash: "content-hash", roles: ["chat"], position: 9, required: false, enabled: false, revision: 4 };
	mocks.GET.mockResolvedValue({ data: { ...catalog, entries: [{ ...entry, contentHash: hash }], bindings: [binding] } });
	mocks.POST.mockResolvedValue({ data: { ...catalog, bindings: [{ ...binding, enabled: true, approvedContentHash: hash, revision: 5 }], revision: 4 } });
	setup();
	fireEvent.click(screen.getByRole("button", { name: "Review library sources" }));
	expect(await screen.findByText(/Current binding: existing-binding/)).toHaveTextContent("Disabled");
	fireEvent.click(screen.getByRole("button", { name: "Bind revision to project chat" }));
	fireEvent.click(screen.getByRole("button", { name: "Confirm selection" }));
	await waitFor(() => expect(mocks.POST).toHaveBeenCalledOnce());
	expect(mocks.POST.mock.calls[0]?.[1].body.binding).toMatchObject({ ...binding, enabled: true, approvedContentHash: hash });
	expect(await screen.findByText(/Current binding: existing-binding/)).toHaveTextContent("Enabled");
});
