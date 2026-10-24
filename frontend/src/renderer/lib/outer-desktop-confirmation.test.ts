import { afterEach, expect, it, vi } from "vitest";
import {
	outerDesktopRequest,
	outerDesktopRoutes,
	validOuterDesktopRequest,
} from "../../shared/outer-desktop";
import {
	confirmHeldDesktopRequest,
	desktopConfirmations,
	desktopConfirmationPreview,
	desktopControlReceipt,
	prepareDesktopConfirmation,
	subscribeDesktopConfirmations,
} from "./outer-desktop-confirmation";

const held = () => Response.json({ code: "OUTER_HELD" }, { status: 409 });
const draft = () =>
	outerDesktopRequest(
		"PUT",
		new URL("http://127.0.0.1/api/v1/projects/a"),
		{ displayName: "Exact name" },
		false
	)!;

it("masks credentials in the preview while keeping the exact staged bytes", () => {
	const request = {
		...draft(),
		query: "refreshToken=query-secret",
		payload: {
			pat: "pat-secret",
			config: { env: { API_KEY: "env-secret" } },
			displayName: "Visible name",
		},
	};
	const preview = desktopConfirmationPreview(request, "[private]");
	expect(preview).toContain("Visible name");
	expect(preview).not.toContain("pat-secret");
	expect(preview).not.toContain("query-secret");
	expect(preview).not.toContain("env-secret");
	expect(request.payload.pat).toBe("pat-secret");
});
afterEach(() => {
	for (const entry of [...desktopConfirmations()]) entry.finish();
	vi.useRealTimers();
});

it("covers each finite supported route without accepting methods, traversal or held interfaces", () => {
	for (const [route, spec] of Object.entries(outerDesktopRoutes)) {
		const [method, path] = route.split(" ");
		const url = new URL(
			"http://127.0.0.1" + path.replace(/\{[^}]+\}/g, "actual-id")
		);
		const request = outerDesktopRequest(
			method,
			url,
			{ projectId: "untrusted-body-claim" },
			false
		);
		if (spec.mode === "held") expect(request).toBeUndefined();
		else {
			expect(request?.route).toBe(route);
			expect(validOuterDesktopRequest(request)).toBe(true);
			expect(outerDesktopRequest("GET", url, {}, false)).toBeUndefined();
		}
	}
	expect(validOuterDesktopRequest({ ...draft(), parameters: ["a/b"] })).toBe(
		false
	);
	expect(
		validOuterDesktopRequest({
			...draft(),
			headers: { "X-AO-Delegation-MAC": "claim" },
		})
	).toBe(false);
});

it("freezes request bytes and never forwards caller credentials or arbitrary headers", async () => {
	const payload = { displayName: "Exact name", config: {} };
	const request = new Request("http://127.0.0.1/api/v1/projects/a", {
		method: "PUT",
		body: JSON.stringify(payload),
		headers: { "X-Arbitrary": "ignored" },
	});
	const staged = await prepareDesktopConfirmation(request);
	payload.displayName = "Altered";
	expect(staged?.payload).toMatchObject({ displayName: "Exact name" });
	expect(staged).not.toHaveProperty("headers");
	request.headers.set("X-AO-Scope-Credential", "claimed-caller");
	expect(await prepareDesktopConfirmation(request)).toBeUndefined();
});

it("queues inert data only after the router hold and returns only an exact native HTTP receipt", async () => {
	const unsubscribe = subscribeDesktopConfirmations(() => {});
	try {
		const request = draft(),
			signal = new AbortController().signal;
		const original = held();
		const success = new Response(null, { status: 204 });
		expect(await confirmHeldDesktopRequest(request, success, signal)).toBe(
			success
		);
		const result = confirmHeldDesktopRequest(request, original, signal);
		await vi.waitFor(() => expect(desktopConfirmations()).toHaveLength(1));
		const entry = desktopConfirmations()[0];
		expect(entry.request).toEqual(request);
		expect(
			desktopControlReceipt({
				id: "other",
				ok: false,
				uncertain: true,
				record: { status: 200, body: "{}" },
			})
		).toBeUndefined();
		entry.finish(
			desktopControlReceipt({
				id: "exact",
				ok: true,
				uncertain: false,
				record: { status: 202, body: '{"workerId":"owned"}' },
			})
		);
		expect((await result).status).toBe(202);
		expect(await (await result).json()).toEqual({ workerId: "owned" });
		expect(desktopConfirmations()).toHaveLength(0);
	} finally {
		unsubscribe();
	}
});

it.each(["cancel", "abort", "unmount", "expiry"])(
	"does not replay a request after %s, including potentially uncertain delivery",
	async (reason) => {
		vi.useFakeTimers();
		const unsubscribe = subscribeDesktopConfirmations(() => {});
		const controller = new AbortController();
		const result = confirmHeldDesktopRequest(
			draft(),
			held(),
			controller.signal
		);
		await vi.waitFor(() => expect(desktopConfirmations()).toHaveLength(1));
		if (reason === "cancel") desktopConfirmations()[0].finish();
		if (reason === "abort") controller.abort();
		if (reason === "unmount") unsubscribe();
		if (reason === "expiry") vi.advanceTimersByTime(120_000);
		const response = await result;
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "OUTER_CONFIRMATION_CLOSED",
		});
		expect(desktopConfirmations()).toHaveLength(0);
		unsubscribe();
	}
);
