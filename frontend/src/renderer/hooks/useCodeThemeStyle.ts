import { useMemo } from "react";
import { codeThemeStyle } from "../lib/code-style";
import { useUiStore } from "../stores/ui-store";

export function useCodeThemeStyle() {
	const theme = useUiStore((state) => state.codeColorTheme);
	const mode = useUiStore((state) => state.resolvedTheme);
	return useMemo(() => codeThemeStyle(theme, mode), [theme, mode]);
}
