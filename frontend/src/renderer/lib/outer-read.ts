import type { OuterReadData, OuterReadQuery } from "../../shared/outer-native";
import { aoBridge } from "./bridge";

export function readOuter(
	query: Extract<OuterReadQuery, { projection: "view" }>
): Promise<OuterReadData["view"]>;
export function readOuter(
	query: Extract<OuterReadQuery, { projection: "facts" }>
): Promise<OuterReadData["facts"]>;
export function readOuter(
	query: Extract<OuterReadQuery, { projection: "audit" }>
): Promise<OuterReadData["audit"]>;
export async function readOuter(
	query: OuterReadQuery
): Promise<OuterReadData[keyof OuterReadData]> {
	const response = await aoBridge.outer?.read(query);
	if (!response || response.projection !== query.projection)
		throw new Error("Trusted outer observation is unavailable");
	return response.data;
}
