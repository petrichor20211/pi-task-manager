import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type { AssignmentSource, ProjectIndex, SessionRecord, TaskManagerIndex } from "./types.ts";

export const INDEX_PATH = join(getAgentDir(), "task-manager", "index.json");

const queueKey = Symbol.for("pi-task-manager.write-queue");
type QueueHolder = typeof globalThis & { [queueKey]?: Promise<void> };

export function canonicalPath(value: string): string {
	const result = normalize(resolve(value));
	return process.platform === "win32" ? result.toLowerCase() : result;
}

export function projectKey(cwd: string): string {
	return canonicalPath(cwd);
}

export function emptyProject(cwd: string): ProjectIndex {
	return {
		cwd: canonicalPath(cwd),
		autoOrganize: false,
		autoHandoff: false,
		tasks: [],
		sessions: [],
		fingerprints: {},
	};
}

function inferredAssignmentSource(session: SessionRecord): AssignmentSource {
	if (session.locked) return "manual";
	return session.taskId?.startsWith("task:") ? "provisional" : "organized";
}

function rootOf(session: SessionRecord, byId: Map<string, SessionRecord>): SessionRecord {
	let current = session;
	const seen = new Set<string>();
	while (current.parentId && !seen.has(current.id)) {
		seen.add(current.id);
		const parent = byId.get(current.parentId);
		if (!parent) break;
		current = parent;
	}
	return current;
}

function normalizeProject(project: ProjectIndex): ProjectIndex {
	project.autoHandoff ??= false;
	project.tasks ??= [];
	project.sessions ??= [];
	project.fingerprints ??= {};
	for (const task of project.tasks) task.provisional ??= task.id.startsWith("task:");
	for (const session of project.sessions) session.assignmentSource ??= inferredAssignmentSource(session);

	// Migrate the old shared Unclassified bucket to one stable lineage per root Session.
	const byId = new Map(project.sessions.map((session) => [session.id, session]));
	for (const session of project.sessions) {
		const root = rootOf(session, byId);
		if (root.taskId && root.taskId !== "unclassified") continue;
		const taskId = `task:${root.id}`;
		root.taskId = taskId;
		root.assignmentSource = "provisional";
		if (!project.tasks.some((task) => task.id === taskId)) {
			project.tasks.push({
				id: taskId,
				title: root.title ?? root.card.originalName ?? "Untitled task",
				provisional: true,
				locked: false,
				createdAt: root.createdAt,
				updatedAt: root.updatedAt,
			});
		}
	}
	for (const session of project.sessions) {
		if (!session.parentId) continue;
		const root = rootOf(session, byId);
		if (session.taskId === "unclassified" || !session.taskId) {
			session.taskId = root.taskId;
			session.assignmentSource = root.assignmentSource;
		}
	}
	const used = new Set(project.sessions.map((session) => session.taskId));
	project.tasks = project.tasks.filter((task) => task.id !== "unclassified" || used.has(task.id));
	return project;
}

function emptyIndex(): TaskManagerIndex {
	return { version: 2, projects: {} };
}

export async function readIndex(): Promise<TaskManagerIndex> {
	try {
		const parsed = JSON.parse(await readFile(INDEX_PATH, "utf8")) as Partial<TaskManagerIndex>;
		if (parsed.version !== 2 || !parsed.projects || typeof parsed.projects !== "object") return emptyIndex();
		return { version: 2, projects: parsed.projects };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
		throw error;
	}
}

async function writeIndex(index: TaskManagerIndex): Promise<void> {
	await mkdir(dirname(INDEX_PATH), { recursive: true });
	const temporary = `${INDEX_PATH}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
	await rename(temporary, INDEX_PATH);
}

export async function readProject(cwd: string): Promise<ProjectIndex> {
	const index = await readIndex();
	const project = index.projects[projectKey(cwd)];
	return project ? normalizeProject(project) : emptyProject(cwd);
}

export function updateIndex(change: (index: TaskManagerIndex) => void | Promise<void>): Promise<void> {
	const holder = globalThis as QueueHolder;
	const pending = (holder[queueKey] ?? Promise.resolve()).then(async () => {
		const index = await readIndex();
		await change(index);
		await writeIndex(index);
	});
	holder[queueKey] = pending.catch(() => undefined);
	return pending;
}

export function updateProject(cwd: string, change: (project: ProjectIndex) => void | Promise<void>): Promise<void> {
	return updateIndex(async (index) => {
		const key = projectKey(cwd);
		const project = normalizeProject(index.projects[key] ?? emptyProject(cwd));
		await change(project);
		index.projects[key] = project;
	});
}
