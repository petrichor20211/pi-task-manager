import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { canonicalPath, projectKey, readProject, updateProject } from "./store.ts";
import { isHandoffReplacement, registerHandoff } from "./handoff.ts";
import { organizeProject } from "./organizer.ts";
import { openTaskTree, type TreeAction } from "./task-tree.ts";
import type { OrganizeProgress, ProjectIndex, SessionRecord } from "./types.ts";

const jobsKey = Symbol.for("pi-task-manager.organize-jobs");
interface OrganizeJob {
	promise: Promise<void>;
	controller: AbortController;
	startedAt: number;
	progress: OrganizeProgress;
}
interface OrganizeSchedule {
	started: boolean;
	promise: Promise<void>;
}
type JobHolder = typeof globalThis & { [jobsKey]?: Map<string, OrganizeJob> };

function elapsedText(milliseconds: number): string {
	const seconds = milliseconds / 1000;
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function progressText(progress: OrganizeProgress, elapsedMs = progress.elapsedMs): string {
	const count = progress.total > 0 ? ` ${progress.completed}/${progress.total}` : "";
	const phase = progress.phase === "scanning"
		? "scanning sessions"
		: progress.phase === "parsing"
			? "parsing session cards"
			: progress.phase === "organizing"
				? "organizing AI batches"
				: "saving index";
	return `${phase}${count} · ${elapsedText(elapsedMs)}`;
}

function compactTitle(value: string): string {
	const title = value.replace(/\s+/g, " ").trim();
	return title.length <= 90 ? title : `${title.slice(0, 89).trimEnd()}…`;
}

function currentSession(project: ProjectIndex, path?: string): SessionRecord | undefined {
	if (!path) return undefined;
	const canonical = canonicalPath(path);
	return project.sessions.find((session) => canonicalPath(session.path) === canonical);
}

function descendants(project: ProjectIndex, rootId: string): SessionRecord[] {
	const result: SessionRecord[] = [];
	const queue = [rootId];
	while (queue.length > 0) {
		const parentId = queue.shift()!;
		for (const session of project.sessions.filter((item) => item.parentId === parentId)) {
			result.push(session);
			queue.push(session.id);
		}
	}
	return result;
}

async function selectTask(
	ctx: ExtensionCommandContext,
	project: ProjectIndex,
	title: string,
	excludeId?: string,
): Promise<string | undefined> {
	const tasks = project.tasks.filter((task) => task.id !== excludeId);
	if (tasks.length === 0) return undefined;
	const labels = tasks.map((task) => `${task.locked ? "🔒 " : ""}${task.title}`);
	const selected = await ctx.ui.select(title, labels);
	return selected ? tasks[labels.indexOf(selected)]?.id : undefined;
}

async function applyTreeAction(
	action: TreeAction,
	ctx: ExtensionCommandContext,
): Promise<"continue" | "switched"> {
	const project = await readProject(ctx.cwd);
	const session = "sessionId" in action ? project.sessions.find((item) => item.id === action.sessionId) : undefined;
	const task = "taskId" in action ? project.tasks.find((item) => item.id === action.taskId) : undefined;

	if (action.type === "switch") {
		if (!session || canonicalPath(session.path) === canonicalPath(ctx.sessionManager.getSessionFile() ?? "")) return "continue";
		try {
			await ctx.waitForIdle();
			await ctx.switchSession(session.path);
			return "switched";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await updateProject(ctx.cwd, (latest) => {
					latest.sessions = latest.sessions.filter((item) => item.id !== session.id);
					delete latest.fingerprints[canonicalPath(session.path)];
				});
				ctx.ui.notify("Session file no longer exists; removed it from the virtual index", "warning");
				return "continue";
			}
			throw error;
		}
	}

	if (action.type === "rename-task" && task) {
		const value = await ctx.ui.input("Rename task", task.title);
		const title = value && compactTitle(value);
		if (title) await updateProject(ctx.cwd, (latest) => {
			const target = latest.tasks.find((item) => item.id === task.id);
			if (target) Object.assign(target, { title, objective: title, provisional: false, locked: true, updatedAt: new Date().toISOString() });
			for (const item of latest.sessions.filter((item) => item.taskId === task.id)) item.assignmentSource = "manual";
		});
	}
	if (action.type === "rename-session" && session) {
		const value = await ctx.ui.input(`Rename ${session.kind}`, session.title ?? "");
		const title = value && compactTitle(value);
		if (title) await updateProject(ctx.cwd, (latest) => {
			const target = latest.sessions.find((item) => item.id === session.id);
			if (target) Object.assign(target, { title, locked: true });
		});
	}
	if (action.type === "move-session" && session && !session.parentId) {
		const targetTaskId = await selectTask(ctx, project, "Move session to task", session.taskId);
		if (targetTaskId) await updateProject(ctx.cwd, (latest) => {
			const root = latest.sessions.find((item) => item.id === session.id);
			if (!root) return;
			const targetTask = latest.tasks.find((item) => item.id === targetTaskId);
			if (targetTask) targetTask.provisional = false;
			root.taskId = targetTaskId;
			root.assignmentSource = "manual";
			root.locked = true;
			for (const child of descendants(latest, root.id)) {
				child.taskId = targetTaskId;
				child.assignmentSource = "manual";
			}
		});
	}
	if (action.type === "merge-task" && task) {
		const targetTaskId = await selectTask(ctx, project, `Merge “${task.title}” into`, task.id);
		if (targetTaskId) await updateProject(ctx.cwd, (latest) => {
			const targetTask = latest.tasks.find((item) => item.id === targetTaskId);
			if (targetTask) targetTask.provisional = false;
			for (const item of latest.sessions.filter((candidate) => candidate.taskId === task.id)) {
				item.taskId = targetTaskId;
				item.assignmentSource = "manual";
				if (!item.parentId) item.locked = true;
			}
			latest.tasks = latest.tasks.filter((candidate) => candidate.id !== task.id);
		});
	}
	if (action.type === "toggle-task-lock" && task) await updateProject(ctx.cwd, (latest) => {
		const target = latest.tasks.find((item) => item.id === task.id);
		if (target) target.locked = !target.locked;
	});
	if (action.type === "toggle-session-lock" && session) await updateProject(ctx.cwd, (latest) => {
		const target = latest.sessions.find((item) => item.id === session.id);
		if (target) target.locked = !target.locked;
	});
	return "continue";
}

export default function taskManager(pi: ExtensionAPI) {
	function scheduleOrganize(ctx: ExtensionContext, force: boolean): OrganizeSchedule {
		const holder = globalThis as JobHolder;
		const jobs = holder[jobsKey] ?? new Map<string, OrganizeJob>();
		holder[jobsKey] = jobs;
		const key = projectKey(ctx.cwd);
		const running = jobs.get(key);
		if (running) {
			if (ctx.hasUI) ctx.ui.notify(
				`Task organization is already running: ${progressText(running.progress, Date.now() - running.startedAt)}`,
				"info",
			);
			return { started: false, promise: running.promise };
		}
		const startedAt = Date.now();
		const initialProgress: OrganizeProgress = { phase: "scanning", completed: 0, total: 0, elapsedMs: 0 };
		const jobController = new AbortController();
		const record: OrganizeJob = { promise: Promise.resolve(), controller: jobController, startedAt, progress: initialProgress };
		jobs.set(key, record);
		const job = organizeProject(ctx, force, jobController.signal, (progress) => {
			record.progress = progress;
		})
			.then((result) => {
				if (ctx.hasUI) ctx.ui.notify(
					`Task organization finished in ${elapsedText(Date.now() - startedAt)}: ${result.changed} changed, ${result.classified} classified`,
					"info",
				);
			})
			.catch((error) => {
				if (!jobController.signal.aborted && ctx.hasUI) {
					ctx.ui.notify(`Task organization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			})
			.finally(() => {
				jobs.delete(key);
			});
		record.promise = job;
		return { started: true, promise: job };
	}

	registerHandoff(pi);

	pi.on("session_start", async (event, ctx) => {
		// newSession.setup() has not run yet, so scanning here could race the
		// handoff transaction and observe an incomplete continuation Session.
		if (isHandoffReplacement(event.previousSessionFile)) return;
		const project = await readProject(ctx.cwd);
		if (project.autoOrganize) setTimeout(() => scheduleOrganize(ctx, false), 0);
	});

	pi.on("session_shutdown", () => {
		for (const job of (globalThis as JobHolder)[jobsKey]?.values() ?? []) job.controller.abort();
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (!event.name) return;
		const path = ctx.sessionManager.getSessionFile();
		if (!path) return;
		await updateProject(ctx.cwd, (project) => {
			const session = currentSession(project, path);
			if (session) Object.assign(session, { title: event.name, locked: true });
		});
	});

	pi.registerCommand("tasks", {
		description: "Search the current project's virtual Task Tree",
		handler: async (_args, ctx) => {
			let project = await readProject(ctx.cwd);
			if (project.sessions.length === 0) {
				ctx.ui.notify("No indexed sessions. Run /task-organize first.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				const sessions = [...project.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
				const labels = sessions.map((session) => {
					const task = project.tasks.find((item) => item.id === session.taskId);
					return `${task?.title ?? "Unclassified"} / ${session.title ?? session.id}`;
				});
				const selected = await ctx.ui.select("Tasks", labels);
				const target = selected && sessions[labels.indexOf(selected)];
				if (target) await ctx.switchSession(target.path);
				return;
			}
			while (true) {
				const action = await openTaskTree(ctx, project, ctx.sessionManager.getSessionFile());
				if (!action) return;
				if ((await applyTreeAction(action, ctx)) === "switched") return;
				project = await readProject(ctx.cwd);
			}
		},
	});

	pi.registerCommand("task-organize", {
		description: "Organize sessions in the background (--all to rebuild; status for progress)",
		getArgumentCompletions: (prefix) => ["--all", "status"]
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const option = args.trim();
			if (option === "status") {
				const jobs = (globalThis as JobHolder)[jobsKey];
				const running = jobs?.get(projectKey(ctx.cwd));
				ctx.ui.notify(
					running
						? `Task organization: ${progressText(running.progress, Date.now() - running.startedAt)}`
						: "Task organization is not running",
					"info",
				);
				return;
			}
			if (option && option !== "--all") {
				ctx.ui.notify("Usage: /task-organize [--all|status]", "error");
				return;
			}
			if (scheduleOrganize(ctx, option === "--all").started) {
				ctx.ui.notify("Task organization started in the background", "info");
			}
		},
	});

	pi.registerCommand("task-auto", {
		description: "Enable or disable per-project background organization: /task-auto on|off",
		getArgumentCompletions: (prefix) => ["on", "off"]
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /task-auto on|off", "error");
				return;
			}
			await updateProject(ctx.cwd, (project) => {
				project.autoOrganize = value === "on";
			});
			ctx.ui.notify(`Automatic task organization: ${value}`, "info");
			if (value === "on") scheduleOrganize(ctx, false);
		},
	});

	pi.registerCommand("task-title", {
		description: "Rename and lock the current task",
		handler: async (args, ctx) => {
			const title = compactTitle(args);
			if (!title) {
				ctx.ui.notify("Usage: /task-title <title>", "error");
				return;
			}
			const path = ctx.sessionManager.getSessionFile();
			let renamed = false;
			await updateProject(ctx.cwd, (project) => {
				const session = currentSession(project, path);
				const task = session && project.tasks.find((item) => item.id === session.taskId);
				if (!task) return;
				Object.assign(task, { title, objective: title, provisional: false, locked: true, updatedAt: new Date().toISOString() });
				for (const item of project.sessions.filter((item) => item.taskId === task.id)) item.assignmentSource = "manual";
				renamed = true;
			});
			if (!renamed) {
				ctx.ui.notify("Current session is not indexed; run /task-organize first", "warning");
				return;
			}
			ctx.ui.notify(`Task renamed: ${title}`, "info");
		},
	});
}
