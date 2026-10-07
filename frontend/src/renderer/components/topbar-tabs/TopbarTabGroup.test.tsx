import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../ui/tooltip";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { EMPTY_TOPBAR_TABS } from "../../lib/topbar-tabs";
import { TopbarTabGroup } from "./TopbarTabGroup";
import type { TopbarGroupView, TopbarTabView } from "./topbar-tabs-view";

function makeView(overrides: Partial<TopbarTabView>): TopbarTabView {
	return {
		key: "task-1",
		sessionId: "task-1",
		role: "task",
		groupId: "project-1",
		mode: "persistent",
		label: "Task One",
		isActive: false,
		isAnchor: false,
		...overrides,
	};
}

function makeGroup(overrides: Partial<TopbarGroupView> = {}): TopbarGroupView {
	return {
		id: "project-1",
		name: "Project One",
		isStandalone: false,
		collapsed: false,
		head: makeView({
			key: "anchor:project-1",
			sessionId: null,
			role: "head",
			label: "Project One",
			isAnchor: true,
		}),
		tabs: [makeView({})],
		hiddenCount: 0,
		...overrides,
	};
}

function renderGroup(group: TopbarGroupView) {
	return render(
		<TooltipProvider>
			<div role="tablist">
				<TopbarTabGroup
					group={group}
					density="comfortable"
					hasActiveTab={false}
					firstTabKey={group.head?.key}
					onActivate={vi.fn()}
					onPersist={vi.fn()}
					onClose={vi.fn()}
				/>
			</div>
		</TooltipProvider>,
	);
}

beforeEach(() => {
	useTopbarTabsStore.setState({ tabs: EMPTY_TOPBAR_TABS, overflow: "scroll" });
});

describe("TopbarTabGroup", () => {
	it("renders a project head before its tabs", () => {
		renderGroup(makeGroup());

		const group = screen.getByTestId("topbar-tab-group");
		const tabs = within(group).getAllByRole("tab");
		expect(tabs).toHaveLength(2);
		expect(tabs[0]).toHaveTextContent("Project One");
		expect(tabs[1]).toHaveTextContent("Task One");
	});

	it("passes one accent to every tab in the group", () => {
		render(
			<TooltipProvider>
				<div role="tablist">
					<TopbarTabGroup
						group={makeGroup()}
						density="comfortable"
						hasActiveTab={false}
						firstTabKey="anchor:project-1"
						accent="oklch(0.56 0.15 20)"
						onActivate={vi.fn()}
						onPersist={vi.fn()}
						onClose={vi.fn()}
					/>
				</div>
			</TooltipProvider>,
		);

		const wrappers = screen.getAllByTestId("topbar-tab");
		expect(wrappers).toHaveLength(2);
		for (const wrapper of wrappers) {
			expect(wrapper).toHaveAttribute("data-accent", "true");
			expect(wrapper.style.getPropertyValue("--project-accent")).toBe("oklch(0.56 0.15 20)");
		}
	});

	it("hides collapsed tabs and displays their count on the head", () => {
		renderGroup(makeGroup({ collapsed: true, hiddenCount: 1 }));

		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(screen.getByText("+1")).toBeInTheDocument();
		expect(screen.queryByText("Task One")).not.toBeInTheDocument();
	});

	it("renders standalone tabs without a head", () => {
		const scratchpad = makeView({
			key: "scratch-1",
			sessionId: "scratch-1",
			role: "scratch",
			groupId: "__standalone__",
			label: "Scratch task",
		});
		renderGroup(makeGroup({
			id: "__standalone__",
			name: "Scratchpad",
			isStandalone: true,
			head: null,
			tabs: [scratchpad],
		}));

		expect(screen.getAllByRole("tab")).toHaveLength(1);
		expect(screen.getByRole("tab")).toHaveTextContent("Scratch task");
		expect(screen.queryByText("Scratchpad")).not.toBeInTheDocument();
	});

});
