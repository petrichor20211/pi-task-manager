import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import type { ProjectIndex, TaskManagerIndex } from "./types.ts";

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
	return project ? { ...project, autoHandoff: project.autoHandoff ?? false } : emptyProject(cwd);
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
		const project = index.projects[key] ?? emptyProject(cwd);
		project.autoHandoff ??= false;
		await change(project);
		index.projects[key] = project;
	});
}
