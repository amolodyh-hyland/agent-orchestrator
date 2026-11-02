import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { appI18n } from "../../i18n";
import { AgentAssetSourcesEditor } from "./AgentAssetSourcesEditor";

describe("AgentAssetSourcesEditor", () => {
	it("distinguishes inherited, disabled and explicit project sources", async () => {
		await appI18n.changeLanguage("en");
		const changed = vi.fn();
		function Editor() {
			const [value, setValue] = useState<string[] | null>(null);
			return <AgentAssetSourcesEditor project value={value} onChange={(next) => { changed(next); setValue(next); }} />;
		}
		render(<Editor />);
		const input = screen.getByRole("textbox");
		expect(input).toBeDisabled();
		fireEvent.click(screen.getByRole("switch", { name: "Use global defaults" }));
		expect(changed).toHaveBeenLastCalledWith([]);
		expect(input).toBeEnabled();
		fireEvent.change(input, { target: { value: "/live/.claude\n/live/.agents" } });
		expect(changed).toHaveBeenLastCalledWith(["/live/.claude", "/live/.agents"]);
		fireEvent.click(screen.getByRole("switch", { name: "Use global defaults" }));
		expect(changed).toHaveBeenLastCalledWith(null);
		expect(screen.getByText(/Codex Terminal and other harnesses/)).toBeInTheDocument();
	});
});
