import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../../hooks/useSettings";

const { settingsMock, updateRetentionMock, updateAssetsMock } = vi.hoisted(() => ({
	settingsMock: vi.fn(),
	updateRetentionMock: vi.fn(),
	updateAssetsMock: vi.fn(),
}));

const idle = { update: vi.fn(), saving: false, error: undefined };
vi.mock("../../hooks/useSettings", () => ({
	useSettings: () => ({ settings: settingsMock(), isLoading: false, error: null }),
	useUpdateSessionInterface: () => idle,
	useUpdateVersionRefresh: () => idle,
	useUpdateAgentAssetSources: () => ({ mutate: updateAssetsMock, isPending: false, error: undefined }),
	useUpdateSessionRetention: () => ({ update: updateRetentionMock, saving: false, error: undefined }),
}));

vi.mock("../../hooks/useEditorHandoff", () => ({
	useEditorPreference: () => ({ data: { editors: [] }, isPending: false, isError: false }),
	useSetPreferredEditor: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

// The real rows read the cloud gate and the CLI link; this file covers retention.
vi.mock("./DefaultCloudSandboxRow", () => ({ DefaultCloudSandboxSection: () => null }));
vi.mock("./CliLinkSettingsRow", () => ({ CliLinkSettings: () => null }));

import { GeneralSettingsSection } from "./GeneralSettingsSection";
import { TooltipProvider } from "../ui/tooltip";

function renderSection() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<GeneralSettingsSection />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

function settings(overrides: Partial<Settings>): Settings {
	return {
		defaultSessionMode: "tui",
		harnessDefaults: {},
		chatHarnesses: [],
		client: "",
		localEnabled: true,
		cloudEnabled: false,
		cloudControlPlaneUrl: "",
		trackerIntakeEnabled: false,
		...overrides,
	};
}

beforeEach(() => {
	settingsMock.mockReset();
	updateRetentionMock.mockReset();
	updateAssetsMock.mockReset();
});

describe("archived session retention", () => {
	it("saves the chosen number of days", async () => {
		settingsMock.mockReturnValue(settings({ sessionRetentionDays: 0 }));
		renderSection();

		const menu = screen.getByRole("button", { name: "Delete archived sessions" });
		expect(menu).toHaveTextContent("Never");
		await userEvent.click(menu);
		await userEvent.click(await screen.findByRole("menuitem", { name: "After 30 days" }));

		expect(updateRetentionMock).toHaveBeenCalledWith(30);
	});

	it("shows a value set outside the menu as itself", () => {
		settingsMock.mockReturnValue(settings({ sessionRetentionDays: 14 }));
		renderSection();

		expect(screen.getByRole("button", { name: "Delete archived sessions" })).toHaveTextContent("After 14 days");
	});

	it("hides the control on a daemon that cannot apply it", () => {
		settingsMock.mockReturnValue(settings({}));
		renderSection();

		expect(screen.queryByRole("button", { name: "Delete archived sessions" })).not.toBeInTheDocument();
	});
});

it("edits agent sources beside retention without changing the retention preference", async () => {
	settingsMock.mockReturnValue(settings({ sessionRetentionDays: 14, agentAssetSources: ["/original/.agents"] }));
	renderSection();
	const input = screen.getByRole("textbox", { name: "Source directories (one per line)" });
	expect(input).toHaveValue("/original/.agents");
	fireEvent.change(input, { target: { value: "/live/.claude\n/live/.agents" } });
	await userEvent.click(within(input.closest("section")!).getByRole("button", { name: "Save" }));
	expect(updateAssetsMock).toHaveBeenCalledWith(["/live/.claude", "/live/.agents"], expect.any(Object));
	expect(screen.getByRole("button", { name: "Delete archived sessions" })).toHaveTextContent("After 14 days");
	expect(updateRetentionMock).not.toHaveBeenCalled();
});
