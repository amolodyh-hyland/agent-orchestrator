import { describe, expect, it } from "vitest";
import { codeColorTheme, codeLanguage, codeThemeStyle } from "./code-style";
import { getThemeDefinition } from "./theme-palettes";

describe("code preferences", () => {
	it("normalizes stored aliases and safely falls back for unknown or missing preferences", () => {
		expect(codeLanguage("TS")).toBe("typescript");
		for (const value of [null, "", "none", "unsupported", "text", "constructor"]) expect(codeLanguage(value)).toBe("none");
		expect(codeColorTheme("nord")).toBe("nord");
		for (const value of [null, "app", "missing", "__proto__"]) expect(codeColorTheme(value)).toBe("app");
	});
	it("uses each named palette's light/dark colors and leaves follow-app colors inherited", () => {
		expect(codeThemeStyle("app", "dark")).toEqual({});
		expect(codeThemeStyle("app", "light")).toEqual({});
		for (const mode of ["dark", "light"] as const) {
			expect(codeThemeStyle("nord", mode)).toMatchObject({
				"--ao-code-keyword": getThemeDefinition("nord")[mode].purple,
				"--ao-code-foreground": getThemeDefinition("nord")[mode].text,
			});
		}
		expect(codeThemeStyle("nord", "dark")).not.toEqual(codeThemeStyle("nord", "light"));
	});
});
