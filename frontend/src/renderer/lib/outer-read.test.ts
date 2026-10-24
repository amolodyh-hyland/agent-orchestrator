import { beforeEach, expect, it, vi } from "vitest";
import { aoBridge } from "./bridge";
import { readOuter } from "./outer-read";
import { apiClient } from "./api-client";

vi.mock("./api-client", () => ({ apiClient: { GET: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

it("holds missing desktop read authority without anonymous HTTP fallback", async () => {
	vi.mocked(aoBridge.outer.read).mockResolvedValue(null);
	await expect(readOuter({ projection: "view" })).rejects.toThrow("Trusted outer observation");
	vi.mocked(aoBridge.outer.read).mockRejectedValue(new Error("private IPC unavailable"));
	await expect(readOuter({ projection: "audit", after: 0, limit: 20 })).rejects.toThrow("private IPC unavailable");
	expect(apiClient.GET).not.toHaveBeenCalled();
});

it("rejects a response for a different projection", async () => {
	vi.mocked(aoBridge.outer.read).mockResolvedValue({ projection: "audit", data: { events: [] } });
	await expect(readOuter({ projection: "view" })).rejects.toThrow("Trusted outer observation");
	expect(apiClient.GET).not.toHaveBeenCalled();
});
