import type { CSSProperties } from "react";
import { CODE_LANGUAGES, type GrammarName } from "./code-highlight";
import { getThemeDefinition, isThemeStyle, type ThemeStyle } from "./theme-palettes";
import type { Theme } from "./theme";
import { contrastRatio } from "./theme-color";

export type CodeLanguage = GrammarName | "none";
export type CodeColorTheme = ThemeStyle | "app";

// Labels people (and older saved preferences) use for the languages the settings
// offer. The highlighter accepts far more names than the picker lists, so a stored
// value is folded onto the picker's own entry or dropped to "none".
const LANGUAGE_ALIASES: Record<string, GrammarName> = {
	sh: "bash", shell: "bash", shellsession: "bash", console: "bash", zsh: "bash",
	patch: "diff", udiff: "diff", golang: "go", js: "javascript", mjs: "javascript", cjs: "javascript",
	json5: "json", md: "markdown", py: "python", rs: "rust", ts: "typescript", mts: "typescript", cts: "typescript",
	yml: "yaml", svg: "xml",
};

export function codeLanguage(value: string | null): CodeLanguage {
	const name = value?.toLowerCase() ?? "";
	const resolved = Object.hasOwn(LANGUAGE_ALIASES, name) ? LANGUAGE_ALIASES[name] : name;
	return (CODE_LANGUAGES as readonly string[]).includes(resolved) ? resolved as GrammarName : "none";
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
