import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { canonicalPath, readProject, updateProject } from "./store.ts";
import type { ProjectIndex, SessionRecord, TaskRecord } from "./types.ts";

function compactText(value: string, maximum = 90): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object"
			&& part !== null
			&& (part as { type?: unknown }).type === "text"
			&& typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

function provisionalTask(rootId: string, title: string, createdAt: string): TaskRecord {
	return {
		id: `task:${rootId}`,
		title,
		provisional: true,
		locked: false,
		createdAt,
		updatedAt: createdAt,
	};
}

export function currentSession(project: ProjectIndex, path?: string): SessionRecord | undefined {
	if (!path) return undefined;
	const canonical = canonicalPath(path);
	return project.sessions.find((session) => canonicalPath(session.path) === canonical);
}

/** Give every live Session a stable identity without invoking the organizer or a model. */
export async function ensureSessionIdentity(ctx: ExtensionContext): Promise<{ session: SessionRecord; task: TaskRecord } | undefined> {
	const sourcePath = ctx.sessionManager.getSessionFile();
	const header = ctx.sessionManager.getHeader();
	if (!sourcePath || !header) return undefined;

	const path = canonicalPath(sourcePath);
	const snapshot = await readProject(ctx.cwd);
	const indexed = currentSession(snapshot, path);
	const indexedTask = indexed?.taskId ? snapshot.tasks.find((task) => task.id === indexed.taskId) : undefined;
	if (indexed && indexedTask) return { session: indexed, task: indexedTask };

	const parentPath = header.parentSession ? canonicalPath(header.parentSession) : undefined;
	const branch = ctx.sessionManager.getBranch();
	const userMessages = branch.flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const text = contentText(entry.message.content).trim();
		return text ? [compactText(text, 1200)] : [];
	});
	const createdAt = header.timestamp;
	const updatedAt = branch.at(-1)?.timestamp ?? createdAt;
	const sessionName = ctx.sessionManager.getSessionName();
	const fallbackTitle = compactText(sessionName ?? userMessages[0] ?? basename(path), 90);
	let result: { session: SessionRecord; task: TaskRecord } | undefined;

	await updateProject(ctx.cwd, (project) => {
		const existing = currentSession(project, path);
		if (existing?.taskId) {
			const task = project.tasks.find((item) => item.id === existing.taskId);
			if (task) {
				result = { session: existing, task };
				return;
			}
		}

		const parent = parentPath ? currentSession(project, parentPath) : undefined;
		const parentTask = parent?.taskId ? project.tasks.find((item) => item.id === parent.taskId) : undefined;
		const rootId = parent?.rootSessionId ?? parent?.id ?? header.id;
		let task = parentTask;
		if (!task) {
			const taskId = `task:${rootId}`;
			task = project.tasks.find((item) => item.id === taskId);
			if (!task) {
				task = provisionalTask(rootId, fallbackTitle || "Untitled task", createdAt);
				project.tasks.push(task);
			}
		}

		const record: SessionRecord = {
			id: header.id,
			path,
			cwd: canonicalPath(ctx.cwd),
			title: existing?.title ?? sessionName ?? fallbackTitle,
			taskId: task.id,
			assignmentSource: parent?.assignmentSource ?? existing?.assignmentSource ?? "provisional",
			parentPath,
			parentId: parent?.id,
			rootSessionId: rootId,
			kind: parent ? existing?.kind ?? "fork" : "session",
			forkPoint: existing?.forkPoint,
			confidence: existing?.confidence,
			lastHandoffLeafId: existing?.lastHandoffLeafId,
			locked: existing?.locked ?? false,
			createdAt,
			updatedAt,
			card: {
				originalName: sessionName,
				firstUserMessage: userMessages[0],
				recentUserMessages: userMessages.slice(-3),
				files: existing?.card.files ?? [],
				createdAt,
				updatedAt,
				parentSession: parentPath,
				sessionId: header.id,
				firstEntryId: branch[0]?.id,
				latestEntryId: branch.at(-1)?.id,
			},
		};
		project.sessions = project.sessions.filter((item) => item.id !== record.id && canonicalPath(item.path) !== path);
		project.sessions.push(record);
		result = { session: record, task };
	});
	return result;
}
