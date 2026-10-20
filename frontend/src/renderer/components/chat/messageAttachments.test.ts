import { describe, expect, it } from "vitest";
import { attachmentName, isFolderAttachmentPath, isImageAttachmentPath, labelInlineImages, proseBesideImages, removeInlineImagePath, splitInlineImagePaths, stagedAttachmentParts } from "./messageAttachments";

const a = ".ao/attachments/attachment-a.png";
const b = ".ao/attachments/attachment-b.png";

describe("folder attachment references", () => {
	it("parses absolute folder references from the existing attachment suffix", () => {
		const path = "/Users/me/Project Files";
		const text = `Inspect this\n\nAttached files (read these files in the workspace):\n- ${path}`;
		expect(stagedAttachmentParts(text)).toEqual({ body: "Inspect this", attachments: [path] });
		expect(attachmentName(path)).toBe("Project Files");
		expect(isFolderAttachmentPath(path)).toBe(true);
		expect(isFolderAttachmentPath("C:\\Users\\me\\Project Files")).toBe(true);
		expect(isImageAttachmentPath("/Users/me/folder.png")).toBe(false);
	});

	it("keeps relative non-AO paths and newline-bearing references as ordinary text", () => {
		const text = "Example\n\nAttached files (read these files in the workspace):\n- docs/screenshot.png";
		expect(stagedAttachmentParts(text)).toEqual({ body: text, attachments: [] });
		const invalid = "Example\n\nAttached files (read these files in the workspace):\n- /Users/me/folder\nname";
		expect(stagedAttachmentParts(invalid)).toEqual({ body: invalid, attachments: [] });
	});
});

describe("inline image paths", () => {
	it("leaves a staged path inside a longer path as text", () => {
		expect(splitInlineImagePaths(`/wt/${a} and ${a}`)).toEqual([{ text: `/wt/${a} and ` }, { path: a }]);
	});

	it("sends no prose for a message that is only its images", () => {
		expect(proseBesideImages(`${a} ${b}`, [a, b])).toBe("");
	});

	// Only the editor knows which paths are chips; a typed path is the user's text.
	it("sends a typed path untouched, attached or not", () => {
		expect(proseBesideImages(`No, look at ${b} again`, [a])).toBe(`No, look at ${b} again`);
		expect(proseBesideImages(`see\n${b}\nthanks`, [])).toBe(`see\n${b}\nthanks`);
		expect(proseBesideImages(b, [])).toBe(b);
	});

	it("labels attached inline images for one-line surfaces and keeps the reference block", () => {
		const block = `\n\nAttached files (read these files in the workspace):\n- ${a}\n- ${b}`;
		expect(labelInlineImages(`make ${b} like ${a}${block}`)).toBe(`make [Image 2] like [Image 1]${block}`);
	});
});

describe("removeInlineImagePath", () => {
	it("drops the image with one following space, as removing its chip does", () => {
		expect(removeInlineImagePath(`compare ${a} with ${b} `, a)).toBe(`compare with ${b} `);
		expect(removeInlineImagePath(`compare ${a} `, a)).toBe("compare ");
	});

	it("drops every occurrence, on every line, and leaves line breaks and other images", () => {
		expect(removeInlineImagePath(`${a} first\nthen ${a}\n${b} kept`, a)).toBe("first\nthen \n" + `${b} kept`);
	});

	it("leaves text without that image untouched, including a longer path containing it", () => {
		expect(removeInlineImagePath(`see /wt/${a} and ${b}`, a)).toBe(`see /wt/${a} and ${b}`);
		expect(removeInlineImagePath("plain words", a)).toBe("plain words");
	});
});
