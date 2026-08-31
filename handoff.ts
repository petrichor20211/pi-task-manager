import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { canonicalPath, readProject, updateProject } from "./store.ts";
import type { ProjectIndex, SessionRecord, TaskRecord } from "./types.ts";

const CUSTOM_TYPE = "pi-task-manager-continuation";
const REQUEST_MARKER_PREFIX = "pi-task-manager:checkpoint-request:";
const AUTO_CONTINUE_MARKER = "pi-task-manager:auto-continue";
const READY_MARKER = "pi-task-manager:continuation-ready";
const AUTO_HANDOFF_PERCENT = 35;
const HANDOFF_TIMEOUT_MS = 15 * 60 * 1000;

interface EvidenceItem {
	work: string;
	userEvidence: string;
}

interface CompletedItem {
	fact: string;
	evidence: string;
}

interface ExtractedCheckpoint {
	taskObjective: string;
	activeIntent: {
		request: string;
		expectedOutcome: string;
		userEvidence: string;
	};
	completed: CompletedItem[];
	explicitUnfinished: EvidenceItem[];
	awaitingUser: string[];
	nonBindingNotes: string[];
	files: string[];
	verification: string[];
	constraints: string[];
}

interface ContinuationCheckpoint extends ExtractedCheckpoint {
	schemaVersion: 1;
	task: {
		id: string;
		title: string;
		objective: string;
		locked: boolean;
	};
	source: {
		sessionId: string;
		sessionPath: string;
		leafEntryId?: string;
		checkpointEntryId: string;
		createdAt: string;
	};
}

type HandoffOutcome =
	| { status: "success"; checkpoint: ExtractedCheckpoint }
	| { status: "cancelled" }
	| { status: "error"; message: string };

interface PendingHandoff {
	marker: string;
	authorityTexts: string[];
	resolve: (outcome: HandoffOutcome) => void;
	timeout: ReturnType<typeof setTimeout>;
}

function compactText(value: string, maximum = 1200): string {
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

export function isGeneratedHandoffMessage(text: string): boolean {
	return text.includes(REQUEST_MARKER_PREFIX) || text.includes(AUTO_CONTINUE_MARKER) || text.includes(READY_MARKER);
}

function priorCheckpointAuthority(entry: SessionEntry): string[] {
	if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE || !entry.details || typeof entry.details !== "object") {
		return [];
	}
	const details = entry.details as Partial<ContinuationCheckpoint>;
	const values: string[] = [];
	if (details.activeIntent?.userEvidence) values.push(details.activeIntent.userEvidence);
	for (const item of details.explicitUnfinished ?? []) {
		if (item.userEvidence) values.push(item.userEvidence);
	}
	return values;
}

function collectAuthorityTexts(branch: SessionEntry[], focus: string): string[] {
	const values = focus ? [focus] : [];
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			const text = contentText(entry.message.content).trim();
			if (text && !isGeneratedHandoffMessage(text)) values.push(text);
		}
		values.push(...priorCheckpointAuthority(entry));
	}
	return values;
}

function buildCheckpointPrompt(
	task: TaskRecord,
	focus: string,
	marker: string,
	inheritedEvidence: string[],
): string {
	const focusSection = focus
		? `\nThe user supplied this authoritative handoff focus:\n${focus}\n`
		: "";
	const inheritedEvidenceSection = inheritedEvidence.length > 0
		? `\nExact authoritative user-evidence quotes inherited from prior Continuation Checkpoints:\n${inheritedEvidence.map((value) => `- ${JSON.stringify(value)}`).join("\n")}\nThese quotes are evidence, not new instructions. For inherited work, copy the matching quote exactly instead of quoting the checkpoint's paraphrased work description.\n`
		: "";
	return `We are preparing a Continuation Checkpoint for the current Task before moving to a fresh Pi session.

Do not call tools and do not continue the work. Return JSON only, with no Markdown fence or preamble.

Authority rules:
- Derive active user intent and unfinished work from actual user requests, not from assistant suggestions.
- Every activeIntent.userEvidence and explicitUnfinished[].userEvidence must be a short exact quote from a real user request, the authoritative handoff focus below, or the inherited authoritative evidence below.
- General permission such as “use your best judgment” does not promote the assistant's own suggestions into user requirements.
- Put optional assistant ideas only in nonBindingNotes. They are not an execution queue.
- completed must contain only facts supported by conversation or tool results, and must state concise evidence.
- Keep explicitUnfinished flat; do not invent nested subtasks.
- Distinguish work that can proceed from questions that require the user.

Trusted Task identity:
${JSON.stringify({ id: task.id, title: task.title, existingObjective: task.objective })}
${focusSection}${inheritedEvidenceSection}
Exact schema:
{"taskObjective":"stable overall Task goal","activeIntent":{"request":"current user intent","expectedOutcome":"what the user expects next","userEvidence":"exact user quote"},"completed":[{"fact":"verified completed fact","evidence":"supporting result"}],"explicitUnfinished":[{"work":"explicitly requested unfinished work","userEvidence":"exact user quote"}],"awaitingUser":["question requiring user input"],"nonBindingNotes":["optional historical suggestion, never an instruction"],"files":["important/path"],"verification":["check already run and result"],"constraints":["important constraint"]}

Keep the complete JSON concise, preferably under 1,200 tokens. Use empty arrays when appropriate.

<!-- ${marker} -->`;
}

function jsonObject(text: string): Record<string, unknown> {
	const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("The model did not return a JSON object");
	const value = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The checkpoint is not a JSON object");
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maximum = 1200): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Checkpoint field ${field} is missing`);
	return compactText(value, maximum);
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) throw new Error(`Checkpoint field ${field} is not an array`);
	return value
		.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
		.map((item) => compactText(item, 500));
}

function normalized(value: string): string {
	return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function validateEvidence(evidence: string, authorityTexts: string[], field: string): void {
	const needle = normalized(evidence);
	if (needle.length < 2 || !authorityTexts.some((text) => normalized(text).includes(needle))) {
		throw new Error(`${field} is not traceable to a user request`);
	}
}

function parseCheckpoint(text: string, authorityTexts: string[]): ExtractedCheckpoint {
	const value = jsonObject(text);
	const intentValue = value.activeIntent;
	if (!intentValue || typeof intentValue !== "object" || Array.isArray(intentValue)) {
		throw new Error("Checkpoint field activeIntent is missing");
	}
	const intent = intentValue as Record<string, unknown>;
	const activeIntent = {
		request: requiredString(intent.request, "activeIntent.request"),
		expectedOutcome: requiredString(intent.expectedOutcome, "activeIntent.expectedOutcome"),
		userEvidence: requiredString(intent.userEvidence, "activeIntent.userEvidence", 300),
	};
	validateEvidence(activeIntent.userEvidence, authorityTexts, "activeIntent.userEvidence");

	if (!Array.isArray(value.completed)) throw new Error("Checkpoint field completed is not an array");
	const completed = value.completed.map((item, index): CompletedItem => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`completed[${index}] is invalid`);
		const record = item as Record<string, unknown>;
		return {
			fact: requiredString(record.fact, `completed[${index}].fact`, 500),
			evidence: requiredString(record.evidence, `completed[${index}].evidence`, 500),
		};
	});

	if (!Array.isArray(value.explicitUnfinished)) throw new Error("Checkpoint field explicitUnfinished is not an array");
	const explicitUnfinished = value.explicitUnfinished.map((item, index): EvidenceItem => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`explicitUnfinished[${index}] is invalid`);
		const record = item as Record<string, unknown>;
		const result = {
			work: requiredString(record.work, `explicitUnfinished[${index}].work`, 500),
			userEvidence: requiredString(record.userEvidence, `explicitUnfinished[${index}].userEvidence`, 300),
		};
		validateEvidence(result.userEvidence, authorityTexts, `explicitUnfinished[${index}].userEvidence`);
		return result;
	});

	return {
		taskObjective: requiredString(value.taskObjective, "taskObjective"),
		activeIntent,
		completed,
		explicitUnfinished,
		awaitingUser: stringArray(value.awaitingUser, "awaitingUser"),
		nonBindingNotes: stringArray(value.nonBindingNotes, "nonBindingNotes"),
		files: stringArray(value.files, "files"),
		verification: stringArray(value.verification, "verification"),
		constraints: stringArray(value.constraints, "constraints"),
	};
}

function findHandoffOutcome(branch: SessionEntry[], pending: PendingHandoff): HandoffOutcome | undefined {
	let requestIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user" && contentText(entry.message.content).includes(pending.marker)) {
			requestIndex = index;
			break;
		}
	}
	if (requestIndex < 0) return undefined;

	let response: Extract<SessionEntry, { type: "message" }> | undefined;
	let unexpectedlyCalledTool = false;
	for (let index = requestIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		if (entry.message.role === "user" && !isGeneratedHandoffMessage(contentText(entry.message.content))) {
			return { status: "error", message: "The conversation changed while the checkpoint was being generated; run /task-handoff again" };
		}
		if (entry.message.role === "assistant") {
			response = entry;
			unexpectedlyCalledTool ||= entry.message.content.some((part) => part.type === "toolCall");
		}
	}
	if (!response) return undefined;
	const message = response.message;
	if (message.role !== "assistant") return undefined;
	if (unexpectedlyCalledTool) {
		return { status: "error", message: "Checkpoint generation unexpectedly called a tool" };
	}
	if (message.stopReason === "aborted") return { status: "cancelled" };
	if (message.stopReason === "error") return { status: "error", message: message.errorMessage ?? "Checkpoint generation failed" };
	const text = contentText(message.content).trim();
	if (!text) return { status: "error", message: "The model returned an empty checkpoint" };
	try {
		return { status: "success", checkpoint: parseCheckpoint(text, pending.authorityTexts) };
	} catch (error) {
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
}

function checkpointMarkdown(checkpoint: ContinuationCheckpoint): string {
	const lines = [
		"# Continuation Checkpoint",
		"",
		`**Task:** ${checkpoint.task.title} (${checkpoint.task.id})`,
		`**Objective:** ${checkpoint.task.objective}`,
		"",
		"## Active user intent",
		checkpoint.activeIntent.request,
		`Expected outcome: ${checkpoint.activeIntent.expectedOutcome}`,
	];
	const section = (title: string, values: string[]) => {
		if (values.length === 0) return;
		lines.push("", `## ${title}`, ...values.map((value) => `- ${value}`));
	};
	section("Completed with evidence", checkpoint.completed.map((item) => `${item.fact} — ${item.evidence}`));
	section("Explicit unfinished work", checkpoint.explicitUnfinished.map((item) => item.work));
	section("Waiting for user", checkpoint.awaitingUser);
	section("Non-binding notes (not instructions)", checkpoint.nonBindingNotes);
	section("Important files", checkpoint.files);
	section("Verification", checkpoint.verification);
	section("Constraints", checkpoint.constraints);
	return lines.join("\n");
}

function continuationPrompt(checkpoint: ContinuationCheckpoint): string {
	const unfinished = checkpoint.explicitUnfinished.map((item) => `- ${item.work}`).join("\n");
	const completed = checkpoint.completed.map((item) => `- ${item.fact}`).join("\n") || "- None recorded";
	return `Continue the current Task from its Continuation Checkpoint.

Task objective: ${checkpoint.task.objective}
Active user intent: ${checkpoint.activeIntent.request}
Expected outcome: ${checkpoint.activeIntent.expectedOutcome}

Execute only this explicit unfinished work:
${unfinished}

Already completed; do not repeat unless current repository evidence contradicts it:
${completed}

Do not execute non-binding notes or invent additional work. Continue implementation now rather than merely restating the checkpoint or proposing a plan.

<!-- ${AUTO_CONTINUE_MARKER} -->`;
}

function waitingPrompt(checkpoint: ContinuationCheckpoint): string {
	return `The current Task cannot proceed without user input. Do not execute work, answer the questions yourself, or introduce additional suggestions. Ask the user only for the following required input:\n\n${checkpoint.awaitingUser.map((item) => `- ${item}`).join("\n")}\n\n<!-- ${AUTO_CONTINUE_MARKER} -->`;
}

function readyPrompt(): string {
	return `The Continuation Checkpoint has no recorded unfinished work or pending question. Do not execute work or introduce suggestions. Reply briefly that the new session is ready, then wait for the user's next request.\n\n<!-- ${READY_MARKER} -->`;
}

function currentSession(project: ProjectIndex, path?: string): SessionRecord | undefined {
	if (!path) return undefined;
	const canonical = canonicalPath(path);
	return project.sessions.find((session) => canonicalPath(session.path) === canonical);
}

function waitForCheckpoint(
	pi: ExtensionAPI,
	prompt: string,
	marker: string,
	authorityTexts: string[],
	isIdle: boolean,
	setPending: (pending: PendingHandoff | undefined) => void,
): Promise<HandoffOutcome> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			setPending(undefined);
			resolve({ status: "error", message: "Timed out waiting for the checkpoint response" });
		}, HANDOFF_TIMEOUT_MS);
		setPending({ marker, authorityTexts, resolve, timeout });
		pi.sendUserMessage(prompt, isIdle ? undefined : { deliverAs: "followUp" });
	});
}

export function registerHandoff(
	pi: ExtensionAPI,
	organizeIfNeeded?: (ctx: ExtensionCommandContext) => Promise<void>,
): void {
	let pendingHandoff: PendingHandoff | undefined;
	let autoHandoffQueued = false;

	const setPending = (value: PendingHandoff | undefined) => {
		pendingHandoff = value;
	};

	pi.on("session_start", () => {
		autoHandoffQueued = false;
	});

	pi.on("session_shutdown", () => {
		if (!pendingHandoff) return;
		clearTimeout(pendingHandoff.timeout);
		pendingHandoff.resolve({ status: "cancelled" });
		pendingHandoff = undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingHandoff) {
			const outcome = findHandoffOutcome(ctx.sessionManager.getBranch(), pendingHandoff);
			if (!outcome) return;
			const pending = pendingHandoff;
			clearTimeout(pending.timeout);
			pendingHandoff = undefined;
			setImmediate(() => pending.resolve(outcome));
			return;
		}

		if (autoHandoffQueued || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const project = await readProject(ctx.cwd);
		if (!project.autoHandoff) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent === null || usage?.percent === undefined || usage.percent < AUTO_HANDOFF_PERCENT) return;
		const session = currentSession(project, ctx.sessionManager.getSessionFile());
		const leafId = ctx.sessionManager.getLeafId() ?? undefined;
		if (!session || session.lastHandoffLeafId === leafId) return;

		autoHandoffQueued = true;
		if (ctx.hasUI) ctx.ui.notify(
			`Context usage reached ${usage.percent.toFixed(1)}%; preparing a Task continuation`,
			"info",
		);
		setImmediate(() => {
			pi.sendUserMessage("/task-handoff", { deliverAs: "followUp", expandPromptTemplates: true });
		});
	});

	pi.registerCommand("task-handoff-auto", {
		description: "Enable or disable automatic Task continuation for this project",
		getArgumentCompletions: (prefix) => ["on", "off"]
			.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value) {
				const project = await readProject(ctx.cwd);
				ctx.ui.notify(`Automatic Task handoff is ${project.autoHandoff ? "on" : "off"}`, "info");
				return;
			}
			if (value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /task-handoff-auto on|off", "error");
				return;
			}
			await updateProject(ctx.cwd, (project) => {
				project.autoHandoff = value === "on";
			});
			autoHandoffQueued = false;
			ctx.ui.notify(`Automatic Task handoff: ${value}`, "info");
		},
	});

	pi.registerCommand("task-handoff", {
		description: "Create a structured checkpoint and continue the current Task in a new session",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (pendingHandoff) {
				ctx.ui.notify("A Task handoff is already in progress", "warning");
				return;
			}
			const automatic = autoHandoffQueued;
			autoHandoffQueued = false;
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const cwd = ctx.cwd;
			const sourcePath = ctx.sessionManager.getSessionFile();
			let project = await readProject(cwd);
			let sourceSession = currentSession(project, sourcePath);
			let task = project.tasks.find((item) => item.id === sourceSession?.taskId);
			if (sourcePath && (!sourceSession || !task) && organizeIfNeeded) {
				ctx.ui.notify("Current session is not assigned to a Task; organizing before handoff", "info");
				await organizeIfNeeded(ctx);
				project = await readProject(cwd);
				sourceSession = currentSession(project, sourcePath);
				task = project.tasks.find((item) => item.id === sourceSession?.taskId);
			}
			if (!sourcePath || !sourceSession || !task) {
				ctx.ui.notify("Current session could not be assigned to a Task", "warning");
				return;
			}

			const focus = compactText(args, 1200);
			const sourceWorkLeafId = ctx.sessionManager.getLeafId() ?? undefined;
			const branch = ctx.sessionManager.getBranch();
			const inheritedEvidence = [...new Set(branch.flatMap(priorCheckpointAuthority))];
			const authorityTexts = collectAuthorityTexts(branch, focus);
			if (authorityTexts.length === 0) {
				ctx.ui.notify("No user request is available to hand off", "warning");
				return;
			}
			const marker = `${REQUEST_MARKER_PREFIX}${randomUUID()}`;
			const outcome = await waitForCheckpoint(
				pi,
				buildCheckpointPrompt(task, focus, marker, inheritedEvidence),
				marker,
				authorityTexts,
				ctx.isIdle(),
				setPending,
			);
			if (outcome.status === "cancelled") {
				ctx.ui.notify("Task handoff cancelled", "info");
				return;
			}
			if (outcome.status === "error") {
				autoHandoffQueued = false;
				ctx.ui.notify(`Task handoff failed: ${outcome.message}`, "error");
				return;
			}

			const latest = await readProject(cwd);
			const latestSource = currentSession(latest, sourcePath);
			const latestTask = latestSource && latest.tasks.find((item) => item.id === latestSource.taskId);
			if (!latestSource || !latestTask || latestTask.id !== task.id) {
				ctx.ui.notify("Task assignment changed while the checkpoint was being generated; run /task-handoff again", "warning");
				return;
			}
			const checkpointEntryId = ctx.sessionManager.getLeafId();
			if (!checkpointEntryId) {
				ctx.ui.notify("Checkpoint response was not saved", "error");
				return;
			}
			const objective = latestTask.objective ?? outcome.checkpoint.taskObjective;
			const checkpoint: ContinuationCheckpoint = {
				...outcome.checkpoint,
				taskObjective: objective,
				schemaVersion: 1,
				task: {
					id: latestTask.id,
					title: latestTask.title,
					objective,
					locked: latestTask.locked,
				},
				source: {
					sessionId: latestSource.id,
					sessionPath: latestSource.path,
					leafEntryId: sourceWorkLeafId,
					checkpointEntryId,
					createdAt: new Date().toISOString(),
				},
			};

			if (automatic && checkpoint.explicitUnfinished.length === 0 && checkpoint.awaitingUser.length === 0) {
				await updateProject(cwd, (current) => {
					const source = current.sessions.find((item) => item.id === latestSource.id);
					const currentTask = current.tasks.find((item) => item.id === latestTask.id);
					if (source) source.lastHandoffLeafId = checkpointEntryId;
					if (currentTask && !currentTask.objective) currentTask.objective = objective;
				});
				ctx.ui.notify("Checkpoint found no unfinished work or pending user question; staying in this session", "info");
				return;
			}

			const title = compactText(`Continuation · ${latestSource.title ?? latestTask.title}`, 90);
			const statusText = latestTask.title;
			const result = await ctx.newSession({
				parentSession: latestSource.path,
				setup: async (sessionManager) => {
					sessionManager.appendSessionInfo(title);
					sessionManager.appendCustomMessageEntry(
						CUSTOM_TYPE,
						checkpointMarkdown(checkpoint),
						true,
						checkpoint,
					);
					const path = sessionManager.getSessionFile();
					if (!path) throw new Error("The continuation session was not persisted");
					const header = sessionManager.getHeader();
					if (!header) throw new Error("The continuation session has no header");
					const entries = sessionManager.getEntries();
					const createdAt = header.timestamp;
					const record: SessionRecord = {
						id: sessionManager.getSessionId(),
						path: canonicalPath(path),
						cwd: canonicalPath(cwd),
						title,
						taskId: latestTask.id,
						parentPath: canonicalPath(latestSource.path),
						parentId: latestSource.id,
						rootSessionId: latestSource.rootSessionId ?? latestSource.id,
						kind: "continuation",
						confidence: 1,
						locked: false,
						createdAt,
						updatedAt: createdAt,
						card: {
							originalName: title,
							recentUserMessages: [],
							files: checkpoint.files,
							createdAt,
							updatedAt: createdAt,
							parentSession: canonicalPath(latestSource.path),
							sessionId: sessionManager.getSessionId(),
							firstEntryId: entries[0]?.id,
							latestEntryId: entries.at(-1)?.id,
						},
					};
					await updateProject(cwd, (current) => {
						const source = current.sessions.find((item) => item.id === latestSource.id);
						const currentTask = current.tasks.find((item) => item.id === latestTask.id);
						if (source) source.lastHandoffLeafId = checkpointEntryId;
						if (currentTask && !currentTask.objective) currentTask.objective = objective;
						current.sessions = current.sessions.filter((item) => item.id !== record.id);
						current.sessions.push(record);
					});
				},
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setStatus(
						"task-manager",
						replacementCtx.ui.theme.fg("accent", statusText),
					);
					if (checkpoint.explicitUnfinished.length > 0) {
						replacementCtx.ui.notify("Task checkpoint transferred. Continuing explicit unfinished work.", "info");
						await replacementCtx.sendUserMessage(continuationPrompt(checkpoint));
					} else if (checkpoint.awaitingUser.length > 0) {
						replacementCtx.ui.notify("Task checkpoint transferred. Requesting the required user input.", "info");
						await replacementCtx.sendUserMessage(waitingPrompt(checkpoint));
					} else {
						replacementCtx.ui.notify("Task checkpoint transferred to a new session.", "info");
						await replacementCtx.sendUserMessage(readyPrompt());
					}
				},
			});
			if (result.cancelled) ctx.ui.notify("New continuation session cancelled", "info");
		},
	});
}
