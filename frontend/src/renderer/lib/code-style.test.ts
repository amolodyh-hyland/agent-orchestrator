import { describe, expect, it } from "vitest";
import { codeColorTheme, codeLanguage, codeThemeStyle } from "./code-style";
import { contrastRatio } from "./theme-color";
import { THEMES, getThemeDefinition } from "./theme-palettes";

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
				"--ao-code-background": getThemeDefinition("nord")[mode].panel,
				"--ao-code-foreground": getThemeDefinition("nord")[mode].text,
			});
		}
		expect(codeThemeStyle("nord", "dark")).not.toEqual(codeThemeStyle("nord", "light"));
	});
});


describe("independent code palette contrast", () => {
	for (const app of THEMES) {
		for (const code of THEMES) {
			it.each(["dark", "light"] as const)(`${code.id} code over ${app.id} app in %s mode clears AA`, (mode) => {
				const style = codeThemeStyle(code.id, mode) as Record<string, string>;
				const background = style["--ao-code-background"] ?? app[mode].panel;
				expect(background).toBe(code[mode].panel);
				for (const [name, color] of Object.entries(style)) {
					if (name !== "--ao-code-background") expect(contrastRatio(color, background), name).toBeGreaterThanOrEqual(4.5);
				}
			});
		}
	}
});
