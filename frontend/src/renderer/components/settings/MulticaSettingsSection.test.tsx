import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MulticaSettingsSection } from "./MulticaSettingsSection";

type Bridge = NonNullable<typeof window.ao>;

describe("MulticaSettingsSection", () => {
	let original: Bridge["multica"];

	beforeEach(() => {
		original = { ...window.ao!.multica };
		window.ao!.multica.getSettings = vi.fn(async () => ({ url: "http://localhost:3000/" }));
		window.ao!.multica.setSettings = vi.fn(async (url: string) => ({
			url: url && !/^https?:\/\//.test(url) ? `http://${url}/` : url,
		}));
	});

	afterEach(() => {
		Object.assign(window.ao!.multica, original);
	});

	async function startEditing() {
		render(<MulticaSettingsSection />);
		await screen.findByText("http://localhost:3000/");
		await userEvent.click(screen.getByRole("button", { name: "Edit Multica URL" }));
		const input = screen.getByRole("textbox", { name: "Multica URL" });
		await userEvent.clear(input);
		return input;
	}

	it("shows the saved URL under a Multica heading", async () => {
		render(<MulticaSettingsSection />);

		expect(await screen.findByText("http://localhost:3000/")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Multica" })).toBeInTheDocument();
	});

	it("saves an edited URL and shows the normalized value", async () => {
		const input = await startEditing();

		await userEvent.type(input, "multica.example.com:8443{Enter}");

		await waitFor(() => expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith("multica.example.com:8443"));
		expect(await screen.findByText("http://multica.example.com:8443/")).toBeInTheDocument();
	});

	it("turns Multica off when the URL is cleared", async () => {
		const input = await startEditing();

		await userEvent.type(input, "{Enter}");

		await waitFor(() => expect(window.ao!.multica.setSettings).toHaveBeenCalledExactlyOnceWith(""));
		expect(await screen.findByText("Not set")).toBeInTheDocument();
	});

	it("rejects an invalid URL without saving it", async () => {
		const input = await startEditing();

		await userEvent.type(input, "ftp://example.com{Enter}");

		expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid http:// or https:// address.");
		expect(window.ao!.multica.setSettings).not.toHaveBeenCalled();
	});

	it("reports a failed save", async () => {
		window.ao!.multica.setSettings = vi.fn(async () => {
			throw new Error("disk full");
		});
		const input = await startEditing();

		await userEvent.type(input, "http://localhost:3100{Enter}");

		expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the Multica URL.");
	});

	it("restores the saved URL when editing is cancelled", async () => {
		const input = await startEditing();

		await userEvent.type(input, "http://elsewhere.test{Escape}");

		expect(await screen.findByText("http://localhost:3000/")).toBeInTheDocument();
		expect(window.ao!.multica.setSettings).not.toHaveBeenCalled();
	});
});
