import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useWorkspaceQuery } from "../../hooks/useWorkspaceQuery";
import { projectColorCss } from "../../lib/project-colors";
import { useTopbarTabsStore } from "../../stores/topbar-tabs-store";
import { useResolvedTheme } from "../../stores/ui-store";
import { STANDALONE_WORKSPACE_ID } from "../../types/workspace";

const EMPTY_PROJECT_COLORS: Record<string, number> = {};

export function useProjectColors(): {
	enabled: boolean;
	accentFor: (projectId: string | undefined) => string | undefined;
} {
	const enabled = useTopbarTabsStore((state) => state.colorCoding);
	const subscribeToProjectColors = useCallback((onStoreChange: () => void) => {
		if (!enabled) return () => {};
		return useTopbarTabsStore.subscribe((state, previousState) => {
			if (state.projectColors !== previousState.projectColors) onStoreChange();
		});
	}, [enabled]);
	const projectColors = useSyncExternalStore(
		subscribeToProjectColors,
		() => enabled ? useTopbarTabsStore.getState().projectColors : EMPTY_PROJECT_COLORS,
		() => enabled ? useTopbarTabsStore.getState().projectColors : EMPTY_PROJECT_COLORS,
	);
	const theme = useResolvedTheme(enabled);
	const { data: workspaces } = useWorkspaceQuery({ subscribed: enabled });

	useEffect(() => {
		if (!enabled) return;
		const projectIds = (workspaces ?? [])
			.filter((workspace) => workspace.id !== STANDALONE_WORKSPACE_ID)
			.map((workspace) => workspace.id);
		useTopbarTabsStore.getState().ensureProjectColors(projectIds);
	}, [enabled, workspaces]);

	const accentFor = useCallback((projectId: string | undefined): string | undefined => {
		if (!enabled || projectId === undefined) return undefined;
		if (!Object.hasOwn(projectColors, projectId)) return undefined;
		const slot = projectColors[projectId];
		return slot === undefined ? undefined : projectColorCss(slot, theme);
	}, [enabled, projectColors, theme]);

	return { enabled, accentFor };
}
