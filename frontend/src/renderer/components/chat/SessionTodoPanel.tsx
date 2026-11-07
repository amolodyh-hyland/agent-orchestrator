import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { clientForSessionHost } from "../../lib/host-clients";
import type { ConversationPlan, ConversationSnapshot } from "../../types/conversation";
import { TurnPlan } from "./TurnPlan";

const TodoContext = createContext<{
	plan: ConversationPlan;
	floating: boolean;
	collapseKey: string;
	toggleRef: (node: HTMLButtonElement | null) => void;
} | null>(null);

export function InlineTurnPlan(props: ComponentProps<typeof TurnPlan>) {
	const todo = useContext(TodoContext);
	if (todo?.plan === props.plan && todo.floating) return null;
	const collapseKey = todo?.plan === props.plan ? todo.collapseKey : undefined;
	return <TurnPlan key={collapseKey} {...props} collapseKey={collapseKey} toggleRef={todo?.plan === props.plan ? todo.toggleRef : undefined} />;
}

export function SessionTodoPanel({ snapshot, projectId, hostId, cloud, children }: {
	snapshot: ConversationSnapshot;
	projectId?: string;
	hostId?: string;
	cloud?: boolean;
	children: ReactNode;
}) {
	const config = useQuery({
		queryKey: hostId ? ["project-config", hostId, projectId] : ["project-config", projectId],
		enabled: Boolean(projectId) && !cloud,
		queryFn: async () => {
			const { data, error } = await clientForSessionHost(hostId).GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId! } },
			});
			if (error || !data?.project || !("config" in data.project)) return null;
			return data.project.config ?? null;
		},
	});
	return <SessionTodoLayout snapshot={snapshot} placement={config.data?.todoPlacement}
		sessionKey={JSON.stringify([hostId ?? "local", projectId, snapshot.sessionId])}>
		{children}
	</SessionTodoLayout>;
}

export function SessionTodoLayout({ snapshot, placement, sessionKey, children }: {
	snapshot: ConversationSnapshot;
	placement?: string;
	sessionKey: string;
	children: ReactNode;
}) {
	const turn = snapshot.turns.findLast((entry) => !entry.rolledBack && entry.state !== "cancelled" && entry.state !== "queued"
		&& entry.plan?.steps.length && !entry.plan.superseded);
	const viewport = useRef<HTMLDivElement>(null);
	const [fits, setFits] = useState(false);
	const [holdFloatingFocus, setHoldFloatingFocus] = useState(false);
	const inlineToggle = useRef<HTMLButtonElement>(null);
	const floatingToggle = useRef<HTMLButtonElement>(null);
	const transferFocus = useRef(false);
	const setInlineToggle = useCallback((node: HTMLButtonElement | null) => {
		if (!node && inlineToggle.current === document.activeElement) transferFocus.current = true;
		inlineToggle.current = node;
	}, []);
	const setFloatingToggle = useCallback((node: HTMLButtonElement | null) => {
		if (!node && floatingToggle.current === document.activeElement) transferFocus.current = true;
		floatingToggle.current = node;
	}, []);
	const releaseFloatingFocus = useCallback(() => setHoldFloatingFocus(false), []);
	const enabled = placement === "top-right";
	const floating = enabled && Boolean(turn?.plan) && (fits || holdFloatingFocus);
	const collapseKey = `ao.todo.expanded:${sessionKey}`;
	const context = useMemo(() => enabled && turn?.plan
		? { plan: turn.plan, floating, collapseKey, toggleRef: setInlineToggle }
		: null, [enabled, turn?.plan, floating, collapseKey, setInlineToggle]);
	useLayoutEffect(() => {
		if (!transferFocus.current) return;
		const target = floating ? floatingToggle.current : inlineToggle.current;
		if (target) {
			transferFocus.current = false;
			target.focus({ preventScroll: true });
		} else if (enabled && turn?.plan && !floating) {
			setHoldFloatingFocus(true);
		} else {
			transferFocus.current = false;
		}
	});
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!enabled || !element) return;
		const update = (width: number, height: number) => setFits(width >= 640 && height >= 280);
		const rect = element.getBoundingClientRect();
		update(rect.width, rect.height);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) update(entry.contentRect.width, entry.contentRect.height);
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [enabled]);
	return <TodoContext.Provider value={context}>
		<div ref={viewport} className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden empty:hidden" data-todo-placement={floating ? "top-right" : "default"}>
			{children}
			{floating && turn?.plan && <div className="absolute right-3 top-3 z-10 max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] overflow-y-auto rounded-xl bg-background shadow-lg" data-session-todo="">
				<TurnPlan key={collapseKey} plan={turn.plan} live={turn.state === "running"} collapseKey={collapseKey} toggleRef={setFloatingToggle} onToggleBlur={releaseFloatingFocus} />
			</div>}
		</div>
	</TodoContext.Provider>;
}
