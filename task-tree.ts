import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import { canonicalPath } from "./store.ts";
import type { ProjectIndex, SessionRecord, TaskRecord } from "./types.ts";

export type TreeAction =
	| { type: "switch"; sessionId: string }
	| { type: "rename-session"; sessionId: string }
	| { type: "rename-task"; taskId: string }
	| { type: "move-session"; sessionId: string }
	| { type: "merge-task"; taskId: string }
	| { type: "toggle-session-lock"; sessionId: string }
	| { type: "toggle-task-lock"; taskId: string };

type TreeRow =
	| { type: "task"; task: TaskRecord; label: string }
	| { type: "session"; session: SessionRecord; label: string };

function updatedTime(task: TaskRecord, sessions: SessionRecord[]): number {
	return Math.max(
		Date.parse(task.updatedAt) || 0,
		...sessions.filter((session) => session.taskId === task.id).map((session) => Date.parse(session.updatedAt) || 0),
	);
}

function activityAge(timestamp: number): string {
	const elapsed = Math.max(0, Date.now() - timestamp);
	const minutes = Math.floor(elapsed / 60_000);
	const hours = Math.floor(elapsed / 3_600_000);
	const days = Math.floor(elapsed / 86_400_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	if (hours < 24) return `${hours}h`;
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

export async function openTaskTree(
	ctx: ExtensionCommandContext,
	project: ProjectIndex,
	currentPath?: string,
): Promise<TreeAction | null> {
	if (ctx.mode !== "tui") return null;
	return ctx.ui.custom<TreeAction | null>((tui, theme, _keybindings, done) => {
		const search = new Input();
		search.focused = true;
		const newestTask = [...project.tasks].sort(
			(left, right) => updatedTime(right, project.sessions) - updatedTime(left, project.sessions),
		)[0];
		const expandedTasks = new Set(newestTask ? [newestTask.id] : []);
		const expandedRoots = new Set(project.sessions.filter((session) => !session.parentId).map((session) => session.id));
		let selected = 0;
		let query = "";

		const byParent = new Map<string, SessionRecord[]>();
		for (const session of project.sessions) {
			if (!session.parentId) continue;
			const children = byParent.get(session.parentId) ?? [];
			children.push(session);
			byParent.set(session.parentId, children);
		}

		function descendants(root: SessionRecord): SessionRecord[] {
			const result: SessionRecord[] = [];
			const queue = [...(byParent.get(root.id) ?? [])];
			while (queue.length > 0) {
				const child = queue.shift()!;
				result.push(child);
				queue.push(...(byParent.get(child.id) ?? []));
			}
			return result.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
		}

		function rows(): TreeRow[] {
			const needle = query.trim().toLocaleLowerCase();
			const output: TreeRow[] = [];
			const tasks = [...project.tasks].sort(
				(left, right) => updatedTime(right, project.sessions) - updatedTime(left, project.sessions),
			);
			for (const task of tasks) {
				const taskSessions = project.sessions.filter((session) => session.taskId === task.id);
				const roots = taskSessions
					.filter((session) => !session.parentId)
					.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
				const taskMatches = task.title.toLocaleLowerCase().includes(needle);
				const matchingSessions = new Set(
					taskSessions
						.filter((session) => (session.title ?? "").toLocaleLowerCase().includes(needle))
						.map((session) => session.id),
				);
				if (needle && !taskMatches && matchingSessions.size === 0) continue;
				output.push({
					type: "task",
					task,
					label: `${task.locked ? "🔒 " : ""}${task.title} (${taskSessions.length})`,
				});
				if (!needle && !expandedTasks.has(task.id)) continue;
				for (const root of roots) {
					const branches = descendants(root);
					const rootMatches = taskMatches || matchingSessions.has(root.id) || branches.some((item) => matchingSessions.has(item.id));
					if (needle && !rootMatches) continue;
					const rootMarker = branches.length === 0 ? "─" : needle || expandedRoots.has(root.id) ? "▾" : "▸";
					const current = currentPath && canonicalPath(root.path) === canonicalPath(currentPath) ? "●" : " ";
					output.push({
						type: "session",
						session: root,
						label: `  ${rootMarker} ${current} ${root.locked ? "🔒 " : ""}${root.title ?? root.id} · ${root.updatedAt.slice(0, 10)}`,
					});
					if (!needle && !expandedRoots.has(root.id)) continue;
					for (const branch of branches) {
						if (needle && !taskMatches && !matchingSessions.has(branch.id)) continue;
						const active = currentPath && canonicalPath(branch.path) === canonicalPath(currentPath) ? "●" : " ";
						const kind = branch.kind;
						output.push({
							type: "session",
							session: branch,
							label: `      └ ${active} ${branch.locked ? "🔒 " : ""}${branch.title ?? branch.id} [${kind}]`,
						});
					}
				}
			}
			return output;
		}

		function currentRow(): TreeRow | undefined {
			const visible = rows();
			selected = Math.max(0, Math.min(selected, visible.length - 1));
			return visible[selected];
		}

		function refresh(): void {
			const visible = rows();
			selected = Math.max(0, Math.min(selected, visible.length - 1));
			tui.requestRender();
		}

		function toggle(row: TreeRow, expand?: boolean): void {
			if (row.type === "task") {
				const next = expand ?? !expandedTasks.has(row.task.id);
				if (next) expandedTasks.add(row.task.id);
				else expandedTasks.delete(row.task.id);
			} else if (!row.session.parentId) {
				const next = expand ?? !expandedRoots.has(row.session.id);
				if (next) expandedRoots.add(row.session.id);
				else expandedRoots.delete(row.session.id);
			}
			refresh();
		}

		function handleInput(data: string): void {
			const visible = rows();
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(null);
			if (matchesKey(data, Key.up)) {
				selected = Math.max(0, selected - 1);
				return refresh();
			}
			if (matchesKey(data, Key.down)) {
				selected = Math.min(visible.length - 1, selected + 1);
				return refresh();
			}
			const row = currentRow();
			if (matchesKey(data, Key.left) && row) return toggle(row, false);
			if (matchesKey(data, Key.right) && row) return toggle(row, true);
			if (matchesKey(data, Key.enter) && row) {
				if (row.type === "task" || !row.session.parentId && (byParent.get(row.session.id)?.length ?? 0) > 0) {
					if (row.type === "task") return toggle(row);
				}
				if (row.type === "session") return done({ type: "switch", sessionId: row.session.id });
			}
			if (matchesKey(data, Key.ctrl("r")) && row) {
				return done(row.type === "task" ? { type: "rename-task", taskId: row.task.id } : { type: "rename-session", sessionId: row.session.id });
			}
			if (matchesKey(data, Key.alt("m")) && row?.type === "session" && !row.session.parentId) {
				return done({ type: "move-session", sessionId: row.session.id });
			}
			if (matchesKey(data, Key.alt("g")) && row?.type === "task") return done({ type: "merge-task", taskId: row.task.id });
			if (matchesKey(data, Key.alt("l")) && row) {
				return done(row.type === "task" ? { type: "toggle-task-lock", taskId: row.task.id } : { type: "toggle-session-lock", sessionId: row.session.id });
			}

			const before = search.getValue();
			search.handleInput(data);
			query = search.getValue();
			if (query !== before) {
				selected = 0;
				refresh();
			}
		}

		const content: Component = {
			render(width: number): string[] {
				const safeWidth = Math.max(1, width);
				const visible = rows();
				const title = theme.bold("Tasks");
				const sort = `${theme.fg("muted", "Sort: ")}${theme.fg("accent", "Recent")}`;
				const titleWidth = Math.max(0, safeWidth - visibleWidth(sort) - 1);
				const left = truncateToWidth(title, titleWidth, "");
				const lines = [`${left}${" ".repeat(Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(sort)))}${sort}`];
				lines.push(theme.fg("muted", "Newest Task first · type to search"));
				lines.push("");
				lines.push(...search.render(safeWidth));
				lines.push("");
				if (visible.length === 0) lines.push(theme.fg("warning", "  No matching tasks"));
				const maxVisible = 18;
				const start = Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), visible.length - maxVisible));
				for (let index = start; index < Math.min(visible.length, start + maxVisible); index++) {
					const row = visible[index];
					const cursor = index === selected ? theme.fg("accent", "› ") : "  ";
					const right = row.type === "task" ? activityAge(updatedTime(row.task, project.sessions)) : "";
					const availableLabelWidth = Math.max(1, safeWidth - visibleWidth(cursor) - (right ? visibleWidth(right) + 2 : 0));
					const label = truncateToWidth(row.label, availableLabelWidth, "…");
					const spacing = right
						? " ".repeat(Math.max(1, safeWidth - visibleWidth(cursor) - visibleWidth(label) - visibleWidth(right)))
						: "";
					let line = `${cursor}${label}${spacing}${right ? theme.fg("dim", right) : ""}`;
					if (index === selected) line = theme.bg("selectedBg", theme.bold(line));
					lines.push(truncateToWidth(line, safeWidth, ""));
				}
				if (visible.length > maxVisible) lines.push(theme.fg("dim", `  (${selected + 1}/${visible.length})`));
				lines.push("");
				lines.push(theme.fg("dim", "↑↓ select · ←→ fold · Enter open · Ctrl+R rename · Alt+M move · Alt+G merge · Alt+L lock · Esc close"));
				return lines.map((line) => truncateToWidth(line, safeWidth, ""));
			},
			invalidate() {
				search.invalidate();
			},
		};

		const panel = new Container();
		panel.addChild(new Spacer(1));
		panel.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		panel.addChild(new Spacer(1));
		panel.addChild(content);
		panel.addChild(new Spacer(1));
		panel.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const component: Component & Focusable = {
			get focused() {
				return search.focused;
			},
			set focused(value: boolean) {
				search.focused = value;
			},
			render(width: number): string[] {
				return panel.render(width);
			},
			invalidate() {
				panel.invalidate();
			},
			handleInput,
		};
		return component;
	});
}
