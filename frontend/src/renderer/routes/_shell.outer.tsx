import { createFileRoute } from "@tanstack/react-router";
import { OuterConsole } from "../components/OuterConsole";
export const Route = createFileRoute("/_shell/outer")({ component: OuterConsole });
