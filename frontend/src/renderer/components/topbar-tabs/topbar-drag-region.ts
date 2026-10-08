import type { CSSProperties } from "react";
import { isMacPlatform } from "../../lib/platform";

type AppRegionStyle = CSSProperties & { WebkitAppRegion: "drag" | "no-drag" };

// macOS draws the header into the window's titlebar area, so empty header space
// is the window's drag handle. Only dedicated filler elements declare "drag";
// the containers holding tabs and actions declare "no-drag" themselves, so no
// control relies on a carve-out inside a draggable ancestor.
export function topbarDragStyle(): AppRegionStyle | undefined {
	return isMacPlatform() ? { WebkitAppRegion: "drag" } : undefined;
}

export function topbarNoDragStyle(): AppRegionStyle | undefined {
	return isMacPlatform() ? { WebkitAppRegion: "no-drag" } : undefined;
}
