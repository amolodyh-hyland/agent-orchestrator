import { deriveMulticaExecutor } from "../shared/multica-executor";
import { MAX_OPEN_WITH_AO_EXECUTOR_TEXT, type OpenWithAoExecutorLine } from "../shared/multica-open-with-ao";
import type { AwarenessIssueLookup } from "./multica-awareness";

const CONTROL_CHARACTERS = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

function plain(value: string): string {
	return value.replace(CONTROL_CHARACTERS, " ").trim();
}

function clamp(value: string): string {
	const points = Array.from(value);
	return points.length <= MAX_OPEN_WITH_AO_EXECUTOR_TEXT ? value : `${points.slice(0, MAX_OPEN_WITH_AO_EXECUTOR_TEXT - 1).join("")}…`;
}

function names(values: readonly string[]): string {
	const clean = values.map(plain).filter(Boolean);
	if (clean.length === 0) return "";
	return clean.length <= 2 ? clean.join(", ") : `${clean.slice(0, 2).join(", ")} +${clean.length - 2}`;
}

/**
 * The executor line of the Open in AO menu: one sentence on who works the issue
 * now (`ao`, `multica-agent`, `human` or `contested`). Null when awareness does
 * not know the issue, or when nobody holds it. Detection only; nothing acts on it.
 */
export function buildExecutorLine(input: {
	lookup: AwarenessIssueLookup | null;
	liveSessions: ReadonlyArray<{ label: string; stateLabel: string }>;
}): OpenWithAoExecutorLine | null {
	const { lookup, liveSessions } = input;
	if (lookup === null) return null;
	const derivation = deriveMulticaExecutor({
		issue: lookup.issue,
		activeRunCount: lookup.activeRuns.length,
		hasLiveAoSession: liveSessions.length > 0,
		meId: lookup.meId,
	});
	const agent = names(lookup.agentNames);
	const squad = lookup.issue.assigneeType === "squad";
	const who = agent !== "" ? `Multica agent ${agent}` : squad ? "a Multica squad" : "a Multica agent";
	switch (derivation.display) {
		case "contested":
			return { display: "contested", text: clamp("Contested: a Multica agent and an AO session both hold this issue") };
		case "multica-agent": {
			const state = derivation.detail === "running" ? "running" : derivation.detail === "parked" ? "parked in the backlog" : "assigned, not running";
			return { display: "multica-agent", text: clamp(`Run by: ${who}, ${state}`) };
		}
		case "ao": {
			const [first, ...rest] = liveSessions;
			const more = rest.length > 0 ? ` +${rest.length} more` : "";
			return { display: "ao", text: clamp(`Run by: AO session ${plain(first.label)}, ${plain(first.stateLabel)}${more}`) };
		}
		case "human":
			return { display: "human", text: derivation.detail === "you" ? "Run by: you" : "Run by: another member" };
		case "none":
			return null;
	}
}
