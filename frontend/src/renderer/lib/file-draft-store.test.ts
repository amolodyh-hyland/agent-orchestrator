import { afterEach, describe, expect, it } from "vitest";
import {
	clearFileDraftIfRevision,
	clearSessionFileDrafts,
	draftedFilePaths,
	getFileDraft,
	MAX_FILE_DRAFT_CHARS,
	MAX_FILE_DRAFT_TOTAL_CHARS,
	MAX_FILE_DRAFTS,
	rebaseFileDraft,
	resetFileDraftsForTests,
	setFileDraft,
	UNKNOWN_FILE_BASE,
	unstoredFileDraftReasonFor,
} from "./file-draft-store";

afterEach(resetFileDraftsForTests);

describe("file draft store", () => {
	it("keeps the first base fingerprint across later edits and bumps the revision", () => {
		const first = setFileDraft("s", "a.ts", "one", "fp-1");
		const second = setFileDraft("s", "a.ts", "two", "fp-2");
		expect(second).toBeGreaterThan(first!);
		expect(getFileDraft("s", "a.ts")).toEqual({ content: "two", reason: null, baseFingerprint: "fp-1", revision: second });
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

	it("drops the text of a draft over the per-entry limit but keeps its record and base", () => {
		setFileDraft("s", "a.ts", "small", "fp-1");
		const revision = setFileDraft("s", "a.ts", "x".repeat(MAX_FILE_DRAFT_CHARS + 1), "fp-9");
		expect(getFileDraft("s", "a.ts")).toEqual({ content: null, reason: "size", baseFingerprint: "fp-1", revision });
		expect(unstoredFileDraftReasonFor("s", "a.ts")).toBe("size");
		expect(draftedFilePaths("s")).toEqual([]);
		setFileDraft("s", "a.ts", "small again", "fp-9");
		expect(getFileDraft("s", "a.ts")).toMatchObject({ content: "small again", reason: null, baseFingerprint: "fp-1" });
	});

	it("an unknown base survives an oversize edit and a shrink", () => {
		setFileDraft("s", "a.ts", "text", "fp-1");
		rebaseFileDraft("s", "a.ts", "fp-1", UNKNOWN_FILE_BASE);
		setFileDraft("s", "a.ts", "x".repeat(MAX_FILE_DRAFT_CHARS + 1), "fp-2");
		setFileDraft("s", "a.ts", "short", "fp-2");
		expect(getFileDraft("s", "a.ts")?.baseFingerprint).toBe(UNKNOWN_FILE_BASE);
	});

	it("refuses the text of a new draft past the count limit, keeps every stored text and its own record", () => {
		for (let index = 0; index < MAX_FILE_DRAFTS; index += 1) setFileDraft("s", `f${index}.ts`, "x", "fp");
		setFileDraft("s", "new.ts", "typed", "fp-new");
		expect(getFileDraft("s", "new.ts")).toMatchObject({ content: null, reason: "capacity", baseFingerprint: "fp-new" });
		expect(unstoredFileDraftReasonFor("s", "new.ts")).toBe("capacity");
		expect(draftedFilePaths("s")).toHaveLength(MAX_FILE_DRAFTS);
		expect(getFileDraft("s", "f0.ts")?.content).toBe("x");
		// A stored draft can still be edited, and the refused one is kept once room appears.
		expect(getFileDraft("s", "f0.ts")).toBeDefined();
		setFileDraft("s", "f0.ts", "xx", "fp");
		expect(getFileDraft("s", "f0.ts")?.content).toBe("xx");
		clearFileDraftIfRevision("s", "f1.ts", getFileDraft("s", "f1.ts")!.revision);
		setFileDraft("s", "new.ts", "typed more", "fp-new");
		expect(getFileDraft("s", "new.ts")).toMatchObject({ content: "typed more", reason: null, baseFingerprint: "fp-new" });
	});

	it("refuses the text of a draft that would pass the total size limit without dropping stored ones", () => {
		const chunk = "y".repeat(MAX_FILE_DRAFT_CHARS);
		const fits = Math.floor(MAX_FILE_DRAFT_TOTAL_CHARS / MAX_FILE_DRAFT_CHARS);
		for (let index = 0; index < fits; index += 1) setFileDraft("s", `big${index}.ts`, chunk, "fp");
		setFileDraft("s", "one-more.ts", "z", "fp");
		expect(unstoredFileDraftReasonFor("s", "one-more.ts")).toBe("capacity");
		for (let index = 0; index < fits; index += 1) expect(getFileDraft("s", `big${index}.ts`)?.content).toBe(chunk);
	});

	it("clears every record of one session, including its artifact variant, and no other", () => {
		setFileDraft("s1", "a.ts", "1", "fp");
		setFileDraft("s1:artifact", "b.md", "2", "fp");
		setFileDraft("s10", "a.ts", "3", "fp");
		clearSessionFileDrafts("s1");
		expect(getFileDraft("s1", "a.ts")).toBeUndefined();
		expect(getFileDraft("s1:artifact", "b.md")).toBeUndefined();
		expect(getFileDraft("s10", "a.ts")?.content).toBe("3");
	});
});
