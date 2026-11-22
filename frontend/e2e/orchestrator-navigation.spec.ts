import { expect, test } from "@playwright/test";
import { installFakeAgent, type FakeAgentController } from "./support/fake-bridge";

const orchestrator = "fake-proj-orchestrator";
const now = "2026-11-19T12:00:00Z";
const message = (id: string, sequence: number, origin: string, text: string) => ({ id, sequence, kind: "message", role: origin === "provider" ? "assistant" : "user", origin, text, revision: 1, streaming: false, createdAt: now, turnId: `turn-${id}` });
const oldPrompt = message("old-human", 1, "human", "Earlier human request 😀");
const current = [
	message("human", 5, "human", "Please inspect the worker output."),
	message("automation", 6, "automation", "WORKER_REPORT_NOT_A_HUMAN_PROMPT"),
	message("reply", 7, "provider", "[Worker report](ao://sessions/fake-proj/worker/artifacts/plan.html) and [Worker session](ao://sessions/fake-proj/worker).\n\n" + Array.from({ length: 24 }, (_, index) => `Completed progress ${index + 1}: the worker prepared its preview and left the orchestrator conversation available for the next human request.`).join("\n\n")),
];

test("orchestrator borrows owner previews and navigates human prompts without losing its draft", async ({ page }) => {
	const renderErrors: string[] = [];
	page.on("console", (message) => { if (message.type() === "error" && message.text().includes("Cannot update a component")) renderErrors.push(message.text()); });
	await page.route("**/*", (route) => {
		const target = new URL(route.request().url());
		return ["127.0.0.1", "localhost"].includes(target.hostname) ? route.fallback() : route.abort("blockedbyclient");
	});
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await installFakeAgent(page, { workers: [{ id: "worker", title: "Preview owner", mode: "chat", previewUrl: "http://fixture.invalid/preview", previewRevision: 1 }] });
	let olderLoads = 0;
	await page.route("**/api/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname.endsWith("/conversation")) {
			const requestedSession = decodeURIComponent(url.pathname.match(/\/sessions\/([^/]+)\/conversation$/)?.[1] ?? orchestrator);
			const messageLookup = url.searchParams.has("afterSequence") || url.searchParams.get("limit") === "1";
			const older = requestedSession === orchestrator && url.searchParams.has("beforeSequence") && !messageLookup;
			if (older) olderLoads++;
			const messages = requestedSession !== orchestrator ? [] : messageLookup
				? [oldPrompt, ...current].filter((item) => item.sequence < Number(url.searchParams.get("beforeSequence") ?? Infinity) && item.sequence > Number(url.searchParams.get("afterSequence") ?? -1))
				: older ? [oldPrompt] : current;
			await route.fulfill({ json: {
				conversationId: `conversation-${requestedSession}`, sessionId: requestedSession, harness: "codex", mode: "chat", controller: "ready", latestSequence: requestedSession === orchestrator ? 7 : 0,
				oldestSequence: messages[0]?.sequence ?? 0, hasMoreBefore: requestedSession === orchestrator && !older && !messageLookup,
				messages, activities: [], settings: {}, turns: messages.map((item) => ({ id: item.turnId, state: "completed", requestedAt: now, completedAt: now })),
			} });
		} else if (url.pathname.endsWith("/conversation/models")) await route.fulfill({ json: { models: [], selected: {} } });
		else if (url.pathname.endsWith("/conversation/skills")) await route.fulfill({ json: { skills: [] } });
		else if (url.pathname.endsWith("/workspace/files")) await route.fulfill({ json: { files: [], truncated: false } });
		else await route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "fixture endpoint" } } });
	});
	await page.route("**/fixture-plan*.html**", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><h1>${route.request().url().includes("alternate") ? "Alternate plan" : "Worker plan"}</h1><p>Safe fixture preview</p>` }));
	await page.goto("/");
	await page.evaluate(() => {
		const controller = (window as unknown as { __aoFakeAgent: FakeAgentController }).__aoFakeAgent;
		const snapshot = controller.snapshot;
		controller.snapshot = () => {
			const workspaces = snapshot() as Array<{ sessions: Array<Record<string, unknown>> }>;
			for (const workspace of workspaces) for (const session of workspace.sessions) {
				if (session.id === "fake-proj-orchestrator") session.mode = "chat";
				if (session.id === "worker") session.artifactFiles = ["plan", "alternate"].map((name) => ({ kind: "html", name: `${name}.html`, path: `${name}.html`, size: 64, updatedAt: "2026-11-19T12:00:00Z", previewUrl: `${location.origin}/fixture-plan-${name}.html`, inlineUrl: `http://ao-inline-artifact.worker.localhost/fixture-plan-${name}.html`, rawUrl: `${location.origin}/api/v1/sessions/worker/artifact-files/${name}.html?raw=true` }));
			}
			return workspaces;
		};
		controller.setStatus("worker", "working");
		location.hash = "/projects/fake-proj/sessions/fake-proj-orchestrator";
	});
	const prompts = page.getByRole("button", { name: "Your prompts" });
	await expect(prompts).toBeVisible();
	const draft = page.getByLabel("Message the agent");
	await draft.fill("Unsent orchestrator draft");
	await prompts.click();
	const dialog = page.getByRole("dialog", { name: "Your prompts" });
	await expect(dialog.getByRole("button", { name: current[0].text })).toBeVisible();
	await expect(dialog).not.toContainText("WORKER_REPORT_NOT_A_HUMAN_PROMPT");
	await dialog.getByRole("button", { name: "Load older prompts" }).click();
	await expect(dialog.getByRole("button", { name: oldPrompt.text })).toBeVisible();
	expect(olderLoads).toBe(1);
	await dialog.getByRole("button", { name: oldPrompt.text }).click();
	await expect.poll(() => page.evaluate(() => {
		const registry = (window as unknown as { CSS: { highlights: Map<string, Set<Range>> } }).CSS.highlights;
		return Array.from(registry.get("chat-annotation") ?? [], (range) => range.toString()).join("");
	})).toBe(oldPrompt.text);
	await expect(page.locator('[data-chat-message-id="old-human"] [data-chat-message-body]')).toBeInViewport();
	await expect(draft).toHaveText("Unsent orchestrator draft");
	await expect(page).toHaveURL(new RegExp(`sessions/${orchestrator}$`));
	await page.getByRole("link", { name: "Worker report", exact: true }).click();
	const preview = page.getByRole("region", { name: "Session preview" });
	await expect(preview.getByText("Preview owner", { exact: true })).toBeVisible();
	await expect(page.frameLocator('iframe[title="plan.html"]').getByRole("heading", { name: "Worker plan" })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`sessions/${orchestrator}$`));
	await expect(draft).toHaveText("Unsent orchestrator draft");
	if (process.env.AO_NAV_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AO_NAV_EVIDENCE_DIR}/owner-preview.png` });
	await preview.getByRole("button", { name: "Back to artifacts" }).click();
	await preview.getByText("alternate.html", { exact: true }).click();
	await expect(page.frameLocator('iframe[title="alternate.html"]').getByRole("heading", { name: "Alternate plan" })).toBeVisible();
	await page.evaluate(() => (window as unknown as { __aoFakeAgent: FakeAgentController }).__aoFakeAgent.setStatus("worker", "idle"));
	await expect(preview.getByText("alternate.html", { exact: true })).toBeVisible();
	await expect(page.frameLocator('iframe[title="alternate.html"]').getByRole("heading", { name: "Alternate plan" })).toBeVisible();
	await preview.getByRole("button", { name: "Close session preview" }).click();
	await page.getByRole("link", { name: "Worker session", exact: true }).click({ button: "right" });
	await page.getByRole("menuitem", { name: "Open preview here" }).click();
	await expect(preview.getByText("Preview owner", { exact: true })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`sessions/${orchestrator}$`));
	await preview.getByRole("button", { name: "Close session preview" }).click();
	await prompts.click();
	await dialog.getByRole("button", { name: oldPrompt.text }).focus();
	await page.keyboard.press("ArrowUp");
	await expect(dialog.getByRole("button", { name: current[0].text })).toBeFocused();
	if (process.env.AO_NAV_EVIDENCE_DIR) await page.screenshot({ path: `${process.env.AO_NAV_EVIDENCE_DIR}/your-prompts.png` });
	await page.keyboard.press("Escape");
	await expect(prompts).toBeFocused();
	await page.getByRole("link", { name: "Worker report", exact: true }).click();
	await preview.getByRole("button", { name: "Go to session" }).click();
	await expect(page).toHaveURL(/sessions\/worker$/);
	await expect(page.getByRole("button", { name: "Your prompts" })).toHaveCount(0);
	expect(renderErrors).toEqual([]);
});
