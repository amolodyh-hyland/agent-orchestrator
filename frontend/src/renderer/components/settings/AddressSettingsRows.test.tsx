import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { useUiStore } from "../../stores/ui-store";
import { AddressSettingsRows } from "./AddressSettingsRows";

afterEach(() => {
	act(() => useUiStore.setState({ chatUrlDisplay: "full", chatPathDisplay: "full" }));
	localStorage.removeItem("ao.chatUrlDisplay");
	localStorage.removeItem("ao.chatPathDisplay");
});

it("offers separate discoverable link/path defaults and persists each without changing code preferences", async () => {
	const codeBefore = useUiStore.getState().codeColorTheme;
	render(<AddressSettingsRows />);
	expect(screen.getByRole("button", { name: "HTTP links" })).toHaveTextContent("Full address");
	await userEvent.click(screen.getByRole("button", { name: "HTTP links" }));
	await userEvent.click(screen.getByRole("menuitem", { name: "Title or name" }));
	expect(localStorage.getItem("ao.chatUrlDisplay")).toBe("compact");
	expect(useUiStore.getState().chatPathDisplay).toBe("full");
	await userEvent.click(screen.getByRole("button", { name: "File and folder paths" }));
	await userEvent.click(screen.getByRole("menuitem", { name: "Title or name" }));
	expect(localStorage.getItem("ao.chatPathDisplay")).toBe("compact");
	expect(useUiStore.getState().codeColorTheme).toBe(codeBefore);
});
