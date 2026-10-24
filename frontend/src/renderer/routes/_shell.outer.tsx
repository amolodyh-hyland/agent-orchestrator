import { createFileRoute } from "@tanstack/react-router";
import { OuterConsole } from "../components/OuterConsole";
export const Route = createFileRoute("/_shell/outer")({
	component: OuterConsole,
	validateSearch: (
		search: Record<string, unknown>
	): { auditProjectId?: string } => ({
		auditProjectId:
			typeof search.auditProjectId === "string" &&
			search.auditProjectId.length <= 256
				? search.auditProjectId
				: undefined,
	}),
});
