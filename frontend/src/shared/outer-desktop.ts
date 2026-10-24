import routes from "../../../backend/internal/httpd/outer_desktop_routes.json";

export { routes as outerDesktopRoutes };
export type OuterDesktopRequest = {
	route: keyof typeof routes;
	parameters: string[];
	query: string;
	payload: unknown;
	attachmentUpload: boolean;
};

export function validOuterDesktopRequest(
	value: unknown
): value is OuterDesktopRequest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return false;
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).sort().join(",") !==
			"attachmentUpload,parameters,payload,query,route" ||
		typeof v.route !== "string" ||
		!Object.hasOwn(routes, v.route) ||
		routes[v.route as keyof typeof routes].mode !== "confirm" ||
		typeof v.query !== "string" ||
		v.query.length > 4096 ||
		typeof v.attachmentUpload !== "boolean" ||
		!Array.isArray(v.parameters)
	)
		return false;
	return (
		v.parameters.length === (v.route.match(/\{[^}]+\}/g)?.length ?? 0) &&
		v.parameters.every(
			(part) =>
				typeof part === "string" &&
				part.length > 0 &&
				part.length <= 256 &&
				part !== "." &&
				part !== ".." &&
				!/[\/\\\0]/.test(part)
		)
	);
}

// Matches only the finite, literal routes, with exact parameter cardinality.
// No URL, caller header, credential or native operation comes from the page.
export function outerDesktopRequest(
	method: string,
	url: URL,
	payload: unknown,
	attachmentUpload: boolean
): OuterDesktopRequest | undefined {
	for (const [route, spec] of Object.entries(routes)) {
		if (spec.mode !== "confirm") continue;
		const [verb, path] = route.split(" ");
		if (verb !== method) continue;
		const parts = path.split("/"),
			actual = url.pathname.split("/");
		if (parts.length !== actual.length) continue;
		const parameters: string[] = [];
		if (
			!parts.every((part, i) => {
				if (!part.startsWith("{")) return part === actual[i];
				try {
					parameters.push(decodeURIComponent(actual[i]));
					return true;
				} catch {
					return false;
				}
			})
		)
			continue;
		const request = {
			route: route as keyof typeof routes,
			parameters,
			query: url.search.slice(1),
			payload,
			attachmentUpload,
		};
		return validOuterDesktopRequest(request) ? request : undefined;
	}
	return undefined;
}
