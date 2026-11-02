import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTopbarHost, SessionTopbarPortal, SessionTopbarProvider } from "./SessionTopbarPortal";

describe("SessionTopbarPortal", () => {
	it("renders session chrome in the shell-owned host", () => {
		render(
			<SessionTopbarProvider>
				<SessionTopbarHost data-testid="session-topbar-host" />
				<SessionTopbarPortal>
					<span>terminal tabs</span>
				</SessionTopbarPortal>
			</SessionTopbarProvider>,
		);

		const host = screen.getByTestId("session-topbar-host");
		expect(host.classList.contains("workspace-topbar-container")).toBe(true);
		expect(within(host).getByText("terminal tabs")).not.toBeNull();
	});

	it("keeps the host attached while its owning session rerenders", () => {
		function Session() {
			const [count, setCount] = useState(0);
			return <><SessionTopbarHost data-testid="host" /><SessionTopbarPortal><span>{count}</span></SessionTopbarPortal><button onClick={() => setCount((value) => value + 1)}>update session</button></>;
		}
		render(<SessionTopbarProvider><Session /></SessionTopbarProvider>);
		const host = screen.getByTestId("host");
		fireEvent.click(screen.getByRole("button", { name: "update session" }));
		expect(screen.getByTestId("host")).toBe(host);
		expect(within(host).getByText("1")).toBeInTheDocument();
	});

	it("renders inline when a component test has no shell provider", () => {
		render(
			<SessionTopbarPortal>
				<span>terminal tabs</span>
			</SessionTopbarPortal>,
		);

		expect(screen.getByText("terminal tabs")).toBeInTheDocument();
	});
});
