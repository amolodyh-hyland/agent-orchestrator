import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MulticaViewState } from "../../shared/multica";
import { useMulticaStore } from "../stores/multica-store";
import { MulticaSidebarRailButton, MulticaSidebarRow } from "./MulticaSidebarToggle";
import { TooltipProvider } from "./ui/tooltip";

type Bridge = NonNullable<typeof window.ao>;

describe("Multica sidebar toggle", () => {
	let originalSetActive: Bridge["multica"]["setActive"];

	beforeEach(() => {
		originalSetActive = window.ao!.multica.setActive;
		window.ao!.multica.setActive = vi.fn(async (active: boolean): Promise<MulticaViewState> => ({
			active,
			status: "ready",
			url: "",
		}));
		useMulticaStore.setState({ view: { active: false, status: "ready", url: "http://localhost:3000/" } });
	});

	afterEach(() => {
		window.ao!.multica.setActive = originalSetActive;
	});

	it("switches to Multica from the expanded row and is unpressed while AO is showing", async () => {
		render(<MulticaSidebarRow className="row" />);
		const button = screen.getByRole("button", { name: "Multica" });
		expect(button).toHaveAttribute("aria-pressed", "false");

		await userEvent.click(button);

		expect(window.ao!.multica.setActive).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("shows as pressed while Multica is showing and switches back to AO on click", async () => {
		useMulticaStore.setState({ view: { active: true, status: "ready", url: "http://localhost:3000/" } });
		render(<MulticaSidebarRow className="row" />);
		const button = screen.getByRole("button", { name: "Multica" });
		expect(button).toHaveAttribute("aria-pressed", "true");

		await userEvent.click(button);

		expect(window.ao!.multica.setActive).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("offers the same switch from the collapsed rail", async () => {
		render(
			<TooltipProvider>
				<MulticaSidebarRailButton className="rail" />
			</TooltipProvider>,
		);
		const button = screen.getByRole("button", { name: "Multica" });
		expect(button).toHaveAttribute("aria-pressed", "false");

		await userEvent.click(button);

		expect(window.ao!.multica.setActive).toHaveBeenCalledExactlyOnceWith(true);
	});

	it("takes the tab order the sidebar gives it, so hidden variants are not focusable", () => {
		render(<MulticaSidebarRow className="row" tabIndex={-1} />);
		expect(screen.getByRole("button", { name: "Multica" })).toHaveAttribute("tabindex", "-1");
	});
});
