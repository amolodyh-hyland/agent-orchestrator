import { createMulticaAuthSession } from "./multica-auth-session";
import { MulticaNotificationGate, parseMulticaNotificationPayload, type MulticaNotificationPayload } from "./multica-notification-gate";

export type MulticaInboxTarget = Pick<MulticaNotificationPayload, "slug" | "itemId" | "issueKey">;
export type NativeNotificationLike = {
	on(event: "click", listener: () => void): unknown;
	on(event: "failed", listener: () => void): unknown;
	show(): void;
	close(): void;
};
export type MulticaNotificationsOptions = {
	isSupported: () => boolean;
	createNotification: (options: { title: string; body: string }) => NativeNotificationLike;
	/** True while AO's window has OS focus. */
	isWindowFocused: () => boolean;
	/** True while the Multica view covers the AO window. */
	isMulticaShown: () => boolean;
	/** Called on a banner click that passed the account guard. */
	openInboxItem: (target: MulticaInboxTarget) => void;
	/** Receives Multica's unread count (0 clears it). */
	setBadge: (count: number) => void;
};
export type MulticaNotifications = {
	showNotification: (value: unknown) => void;
	/** Returns true when the report invalidated the session. */
	reportAuthSession: (value: unknown) => boolean;
	setBadge: (value: unknown) => void;
	/** The view went away: forget the account, invalidate banners, zero the badge contribution. */
	reset: () => void;
};

const MAX_LIVE_BANNERS = 50;

export function createMulticaNotifications(options: MulticaNotificationsOptions): MulticaNotifications {
	const auth = createMulticaAuthSession();
	const gate = new MulticaNotificationGate();
	const banners = new Set<NativeNotificationLike>();
	const releaseAll = () => {
		for (const banner of banners) {
			try {
				banner.close();
			} catch {
				// Releasing one native banner must not prevent the others from closing.
			}
		}
		banners.clear();
	};

	return {
		showNotification: (value) => {
			let banner: NativeNotificationLike | undefined;
			try {
				if (!auth.hasActiveSession()) return;
				const payload = parseMulticaNotificationPayload(value);
				if (!payload || !options.isSupported()) return;

				const userIsLooking = options.isWindowFocused() && options.isMulticaShown();
				if (!gate.shouldShow(payload.itemId, userIsLooking)) return;

				const generation = auth.generation();
				const currentBanner = options.createNotification({ title: payload.title, body: payload.body });
				banner = currentBanner;
				banners.add(currentBanner);
				while (banners.size > MAX_LIVE_BANNERS) {
					const oldestBanner = banners.values().next().value;
					if (!oldestBanner) break;
					banners.delete(oldestBanner);
					try {
						oldestBanner.close();
					} catch {
						// Retention stays bounded even if the native close fails.
					}
				}

				let clicked = false;
				const release = () => banners.delete(currentBanner);
				currentBanner.on("click", () => {
					if (clicked) return;
					clicked = true;
					release();
					// Windows keeps timed-out toasts clickable in Action Center after close.
					try {
						if (auth.generation() !== generation) return;
						options.openInboxItem({ slug: payload.slug, itemId: payload.itemId, issueKey: payload.issueKey });
					} catch {
						// Native event callbacks must not leak errors to Electron.
					}
				});
				currentBanner.on("failed", release);
				currentBanner.show();
			} catch {
				if (banner) banners.delete(banner);
			}
		},
		reportAuthSession: (value) => {
			const invalidated = auth.report(value);
			if (invalidated) {
				releaseAll();
				try {
					options.setBadge(0);
				} catch {
					// Badge failures stay out of the IPC handler.
				}
			}
			return invalidated;
		},
		setBadge: (value) => {
			const count = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
			try {
				options.setBadge(count);
			} catch {
				// IPC badge updates must not escape into the renderer.
			}
		},
		reset: () => {
			auth.reset();
			releaseAll();
			try {
				options.setBadge(0);
			} catch {
				// Reset still completes even when the native badge cannot be updated.
			}
		},
	};
}
