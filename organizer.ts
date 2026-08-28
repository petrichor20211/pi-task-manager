import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { isGeneratedHandoffMessage } from "./handoff.ts";
import { canonicalPath, readProject, updateProject } from "./store.ts";
import type {
	FileFingerprint,
	OrganizeProgressCallback,
	OrganizeResult,
	ProjectIndex,
	SessionCard,
	SessionRecord,
	TaskRecord,
} from "./types.ts";

const BATCH_SIZE = 25;
const FILE_CONCURRENCY = 12;
const UNCLASSIFIED_TASK_ID = "unclassified";
const MIN_CONFIDENCE = 0.55;

interface AiSessionResult {
	id: string;
	sessionTitle: string;
	taskId: string;
	taskTitle: string;
	confidence: number;
}

interface AiBranchResult {
	id: string;
	branchTitle: string;
}

interface AiResult {
	sessions: AiSessionResult[];
	branches: AiBranchResult[];
}

interface ScanResult {
	project: ProjectIndex;
	changedIds: Set<string>;
	scanned: number;
}

interface ParsedSession {
	id: string;
	cwd: string;
	createdAt: string;
	parentSession?: string;
	name?: string;
	continuationTaskId?: string;
	entries: SessionEntry[];
	branch: SessionEntry[];
}

interface FileStatResult {
	path: string;
	stats?: Stats;
}

function compactText(value: string, maximum: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function userText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content;
	const text = typeof content === "string"
		? content
		: content
			.filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join(" ");
	if (!text.trim() || isGeneratedHandoffMessage(text)) return undefined;
	return compactText(text, 1200);
}

function collectPath(value: unknown, paths: Map<string, number>): void {
	if (typeof value !== "string" || value.length > 500 || value.includes("\n")) return;
	if (!/[\\/]/.test(value) && !/\.[a-z0-9]{1,8}$/i.test(value)) return;
	const cleaned = value.replace(/^@/, "");
	paths.set(cleaned, (paths.get(cleaned) ?? 0) + 1);
}

function collectFiles(entries: SessionEntry[]): string[] {
	const paths = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const args = block.arguments as Record<string, unknown>;
				for (const key of ["path", "file", "filePath", "cwd"]) collectPath(args[key], paths);
			}
		}
		if (message.role === "toolResult" && message.details && typeof message.details === "object") {
			const details = message.details as Record<string, unknown>;
			for (const key of ["readFiles", "modifiedFiles"]) {
				const values = details[key];
				if (Array.isArray(values)) for (const value of values) collectPath(value, paths);
			}
		}
	}
	return [...paths.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.slice(0, 8)
		.map(([path]) => path);
}

function buildCard(session: ParsedSession, modifiedAt: string): SessionCard {
	const users = session.branch.flatMap((entry) => {
		const text = userText(entry);
		return text ? [{ id: entry.id, text }] : [];
	});
	const compaction = [...session.branch].reverse().find((entry) => entry.type === "compaction");
	return {
		originalName: session.name,
		firstUserMessage: users[0]?.text,
		recentUserMessages: users.slice(-3).map((item) => item.text),
		compactionSummary:
			compaction?.type === "compaction" ? compactText(compaction.summary, 2000) : undefined,
		files: collectFiles(session.branch),
		createdAt: session.createdAt || modifiedAt,
		updatedAt: modifiedAt,
		parentSession: session.parentSession,
		sessionId: session.id,
		firstEntryId: session.branch[0]?.id,
		latestEntryId: session.branch.at(-1)?.id,
	};
}

async function mapConcurrent<T, R>(
	values: T[],
	limit: number,
	operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= values.length) return;
			results[index] = await operation(values[index]!, index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function parseSession(path: string, signal?: AbortSignal): Promise<ParsedSession> {
	signal?.throwIfAborted();
	const text = await readFile(path, { encoding: "utf8", signal });
	const values: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line));
		} catch {}
	}
	const header = values[0] as Record<string, unknown> | undefined;
	if (header?.type !== "session" || typeof header.id !== "string") {
		throw new Error(`Invalid session file: ${path}`);
	}
	const entries: SessionEntry[] = [];
	let previousId: string | null = null;
	for (const [index, value] of values.slice(1).entries()) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (typeof entry.type !== "string") continue;
		const id = typeof entry.id === "string"
			? entry.id
			: createHash("sha256")
				.update(`${index}\0${JSON.stringify(entry)}`)
				.digest("hex")
				.slice(0, 8);
		entry.id = id;
		if (!("parentId" in entry)) entry.parentId = previousId;
		previousId = id;
		entries.push(entry as unknown as SessionEntry);
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let entry = entries.at(-1);
	while (entry && !seen.has(entry.id)) {
		seen.add(entry.id);
		branch.push(entry);
		entry = entry.parentId ? byId.get(entry.parentId) : undefined;
	}
	branch.reverse();
	const named = [...entries].reverse().find((candidate) => candidate.type === "session_info");
	const continuation = [...branch].reverse().find((candidate) =>
		candidate.type === "custom_message"
		&& candidate.customType === "pi-task-manager-continuation"
		&& candidate.details
		&& typeof candidate.details === "object");
	const continuationDetails = continuation?.type === "custom_message"
		? continuation.details as { task?: { id?: unknown } }
		: undefined;
	return {
		id: header.id,
		cwd: typeof header.cwd === "string" ? header.cwd : "",
		createdAt: typeof header.timestamp === "string" ? header.timestamp : "",
		parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
		name: named?.type === "session_info" ? named.name?.trim() || undefined : undefined,
		continuationTaskId: typeof continuationDetails?.task?.id === "string" ? continuationDetails.task.id : undefined,
		entries,
		branch,
	};
}

function findRoot(record: SessionRecord, byId: Map<string, SessionRecord>): SessionRecord {
	let current = record;
	const seen = new Set<string>();
	while (current.parentId && !seen.has(current.id)) {
		seen.add(current.id);
		const parent = byId.get(current.parentId);
		if (!parent) break;
		current = parent;
	}
	return current;
}

type ProgressReporter = (phase: "scanning" | "parsing" | "organizing" | "saving", completed: number, total: number) => void;

async function scanProject(
	ctx: ExtensionContext,
	force: boolean,
	signal: AbortSignal | undefined,
	report: ProgressReporter,
): Promise<ScanResult> {
	const current = await readProject(ctx.cwd);
	const directory = ctx.sessionManager.getSessionDir();
	const entries = await readdir(directory, { withFileTypes: true });
	const paths = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => canonicalPath(`${directory}/${entry.name}`));
	const existingByPath = new Map(current.sessions.map((session) => [canonicalPath(session.path), session]));
	let statCompleted = 0;
	report("scanning", 0, paths.length);
	const statResults = await mapConcurrent(paths, FILE_CONCURRENCY, async (path): Promise<FileStatResult> => {
		try {
			signal?.throwIfAborted();
			return { path, stats: await stat(path) };
		} catch (error) {
			if (signal?.aborted) throw error;
			return { path };
		} finally {
			report("scanning", ++statCompleted, paths.length);
		}
	});
	const statByPath = new Map(statResults.map((result) => [result.path, result.stats]));
	const changedFiles = statResults.filter((result) => {
		if (!result.stats) return false;
		const existing = existingByPath.get(result.path);
		const fingerprint = current.fingerprints[result.path];
		return force || !existing || fingerprint?.mtimeMs !== result.stats.mtimeMs || fingerprint.size !== result.stats.size;
	});

	let parseCompleted = 0;
	let parseTotal = changedFiles.length;
	report("parsing", 0, parseTotal);
	const parsedByPath = new Map<string, ParsedSession>();
	await mapConcurrent(changedFiles, FILE_CONCURRENCY, async ({ path }) => {
		try {
			const parsed = await parseSession(path, signal);
			parsedByPath.set(path, parsed);
		} catch (error) {
			if (signal?.aborted) throw error;
		} finally {
			report("parsing", ++parseCompleted, parseTotal);
		}
	});

	const fingerprints: Record<string, FileFingerprint> = {};
	const records: SessionRecord[] = [];
	const changedIds = new Set<string>();
	const seenPaths = new Set<string>();
	for (const { path, stats } of statResults) {
		if (!stats) continue;
		const fingerprint = { mtimeMs: stats.mtimeMs, size: stats.size };
		const previousFingerprint = current.fingerprints[path];
		const existing = existingByPath.get(path);
		const unchanged =
			!force &&
			existing &&
			previousFingerprint?.mtimeMs === fingerprint.mtimeMs &&
			previousFingerprint?.size === fingerprint.size;
		if (unchanged) {
			seenPaths.add(path);
			fingerprints[path] = fingerprint;
			records.push(existing);
			continue;
		}
		const parsed = parsedByPath.get(path);
		if (!parsed || canonicalPath(parsed.cwd) !== canonicalPath(ctx.cwd)) {
			if (!parsed && existing) records.push(existing);
			continue;
		}
		seenPaths.add(path);
		fingerprints[path] = fingerprint;
		const card = buildCard(parsed, stats.mtime.toISOString());
		const record: SessionRecord = {
			id: parsed.id,
			path,
			cwd: canonicalPath(ctx.cwd),
			title: existing?.title,
			taskId: existing?.taskId ?? parsed.continuationTaskId,
			parentPath: card.parentSession ? canonicalPath(card.parentSession) : undefined,
			parentId: existing?.parentId,
			rootSessionId: existing?.rootSessionId,
			kind: existing?.kind ?? (parsed.continuationTaskId ? "continuation" : "session"),
			forkPoint: existing?.forkPoint,
			confidence: existing?.confidence,
			lastHandoffLeafId: existing?.lastHandoffLeafId,
			locked: existing?.locked ?? false,
			createdAt: card.createdAt,
			updatedAt: card.updatedAt,
			card,
		};
		records.push(record);
		changedIds.add(record.id);
	}

	const supportPaths = [...new Set(records
		.filter((record) => changedIds.has(record.id) && record.parentPath && !parsedByPath.has(record.parentPath))
		.map((record) => record.parentPath!))]
		.filter((path) => statByPath.has(path));
	if (supportPaths.length > 0) {
		parseTotal += supportPaths.length;
		report("parsing", parseCompleted, parseTotal);
		await mapConcurrent(supportPaths, FILE_CONCURRENCY, async (path) => {
			try {
				parsedByPath.set(path, await parseSession(path, signal));
			} catch (error) {
				if (signal?.aborted) throw error;
			} finally {
				report("parsing", ++parseCompleted, parseTotal);
			}
		});
	}

	const byPath = new Map(records.map((record) => [canonicalPath(record.path), record]));
	const byId = new Map(records.map((record) => [record.id, record]));
	for (const record of records) {
		const parent = record.parentPath ? byPath.get(canonicalPath(record.parentPath)) : undefined;
		record.parentId = parent?.id;
		if (!parent) {
			record.kind = "session";
			record.rootSessionId = record.id;
			continue;
		}
		record.rootSessionId = findRoot(parent, byId).id;
		if (!changedIds.has(record.id)) continue;
		const child = parsedByPath.get(record.path);
		const parsedParent = parsedByPath.get(parent.path);
		if (child?.continuationTaskId) {
			record.kind = "continuation";
			record.taskId = child.continuationTaskId;
			continue;
		}
		if (!child || !parsedParent) {
			record.kind = "fork";
			continue;
		}
		const parentIds = new Set(parsedParent.entries.map((entry) => entry.id));
		const common = child.branch.filter((entry) => parentIds.has(entry.id)).at(-1);
		const childCreated = Date.parse(child.createdAt || record.createdAt);
		const parentTailAtCreation = parsedParent.branch
			.filter((entry) => Date.parse(entry.timestamp) <= childCreated)
			.at(-1);
		record.forkPoint = common?.id;
		record.kind = common && common.id === parentTailAtCreation?.id ? "clone" : "fork";
	}

	return {
		project: { ...current, sessions: records, fingerprints },
		changedIds,
		scanned: seenPaths.size,
	};
}

function parseAiJson(text: string): AiResult {
	const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The model did not return JSON");
	const value = JSON.parse(unfenced.slice(start, end + 1)) as Partial<AiResult>;
	return {
		sessions: Array.isArray(value.sessions) ? value.sessions : [],
		branches: Array.isArray(value.branches) ? value.branches : [],
	};
}

function buildPrompt(
	roots: SessionRecord[],
	branches: SessionRecord[],
	tasks: TaskRecord[],
): string {
	const cards = [...roots, ...branches].map((session) => ({
		id: session.id,
		kind: session.kind,
		parentId: session.parentId,
		forkPoint: session.forkPoint,
		card: session.card,
	}));
	return [
		"Organize Pi sessions from one project into a virtual Task → Session → Fork/Clone tree.",
		"Return JSON only. Do not invent nested subtasks.",
		"For every kind=session item, return a concise sessionTitle, a task assignment, a concise taskTitle, and confidence 0..1.",
		"Use an existing task id when it fits. For a new grouping, use the same taskId value new:<short-key> for all matching sessions.",
		"For every fork/clone/continuation item, return only a concise branchTitle; its task is inherited from its parent.",
		"Titles should describe the actual work, not generic phrases such as 'Coding session'. Preserve the language used in the card when practical.",
		'Exact schema: {"sessions":[{"id":"...","sessionTitle":"...","taskId":"existing-id or new:key","taskTitle":"...","confidence":0.8}],"branches":[{"id":"...","branchTitle":"..."}]}',
		`Existing tasks: ${JSON.stringify(tasks.map(({ id, title }) => ({ id, title })))}`,
		`Session cards: ${JSON.stringify(cards)}`,
	].join("\n\n");
}

async function classifyBatch(
	ctx: ExtensionContext,
	roots: SessionRecord[],
	branches: SessionRecord[],
	tasks: TaskRecord[],
	signal?: AbortSignal,
): Promise<AiResult> {
	if (!ctx.model) throw new Error("No active model is available for task organization");
	if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("The active model has no configured authentication");
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: buildPrompt(roots, branches, tasks) }],
		timestamp: Date.now(),
	};
	const response = await ctx.modelRegistry.complete(
		ctx.model,
		{ messages: [message] },
		{ signal, cacheRetention: "none", sessionId: randomUUID() },
	);
	if (response.stopReason === "aborted") throw new Error("Task organization was cancelled");
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return parseAiJson(text);
}

function ensureUnclassified(tasks: TaskRecord[]): TaskRecord {
	let task = tasks.find((item) => item.id === UNCLASSIFIED_TASK_ID);
	if (!task) {
		const now = new Date().toISOString();
		task = { id: UNCLASSIFIED_TASK_ID, title: "Unclassified", locked: false, createdAt: now, updatedAt: now };
		tasks.push(task);
	}
	return task;
}

function cleanTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const title = compactText(value, 90);
	return title || undefined;
}

export async function organizeProject(
	ctx: ExtensionContext,
	force: boolean,
	signal?: AbortSignal,
	onProgress?: OrganizeProgressCallback,
): Promise<OrganizeResult> {
	const startedAt = Date.now();
	const report: ProgressReporter = (phase, completed, total) => {
		onProgress?.({ phase, completed, total, elapsedMs: Date.now() - startedAt });
	};
	const scan = await scanProject(ctx, force, signal, report);
	const project = scan.project;
	const initialTaskIds = new Set(project.tasks.map((task) => task.id));
	const byId = new Map(project.sessions.map((session) => [session.id, session]));
	const roots = project.sessions.filter((session) => !session.parentId);
	const branches = project.sessions.filter((session) => Boolean(session.parentId));
	const rootCandidates = roots.filter(
		(session) => !session.locked && (force || scan.changedIds.has(session.id) || !session.title || !session.taskId),
	);
	const branchCandidates = branches.filter(
		(session) => !session.locked && (force || scan.changedIds.has(session.id) || !session.title),
	);
	let classified = 0;

	const candidates = [...rootCandidates, ...branchCandidates];
	const batchTotal = Math.ceil(candidates.length / BATCH_SIZE);
	const newTaskIds = new Map<string, string>();
	if (batchTotal === 0) report("organizing", 0, 0);
	for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
		signal?.throwIfAborted();
		const batchNumber = Math.floor(offset / BATCH_SIZE) + 1;
		report("organizing", batchNumber, batchTotal);
		const batch = candidates.slice(offset, offset + BATCH_SIZE);
		const rootBatch = batch.filter((session) => !session.parentId);
		const branchBatch = batch.filter((session) => Boolean(session.parentId));
		const result = await classifyBatch(ctx, rootBatch, branchBatch, project.tasks, signal);

		for (const item of result.sessions) {
			const session = byId.get(item.id);
			if (!session || session.parentId || session.locked || !rootBatch.includes(session)) continue;
			const sessionTitle = cleanTitle(item.sessionTitle);
			if (sessionTitle) session.title = sessionTitle;
			const confidence = Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0;
			session.confidence = confidence;
			if (confidence < MIN_CONFIDENCE) {
				session.taskId = ensureUnclassified(project.tasks).id;
				classified++;
				continue;
			}
			let task = project.tasks.find((candidate) => candidate.id === item.taskId);
			if (!task && typeof item.taskId === "string" && item.taskId.startsWith("new:")) {
				let taskId = newTaskIds.get(item.taskId);
				if (!taskId) {
					taskId = randomUUID();
					newTaskIds.set(item.taskId, taskId);
					const now = new Date().toISOString();
					task = {
						id: taskId,
						title: cleanTitle(item.taskTitle) ?? "Untitled task",
						locked: false,
						createdAt: now,
						updatedAt: now,
					};
					project.tasks.push(task);
				} else task = project.tasks.find((candidate) => candidate.id === taskId);
			}
			if (!task) task = ensureUnclassified(project.tasks);
			if (!task.locked) {
				const taskTitle = cleanTitle(item.taskTitle);
				if (taskTitle) task.title = taskTitle;
				task.updatedAt = new Date().toISOString();
			}
			session.taskId = task.id;
			classified++;
		}

		for (const item of result.branches) {
			const session = byId.get(item.id);
			if (!session?.parentId || session.locked || !branchBatch.includes(session)) continue;
			const title = cleanTitle(item.branchTitle);
			if (title) session.title = title;
			classified++;
		}
	}

	for (const root of roots) {
		if (!root.title) root.title = root.card.originalName ?? compactText(root.card.firstUserMessage ?? basename(root.path), 90);
		if (!root.taskId) root.taskId = ensureUnclassified(project.tasks).id;
		root.rootSessionId = root.id;
	}
	for (const branch of branches) {
		const root = findRoot(branch, byId);
		branch.rootSessionId = root.id;
		branch.taskId = root.taskId ?? ensureUnclassified(project.tasks).id;
		if (!branch.title) {
			const kind = branch.kind === "continuation" ? "Continuation" : branch.kind === "clone" ? "Clone" : "Fork";
			branch.title = branch.card.originalName ?? `${kind} ${branch.id.slice(-6)}`;
		}
	}

	const usedTasks = new Set(project.sessions.map((session) => session.taskId).filter(Boolean));
	project.tasks = project.tasks.filter((task) => usedTasks.has(task.id));
	project.lastOrganizedAt = new Date().toISOString();

	report("saving", 0, 1);
	await updateProject(ctx.cwd, (latest) => {
		// Manual edits made while the model was running win over automatic output.
		const latestSessions = new Map(latest.sessions.map((session) => [session.id, session]));
		for (const session of project.sessions) {
			const manual = latestSessions.get(session.id);
			if (manual?.locked) {
				session.title = manual.title;
				session.taskId = manual.taskId;
				session.locked = true;
			}
		}
		// A manual move/merge locks the root; reapply that root assignment to every descendant.
		const committedById = new Map(project.sessions.map((session) => [session.id, session]));
		for (const branch of project.sessions.filter((session) => Boolean(session.parentId))) {
			const root = findRoot(branch, committedById);
			branch.rootSessionId = root.id;
			branch.taskId = root.taskId;
		}
		const latestTasks = new Map(latest.tasks.map((task) => [task.id, task]));
		for (const task of project.tasks) {
			const manual = latestTasks.get(task.id);
			if (manual?.locked) Object.assign(task, manual);
		}
		const committedTaskIds = new Set(project.sessions.map((session) => session.taskId).filter(Boolean));
		project.tasks = project.tasks.filter(
			(task) => committedTaskIds.has(task.id) && (!initialTaskIds.has(task.id) || latestTasks.has(task.id)),
		);
		latest.sessions = project.sessions;
		latest.tasks = project.tasks;
		latest.fingerprints = project.fingerprints;
		latest.lastOrganizedAt = project.lastOrganizedAt;
	});

	return { scanned: scan.scanned, changed: scan.changedIds.size, classified };
}
