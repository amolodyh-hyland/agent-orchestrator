import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useUiStore } from "../../stores/ui-store";
import { CodeSettingsRows } from "./CodeSettingsRows";

afterEach(() => {
	useUiStore.setState({ defaultCodeBlockLanguage: "none", defaultInlineCodeLanguage: "none", codeColorTheme: "app" });
	localStorage.clear();
});

it("searches supported languages and saves independent block, inline and palette preferences", async () => {
	const user = userEvent.setup();
	render(<CodeSettingsRows />);
	await user.click(screen.getByRole("button", { name: "Default code block language" }));
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "typescript" } });
	await user.click(screen.getByRole("menuitem", { name: "typescript" }));
	expect(useUiStore.getState().defaultCodeBlockLanguage).toBe("typescript");
	expect(localStorage.getItem("ao.defaultCodeBlockLanguage")).toBe("typescript");
	await user.click(screen.getByRole("button", { name: "Default inline code language" }));
	await user.click(screen.getByRole("menuitem", { name: "python" }));
	expect(localStorage.getItem("ao.defaultInlineCodeLanguage")).toBe("python");
	await user.click(screen.getByRole("button", { name: "Code color theme" }));
	await user.click(screen.getByRole("menuitem", { name: "Nord" }));
	expect(localStorage.getItem("ao.codeColorTheme")).toBe("nord");
	act(() => useUiStore.getState().setDefaultInlineCodeLanguage("none"));
	expect(screen.getByRole("button", { name: "Default inline code language" })).toHaveTextContent("None (plain)");
});
