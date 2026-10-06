export type MulticaAuthSession = {
	/**
	 * Records what the Multica renderer reported on "auth:session-state" (a user id, or null when signed out).
	 * Returns true when the report invalidated the session: the user signed out or the account changed.
	 * A value that is neither null nor a usable string is ignored and returns false.
	 */
	report: (value: unknown) => boolean;
	/** True while a user id is reported (the renderer is signed in). */
	hasActiveSession: () => boolean;
	/** True after the renderer explicitly reported null (signed out); false before a report and after reset. */
	isSignedOut: () => boolean;
	/** Increases on every invalidation. A banner created under an older value must not act on click. */
	generation: () => number;
	/** Forgets the reported user (state returns to "nothing reported") and invalidates: used when the view goes away. */
	reset: () => void;
};

export function createMulticaAuthSession(): MulticaAuthSession {
	let current: string | null | undefined;
	let currentGeneration = 0;

	return {
		report: (value) => {
			let userId: string | null;
			if (value === null) {
				userId = null;
			} else if (typeof value === "string") {
				userId = value.trim();
				if (!userId || userId.length > 256) return false;
			} else {
				return false;
			}

			const becameLoggedOut = userId === null && current !== null;
			const accountChanged = current !== undefined && current !== userId;
			current = userId;
			const invalidated = becameLoggedOut || accountChanged;
			if (invalidated) currentGeneration += 1;
			return invalidated;
		},
		hasActiveSession: () => typeof current === "string",
		isSignedOut: () => current === null,
		generation: () => currentGeneration,
		reset: () => {
			current = undefined;
			currentGeneration += 1;
		},
	};
}
