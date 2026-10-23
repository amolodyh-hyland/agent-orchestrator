import { createFileRoute } from "@tanstack/react-router";
import { ProjectCockpit } from "../components/ProjectCockpit";

export const Route = createFileRoute("/_shell/cockpit")({ component: ProjectCockpit });
