import type { CSSProperties } from "react";
import { canonicalLanguage, type GrammarName } from "./code-highlight";
import { getThemeDefinition, isThemeStyle, type ThemeStyle } from "./theme-palettes";
import type { Theme } from "./theme";
import { contrastRatio } from "./theme-color";

export type CodeLanguage = GrammarName | "none";
export type CodeColorTheme = ThemeStyle | "app";

export function codeLanguage(value: string | null): CodeLanguage {
	return canonicalLanguage(value ?? undefined) ?? "none";
}

export function codeColorTheme(value: string | null): CodeColorTheme {
	return isThemeStyle(value) ? value : "app";
}

export const CODE_TOKEN_COLORS = {
	foreground: "var(--ao-code-foreground, var(--foreground))",
	keyword: "var(--ao-code-keyword, var(--color-term-magenta))",
	string: "var(--ao-code-string, var(--color-term-green))",
	number: "var(--ao-code-number, var(--color-term-yellow))",
	title: "var(--ao-code-title, var(--color-term-blue))",
	type: "var(--ao-code-type, var(--color-term-cyan))",
	variable: "var(--ao-code-variable, var(--color-term-red))",
	comment: "var(--ao-code-comment, var(--color-text-muted))",
	params: "var(--ao-code-comment, var(--color-text-muted))",
} as const;

export type CodeTokenKind = keyof typeof CODE_TOKEN_COLORS;

export function codeThemeStyle(theme: CodeColorTheme, mode: Theme): CSSProperties {
	if (theme === "app") return {};
	const palette = getThemeDefinition(theme)[mode];
	const readable = (color: string) => contrastRatio(color, palette.panel) >= 4.5 ? color : palette.text;
	return {
		"--ao-code-background": palette.panel,
		"--ao-code-foreground": readable(palette.text),
		"--ao-code-keyword": readable(palette.purple),
		"--ao-code-string": readable(palette.green),
		"--ao-code-number": readable(palette.yellow),
		"--ao-code-title": readable(palette.blue),
		"--ao-code-type": readable(palette.cyan),
		"--ao-code-variable": readable(palette.red),
		"--ao-code-comment": readable(palette.muted),
	} as CSSProperties;
}
