import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { CreateContextProjectDialog } from "./CreateContextProjectDialog";
const mocks = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock("../lib/api-client", async (original) => ({ ...await original<object>(), apiClient: mocks }));

describe("Create a context project", () => {
	it("creates a durable project with no repository, Git setup, or implicit session", async () => {
		mocks.POST.mockResolvedValue({ data: { project: { id: "research" } } });
		const created = vi.fn();
		render(<QueryClientProvider client={new QueryClient()}><CreateContextProjectDialog onClose={vi.fn()} onCreated={created} /></QueryClientProvider>);
		fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: " Research " } });
		fireEvent.click(screen.getByRole("button", { name: "Create a project without a repository" }));
		await waitFor(() => expect(created).toHaveBeenCalledWith("research"));
		expect(mocks.POST).toHaveBeenCalledExactlyOnceWith("/api/v1/projects/containers", { body: { displayName: "Research" } });
	});
});
