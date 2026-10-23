import { describe, expect, it, vi } from "vitest";
import { installRunUserAction } from "./factory-run-confirmation";

describe("isolated run confirmation click", () => {
	it("rejects scripted clicks and exposes no renderer confirmation method", () => {
		const invoke = vi.fn(async () => undefined);
		installRunUserAction(document, invoke);
		const button = document.createElement("button"); button.dataset.runPreviewId = "preview"; button.dataset.runPreviewDigest = "a".repeat(64); document.body.append(button);
		button.click(); button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(invoke).not.toHaveBeenCalled(); button.remove();
	});
});
