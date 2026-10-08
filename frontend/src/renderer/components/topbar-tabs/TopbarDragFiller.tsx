import type { JSX } from "react";
import { topbarDragStyle } from "./topbar-drag-region";

// Empty header space that moves the window on macOS. Place it last in a flex
// row that is otherwise a no-drag container.
export function TopbarDragFiller({ testId = "topbar-tabs-drag-filler" }: { testId?: string }): JSX.Element {
	return (
		<span
			aria-hidden="true"
			className="topbar-tabs__drag-filler"
			data-testid={testId}
			style={topbarDragStyle()}
		/>
	);
}
