export type MulticaNotificationPayload = { slug: string; itemId: string; issueKey: string; title: string; body: string };

/** Validates the untrusted value the Multica renderer sends on "notification:show". Returns null when invalid. */
export function parseMulticaNotificationPayload(value: unknown): MulticaNotificationPayload | null {
	if (!value || typeof value !== "object") return null;

	const candidate = value as Record<string, unknown>;
	const limits = { slug: 256, itemId: 256, issueKey: 256, title: 512, body: 2_000 } as const;
	for (const [key, maxLength] of Object.entries(limits)) {
		const field = candidate[key];
		if (typeof field !== "string" || field.length > maxLength) return null;
		if ((key === "itemId" || key === "issueKey" || key === "title") && field.trim().length === 0) return null;
	}

	return {
		slug: candidate.slug as string,
		itemId: candidate.itemId as string,
		issueKey: candidate.issueKey as string,
		title: candidate.title as string,
		body: candidate.body as string,
	};
}

/**
 * Remembers which inbox items were already considered so one item never produces two banners.
 */
export class MulticaNotificationGate {
	private readonly rememberedItems = new Set<string>();

	constructor(private readonly maxRememberedItems = 1_000) {}

	/** True when a banner should be shown for this item now. */
	shouldShow(itemId: string, userIsLooking: boolean): boolean {
		const key = itemId.trim();
		if (key.length === 0 || this.rememberedItems.has(key)) return false;

		this.rememberedItems.add(key);
		if (this.rememberedItems.size > this.maxRememberedItems) {
			const oldest = this.rememberedItems.values().next().value;
			if (oldest !== undefined) this.rememberedItems.delete(oldest);
		}

		return !userIsLooking;
	}
}
