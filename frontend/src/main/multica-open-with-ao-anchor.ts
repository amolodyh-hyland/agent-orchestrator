export type OpenWithAoAnchor = {
	header: HTMLElement;
	actions: HTMLElement;
	menuTrigger: HTMLElement;
	menuWrapper: HTMLElement;
	pin: HTMLElement | null;
	panelToggle: HTMLElement | null;
	insertBefore: HTMLElement;
	layer: 1 | 2;
};

export function locateOpenWithAoAnchor(): OpenWithAoAnchor | null {
	try {
		const isVisible = (element: Element): boolean => {
			let current: Element | null = element;
			while (current) {
				if (
					current.hasAttribute("hidden") ||
					current.getAttribute("aria-hidden") === "true" ||
					current.hasAttribute("inert") ||
					(current as HTMLElement).style?.display === "none"
				) {
					return false;
				}

				const computedStyle = getComputedStyle(current);
				if (computedStyle.display === "none" || computedStyle.visibility === "hidden") {
					return false;
				}
				current = current.parentElement;
			}
			return true;
		};

		const findBestAnchor = (
			buttons: readonly Element[],
			layer: 1 | 2,
		): OpenWithAoAnchor | null => {
			let best: OpenWithAoAnchor | null = null;
			let bestArea = -1;

			for (const candidate of buttons) {
				const menuTrigger = candidate as HTMLElement;
				const closestWrapper = menuTrigger.closest("span.relative.inline-flex");
				const menuWrapper =
					closestWrapper && closestWrapper === menuTrigger.parentElement
						? (closestWrapper as HTMLElement)
						: menuTrigger;
				const actions = menuWrapper.parentElement;
				const header = actions?.closest("header");

				if (
					!actions ||
					!header ||
					actions.tagName !== "DIV" ||
					!Array.from(actions.querySelectorAll("button")).some((button) => button !== menuTrigger)
				) {
					continue;
				}

				if (
					layer === 1 &&
					(!actions.classList.contains("flex") ||
						!actions.classList.contains("items-center") ||
						!actions.classList.contains("shrink-0"))
				) {
					continue;
				}

				if (!isVisible(header) || !isVisible(actions) || !isVisible(menuTrigger)) {
					continue;
				}

				const directButtons = Array.from(actions.children).filter(
					(child): child is HTMLElement => child.tagName === "BUTTON",
				);
				const pin =
					directButtons.find((button) => button.querySelector("svg.lucide-pin, svg.lucide-pin-off")) ?? null;
				const panelToggle =
					directButtons.find((button) => button.querySelector("svg.lucide-panel-right")) ?? null;
				const bounds = header.getBoundingClientRect();
				const area = bounds.width * bounds.height;

				if (area > bestArea) {
					bestArea = area;
					best = {
						header: header as HTMLElement,
						actions: actions as HTMLElement,
						menuTrigger,
						menuWrapper,
						pin,
						panelToggle,
						insertBefore: pin ?? menuWrapper,
						layer,
					};
				}
			}

			return best;
		};

		const layerOneButtons = Array.from(document.querySelectorAll('button[data-slot="dropdown-menu-trigger"]')).filter(
			(button) => button.querySelector("svg.lucide-ellipsis"),
		);
		const layerOneAnchor = findBestAnchor(layerOneButtons, 1);
		if (layerOneAnchor) return layerOneAnchor;

		const layerTwoButtons = Array.from(
			document.querySelectorAll('button[data-slot="dropdown-menu-trigger"][aria-haspopup="menu"]'),
		).filter((button) => button.querySelector("svg") && !(button.textContent ?? "").trim());
		return findBestAnchor(layerTwoButtons, 2);
	} catch {
		return null;
	}
}
