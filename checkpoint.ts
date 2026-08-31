import type { UserMessage } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalPath } from "./store.ts";

export const CUSTOM_TYPE = "pi-task-manager-continuation";
export const GENERATED_MARKER_PREFIX = "pi-task-manager:handoff:";
const LEGACY_REQUEST_MARKER = "pi-task-manager:checkpoint-request:";
const LEGACY_AUTO_MARKER = "pi-task-manager:auto-continue";
const LEGACY_READY_MARKER = "pi-task-manager:continuation-ready";
const CHECKPOINT_TIMEOUT_MS = 15 * 60 * 1000;
const CHECKPOINT_ATTEMPTS = 2;

export interface AuthorityMessage {
	entryId: string;
	sessionId: string;
	text: string;
}

export interface CompletedItem {
	fact: string;
	evidence: string;
}

export interface AuthorizedWorkItem {
	work: string;
	evidenceIds: string[];
}

export interface AwaitingUserItem {
	question: string;
	evidenceIds: string[];
}

export interface MonitorSnapshot {
	id: string;
	name: string;
	prompt: string;
	dueAt: string;
	checkCount: number;
	maxChecks: number;
	status: string;
}

export interface ContinuationCheckpoint {
	schemaVersion: 2;
	source: {
		handoffId: string;
		sessionId: string;
		sessionPath: string;
		leafId?: string;
		createdAt: string;
	};
	task: {
		taskId: string;
		title: string;
		provisional: boolean;
	};
	authority: AuthorityMessage[];
	state: {
		objective: string;
		completed: CompletedItem[];
		inProgress: AuthorizedWorkItem[];
		nextActions: AuthorizedWorkItem[];
		awaitingUser: AwaitingUserItem[];
		files: string[];
		verification: string[];
		constraints: string[];
		activeProcesses: string[];
		monitors: MonitorSnapshot[];
	};
}

export interface GeneratedCheckpoint {
	objective: string;
	objectiveEvidenceIds: string[];
	completed: CompletedItem[];
	inProgress: AuthorizedWorkItem[];
	nextActions: AuthorizedWorkItem[];
	awaitingUser: AwaitingUserItem[];
	files: string[];
	verification: string[];
	constraints: string[];
	activeProcesses: string[];
}

export function compactText(value: string, maximum = 1200): string {
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
	return text.includes(GENERATED_MARKER_PREFIX)
		|| text.includes(LEGACY_REQUEST_MARKER)
		|| text.includes(LEGACY_AUTO_MARKER)
		|| text.includes(LEGACY_READY_MARKER);
}

function legacyAuthority(entry: SessionEntry): AuthorityMessage[] {
	if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE || !entry.details || typeof entry.details !== "object") {
		return [];
	}
	const details = entry.details as {
		source?: { sessionId?: unknown };
		authority?: unknown;
		activeIntent?: { userEvidence?: unknown };
		explicitUnfinished?: Array<{ userEvidence?: unknown }>;
	};
	if (Array.isArray(details.authority)) {
		return details.authority.filter((item): item is AuthorityMessage => {
			if (!item || typeof item !== "object") return false;
			const value = item as Partial<AuthorityMessage>;
			return typeof value.entryId === "string" && typeof value.sessionId === "string" && typeof value.text === "string";
		});
	}
	const sessionId = typeof details.source?.sessionId === "string" ? details.source.sessionId : "legacy";
	const texts = [details.activeIntent?.userEvidence, ...(details.explicitUnfinished ?? []).map((item) => item.userEvidence)]
		.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
	return [...new Set(texts)].map((text, index) => ({ entryId: `legacy-${index}`, sessionId, text }));
}

export function collectAuthority(branch: SessionEntry[], sessionId: string): AuthorityMessage[] {
	const byId = new Map<string, AuthorityMessage>();
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			const text = contentText(entry.message.content);
			if (text.trim() && !isGeneratedHandoffMessage(text)) {
				byId.set(entry.id, { entryId: entry.id, sessionId, text });
			}
		}
		for (const authority of legacyAuthority(entry)) byId.set(authority.entryId, authority);
	}
	return [...byId.values()];
}

export async function activeMonitors(sourcePath: string): Promise<MonitorSnapshot[]> {
	try {
		const value = JSON.parse(await readFile(join(getAgentDir(), "task-monitors.json"), "utf8")) as {
			monitors?: Array<Record<string, unknown>>;
		};
		const owner = canonicalPath(sourcePath);
		return (value.monitors ?? []).flatMap((monitor) => {
			if (typeof monitor.ownerSession !== "string" || canonicalPath(monitor.ownerSession) !== owner) return [];
			if (typeof monitor.id !== "string" || typeof monitor.name !== "string" || typeof monitor.prompt !== "string"
				|| typeof monitor.dueAt !== "string" || typeof monitor.checkCount !== "number"
				|| typeof monitor.maxChecks !== "number" || typeof monitor.status !== "string") return [];
			return [{
				id: monitor.id,
				name: monitor.name,
				prompt: monitor.prompt,
				dueAt: monitor.dueAt,
				checkCount: monitor.checkCount,
				maxChecks: monitor.maxChecks,
				status: monitor.status,
			}];
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return [];
	}
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

function stringArray(value: unknown, field: string, maximum = 500): string[] {
	if (!Array.isArray(value)) throw new Error(`Checkpoint field ${field} is not an array`);
	return value.map((item, index) => requiredString(item, `${field}[${index}]`, maximum));
}

function evidenceIds(value: unknown, field: string, allowed: Set<string>): string[] {
	const ids = [...new Set(stringArray(value, field, 200))];
	if (ids.length === 0) throw new Error(`Checkpoint field ${field} has no authority evidence`);
	for (const id of ids) if (!allowed.has(id)) throw new Error(`${field} contains unknown user entry ID ${id}`);
	return ids;
}

function parseWorkItems(value: unknown, field: string, allowed: Set<string>): AuthorizedWorkItem[] {
	if (!Array.isArray(value)) throw new Error(`Checkpoint field ${field} is not an array`);
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${field}[${index}] is invalid`);
		const record = item as Record<string, unknown>;
		return {
			work: requiredString(record.work, `${field}[${index}].work`, 500),
			evidenceIds: evidenceIds(record.evidenceIds, `${field}[${index}].evidenceIds`, allowed),
		};
	});
}

function parseCheckpoint(text: string, authority: AuthorityMessage[]): GeneratedCheckpoint {
	const value = jsonObject(text);
	const allowed = new Set(authority.map((item) => item.entryId));
	if (!Array.isArray(value.completed)) throw new Error("Checkpoint field completed is not an array");
	const completed = value.completed.map((item, index): CompletedItem => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`completed[${index}] is invalid`);
		const record = item as Record<string, unknown>;
		return {
			fact: requiredString(record.fact, `completed[${index}].fact`, 500),
			evidence: requiredString(record.evidence, `completed[${index}].evidence`, 500),
		};
	});
	if (!Array.isArray(value.awaitingUser)) throw new Error("Checkpoint field awaitingUser is not an array");
	const awaitingUser = value.awaitingUser.map((item, index): AwaitingUserItem => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`awaitingUser[${index}] is invalid`);
		const record = item as Record<string, unknown>;
		return {
			question: requiredString(record.question, `awaitingUser[${index}].question`, 500),
			evidenceIds: evidenceIds(record.evidenceIds, `awaitingUser[${index}].evidenceIds`, allowed),
		};
	});
	return {
		objective: requiredString(value.objective, "objective"),
		objectiveEvidenceIds: evidenceIds(value.objectiveEvidenceIds, "objectiveEvidenceIds", allowed),
		completed,
		inProgress: parseWorkItems(value.inProgress, "inProgress", allowed),
		nextActions: parseWorkItems(value.nextActions, "nextActions", allowed),
		awaitingUser,
		files: stringArray(value.files, "files"),
		verification: stringArray(value.verification, "verification"),
		constraints: stringArray(value.constraints, "constraints"),
		activeProcesses: stringArray(value.activeProcesses, "activeProcesses"),
	};
}

function checkpointSystemPrompt(focus: string, authority: AuthorityMessage[], validationError?: string): string {
	const retry = validationError ? `\nThe previous response was rejected: ${validationError}. Correct it without changing the evidence ID rules.\n` : "";
	const focusText = focus ? `\nHandoff focus supplied by the user: ${focus}\nThis focus prioritizes existing authorized work; it is not itself an evidence message.\n` : "";
	return `You generate a structured Continuation Checkpoint from a Pi conversation.

Do not call tools. Return JSON only, with no Markdown fence or preamble.

Authority rules:
- User-message authority is supplied below as immutable entry IDs and verbatim text.
- Describe user intent, but never promote assistant suggestions into requirements.
- objectiveEvidenceIds, inProgress[].evidenceIds, nextActions[].evidenceIds, and awaitingUser[].evidenceIds may contain only supplied entry IDs.
- Every executable or user-blocked item needs at least one evidence ID.
- Completed facts need concise conversation/tool-result evidence, not a user authority ID.
- Put only currently active work in inProgress and concrete remaining work in nextActions.
- Use empty arrays when a section has no items.

Exact schema:
{"objective":"stable task objective","objectiveEvidenceIds":["entry-id"],"completed":[{"fact":"verified completed fact","evidence":"supporting conversation or tool result"}],"inProgress":[{"work":"work currently running","evidenceIds":["entry-id"]}],"nextActions":[{"work":"explicit unfinished action","evidenceIds":["entry-id"]}],"awaitingUser":[{"question":"input genuinely required from the user","evidenceIds":["entry-id"]}],"files":["important/path"],"verification":["check and result"],"constraints":["constraint"],"activeProcesses":["process and durable status/log evidence"]}

Keep the JSON concise, preferably under 1,500 tokens.
${focusText}${retry}
Allowed authority messages:
${JSON.stringify(authority.map(({ entryId, sessionId, text }) => ({ entryId, sessionId, text })))}`;
}

export async function generateCheckpoint(
	ctx: ExtensionCommandContext,
	handoffId: string,
	focus: string,
	authority: AuthorityMessage[],
): Promise<GeneratedCheckpoint> {
	if (!ctx.model) throw new Error("No model selected");
	if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) throw new Error("The active model has no configured authentication");
	const conversation = JSON.stringify(ctx.sessionManager.buildContextEntries());
	let validationError: string | undefined;
	for (let attempt = 0; attempt < CHECKPOINT_ATTEMPTS; attempt++) {
		const request: UserMessage = {
			role: "user",
			content: [{ type: "text", text: `Current effective conversation context:\n\n${conversation}` }],
			timestamp: Date.now(),
		};
		const response = await ctx.modelRegistry.complete(
			ctx.model,
			{ systemPrompt: checkpointSystemPrompt(focus, authority, validationError), messages: [request] },
			{ signal: AbortSignal.timeout(CHECKPOINT_TIMEOUT_MS), cacheRetention: "none", sessionId: `${handoffId}:${attempt + 1}` },
		);
		if (response.stopReason === "aborted") throw new Error("Checkpoint generation was cancelled");
		if (response.stopReason === "error") {
			validationError = response.errorMessage ?? "Checkpoint model request failed";
			continue;
		}
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		try {
			return parseCheckpoint(text, authority);
		} catch (error) {
			validationError = error instanceof Error ? error.message : String(error);
		}
	}
	throw new Error(validationError ?? "Checkpoint generation failed");
}

export function referencedAuthority(generated: GeneratedCheckpoint, authority: AuthorityMessage[]): AuthorityMessage[] {
	const ids = new Set([
		...generated.objectiveEvidenceIds,
		...generated.inProgress.flatMap((item) => item.evidenceIds),
		...generated.nextActions.flatMap((item) => item.evidenceIds),
		...generated.awaitingUser.flatMap((item) => item.evidenceIds),
	]);
	return authority.filter((item) => ids.has(item.entryId));
}

export function checkpointMarkdown(checkpoint: ContinuationCheckpoint): string {
	const lines = [
		"# Continuation Checkpoint",
		"",
		`**Handoff:** ${checkpoint.source.handoffId}`,
		`**Task:** ${checkpoint.task.title} (${checkpoint.task.taskId}${checkpoint.task.provisional ? ", provisional" : ""})`,
		`**Objective:** ${checkpoint.state.objective}`,
	];
	const section = (title: string, values: string[]) => {
		if (values.length > 0) lines.push("", `## ${title}`, ...values.map((value) => `- ${value}`));
	};
	section("Authoritative user messages (verbatim)", checkpoint.authority.map((item) => `[${item.entryId}] ${item.text}`));
	section("Completed with evidence", checkpoint.state.completed.map((item) => `${item.fact} — ${item.evidence}`));
	section("In progress", checkpoint.state.inProgress.map((item) => `${item.work} [${item.evidenceIds.join(", ")}]`));
	section("Next actions", checkpoint.state.nextActions.map((item) => `${item.work} [${item.evidenceIds.join(", ")}]`));
	section("Waiting for user", checkpoint.state.awaitingUser.map((item) => `${item.question} [${item.evidenceIds.join(", ")}]`));
	section("Important files", checkpoint.state.files);
	section("Verification", checkpoint.state.verification);
	section("Constraints", checkpoint.state.constraints);
	section("Active processes", checkpoint.state.activeProcesses);
	section("Active monitors", checkpoint.state.monitors.map((item) => `${item.name} · ${item.status} · due ${item.dueAt} · checks ${item.checkCount}/${item.maxChecks}\n  ${item.prompt}`));
	return lines.join("\n");
}

function authorityText(checkpoint: ContinuationCheckpoint): string {
	return checkpoint.authority.map((item) => `- [${item.entryId}] ${item.text}`).join("\n");
}

export function continuationPrompt(checkpoint: ContinuationCheckpoint): string | undefined {
	const work = [...checkpoint.state.inProgress, ...checkpoint.state.nextActions];
	if (work.length === 0) return undefined;
	const completed = checkpoint.state.completed.map((item) => `- ${item.fact}`).join("\n") || "- None recorded";
	return `Continue the current Task from the durable Continuation Checkpoint.

Objective: ${checkpoint.state.objective}

Execute only these authorized unfinished items:
${work.map((item) => `- ${item.work} [evidence: ${item.evidenceIds.join(", ")}]`).join("\n")}

Authoritative user messages, copied verbatim by the plugin:
${authorityText(checkpoint)}

Already completed; do not repeat unless repository evidence contradicts it:
${completed}

Do not invent additional requirements. Continue the implementation or long-running work now rather than merely restating the checkpoint.

<!-- ${GENERATED_MARKER_PREFIX}${checkpoint.source.handoffId}:continue -->`;
}

export function waitingPrompt(checkpoint: ContinuationCheckpoint): string | undefined {
	if (checkpoint.state.awaitingUser.length === 0) return undefined;
	return `The current Task cannot proceed without user input. Ask only the questions below and do not answer them yourself or introduce new work:

${checkpoint.state.awaitingUser.map((item) => `- ${item.question} [evidence: ${item.evidenceIds.join(", ")}]`).join("\n")}

Authoritative user messages, copied verbatim by the plugin:
${authorityText(checkpoint)}

<!-- ${GENERATED_MARKER_PREFIX}${checkpoint.source.handoffId}:waiting -->`;
}

