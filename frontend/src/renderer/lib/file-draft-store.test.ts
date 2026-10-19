import { afterEach, describe, expect, it } from "vitest";
import {
	clearFileDraftIfRevision,
	clearSessionFileDrafts,
	draftedFilePaths,
	getFileDraft,
	hasUnstoredFileDraft,
	MAX_FILE_DRAFT_CHARS,
	MAX_FILE_DRAFT_TOTAL_CHARS,
	MAX_FILE_DRAFTS,
	rebaseFileDraft,
	resetFileDraftsForTests,
	setFileDraft,
} from "./file-draft-store";

afterEach(resetFileDraftsForTests);

describe("file draft store", () => {
	it("keeps the first base fingerprint across later edits and bumps the revision", () => {
		const first = setFileDraft("s", "a.ts", "one", "fp-1");
		const second = setFileDraft("s", "a.ts", "two", "fp-2");
		expect(second).toBeGreaterThan(first!);
		expect(getFileDraft("s", "a.ts")).toEqual({ content: "two", baseFingerprint: "fp-1", revision: second });
	});

	it("clears a saved revision but never newer edits", () => {
		const saved = setFileDraft("s", "a.ts", "A", "fp-1");
		setFileDraft("s", "a.ts", "AB", "fp-1");
		clearFileDraftIfRevision("s", "a.ts", saved!);
		expect(getFileDraft("s", "a.ts")?.content).toBe("AB");
		clearFileDraftIfRevision("s", "a.ts", getFileDraft("s", "a.ts")!.revision);
		expect(getFileDraft("s", "a.ts")).toBeUndefined();
	});

	it("rebases a newer draft onto the saved fingerprint", () => {
		setFileDraft("s", "a.ts", "AB", "fp-1");
		rebaseFileDraft("s", "a.ts", "fp-1", "fp-2");
		expect(getFileDraft("s", "a.ts")?.baseFingerprint).toBe("fp-2");
		rebaseFileDraft("s", "a.ts", "fp-9", "fp-3");
		expect(getFileDraft("s", "a.ts")?.baseFingerprint).toBe("fp-2");
	});

	it("does not keep a draft over the per-entry limit, drops its stale version and says so", () => {
		setFileDraft("s", "a.ts", "small", "fp-1");
		expect(setFileDraft("s", "a.ts", "x".repeat(MAX_FILE_DRAFT_CHARS + 1), "fp-1")).toBeNull();
		expect(getFileDraft("s", "a.ts")).toBeUndefined();
		expect(hasUnstoredFileDraft()).toBe(true);
		setFileDraft("s", "a.ts", "small again", "fp-1");
		expect(hasUnstoredFileDraft()).toBe(false);
	});

	it("evicts the oldest other drafts past the count limit and never the one being written", () => {
		for (let index = 0; index < MAX_FILE_DRAFTS + 5; index += 1) setFileDraft("s", `f${index}.ts`, "x", "fp");
		expect(draftedFilePaths("s")).toHaveLength(MAX_FILE_DRAFTS);
		expect(getFileDraft("s", "f0.ts")).toBeUndefined();
		expect(getFileDraft("s", `f${MAX_FILE_DRAFTS + 4}.ts`)).toBeDefined();
	});

	it("evicts the oldest drafts past the total size limit but keeps the current one", () => {
		const chunk = "y".repeat(MAX_FILE_DRAFT_CHARS);
		const needed = Math.floor(MAX_FILE_DRAFT_TOTAL_CHARS / MAX_FILE_DRAFT_CHARS) + 2;
		for (let index = 0; index < needed; index += 1) setFileDraft("s", `big${index}.ts`, chunk, "fp");
		expect(getFileDraft("s", "big0.ts")).toBeUndefined();
		expect(getFileDraft("s", `big${needed - 1}.ts`)?.content).toBe(chunk);
		let total = 0;
		for (const path of draftedFilePaths("s")) total += getFileDraft("s", path)!.content.length;
		expect(total).toBeLessThanOrEqual(MAX_FILE_DRAFT_TOTAL_CHARS);
	});

	it("clears every draft of one session, including its artifact variant, and no other", () => {
		setFileDraft("s1", "a.ts", "1", "fp");
		setFileDraft("s1:artifact", "b.md", "2", "fp");
		setFileDraft("s10", "a.ts", "3", "fp");
		clearSessionFileDrafts("s1");
		expect(getFileDraft("s1", "a.ts")).toBeUndefined();
		expect(getFileDraft("s1:artifact", "b.md")).toBeUndefined();
		expect(getFileDraft("s10", "a.ts")?.content).toBe("3");
	});
});
