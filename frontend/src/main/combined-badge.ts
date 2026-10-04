export type CombinedBadge = {
	/** Stores AO's own unread count and returns the combined total to display. */
	setAo: (count: unknown) => number;
	/** Stores Multica's unread count and returns the combined total to display. */
	setMultica: (count: unknown) => number;
};

function sanitizeCount(count: unknown): number {
	return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function createCombinedBadge(): CombinedBadge {
	let aoCount = 0;
	let multicaCount = 0;

	return {
		setAo: (count) => {
			aoCount = sanitizeCount(count);
			return aoCount + multicaCount;
		},
		setMultica: (count) => {
			multicaCount = sanitizeCount(count);
			return aoCount + multicaCount;
		},
	};
}
