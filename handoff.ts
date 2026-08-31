import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	CUSTOM_TYPE,
	GENERATED_MARKER_PREFIX,
	activeMonitors,
	checkpointMarkdown,
	collectAuthority,
	compactText,
	continuationPrompt,
	generateCheckpoint,
	referencedAuthority,
	waitingPrompt,
	type ContinuationCheckpoint,
} from "./checkpoint.ts";
import {
	listHandoffJournals,
	targetExists,
	writeHandoffJournal,
	type HandoffJournal,
} from "./handoff-journal.ts";
import { currentSession, ensureSessionIdentity } from "./identity.ts";
import { canonicalPath, readProject, updateProject } from "./store.ts";
import type { SessionRecord, TaskRecord } from "./types.ts";

export { isGeneratedHandoffMessage } from "./checkpoint.ts";

const AUTO_HANDOFF_PERCENT = 35;

type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

const operationsKey = Symbol.for("pi-task-manager.handoff-operations");
type OperationHolder = typeof globalThis & { [operationsKey]?: Set<string> };

function activeOperations(): Set<string> {
	const holder = globalThis as OperationHolder;
	return holder[operationsKey] ??= new Set<string>();
}

export function isHandoffReplacement(previousSessionFile?: string): boolean {
	return Boolean(previousSessionFile && activeOperations().has(canonicalPath(previousSessionFile)));
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function targetHasContinuationPrompt(path: string, handoffId: string): Promise<boolean> {
	try {
		return (await readFile(path, "utf8")).includes(`${GENERATED_MARKER_PREFIX}${handoffId}:`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function verifyTargetSession(path: string, sessionId: string, handoffId: string): Promise<void> {
	const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
	if (lines.length < 2) throw new Error("The continuation Session file is incomplete");
	const header = JSON.parse(lines[0]!) as { type?: unknown; id?: unknown };
	if (header.type !== "session" || header.id !== sessionId) throw new Error("The continuation Session header does not match the transaction");
	const found = lines.slice(1).some((line) => {
		try {
			const entry = JSON.parse(line) as { type?: unknown; customType?: unknown; details?: { source?: { handoffId?: unknown } } };
			return entry.type === "custom_message" && entry.customType === CUSTOM_TYPE && entry.details?.source?.handoffId === handoffId;
		} catch {
			return false;
		}
	});
	if (!found) throw new Error("The continuation checkpoint was not persisted");
}

async function commitHandoff(journal: HandoffJournal): Promise<void> {
	const checkpoint = journal.checkpoint;
	if (!checkpoint) throw new Error("The handoff journal has no checkpoint to commit");
	await updateProject(journal.source.cwd, (project) => {
		let task = project.tasks.find((item) => item.id === checkpoint.task.taskId);
		if (!task) {
			task = {
				id: checkpoint.task.taskId,
				title: checkpoint.task.title,
				objective: checkpoint.state.objective,
				provisional: checkpoint.task.provisional,
				locked: false,
				createdAt: checkpoint.source.createdAt,
				updatedAt: checkpoint.source.createdAt,
			};
			project.tasks.push(task);
		}
		task.objective ??= checkpoint.state.objective;
		const source = project.sessions.find((item) => item.id === journal.source.sessionId);
		if (source) source.lastHandoffLeafId = journal.source.leafId;
		if (journal.target) {
			project.sessions = project.sessions.filter((item) => item.id !== journal.target!.record.id);
			project.sessions.push(journal.target.record);
		}
	});
	journal.state = "COMMITTED";
	journal.error = undefined;
	await writeHandoffJournal(journal);
}

async function recoverPersistedHandoff(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const path = ctx.sessionManager.getSessionFile();
	if (!path) return;
	const canonical = canonicalPath(path);
	const journals = await listHandoffJournals();
	for (const journal of journals) {
		if (journal.state !== "SWITCHING" || journal.ownerPid === process.pid || !journal.target) continue;
		if (canonicalPath(journal.target.sessionPath) !== canonical || !(await targetExists(journal))) continue;
		await verifyTargetSession(journal.target.sessionPath, journal.target.sessionId, journal.handoffId);
		await commitHandoff(journal);
		const prompt = journal.checkpoint
			? continuationPrompt(journal.checkpoint) ?? waitingPrompt(journal.checkpoint)
			: undefined;
		if (prompt && !(await targetHasContinuationPrompt(journal.target.sessionPath, journal.handoffId))) {
			setImmediate(() => pi.sendUserMessage(prompt, { deliverAs: "followUp" }));
		}
		if (ctx.hasUI) ctx.ui.notify(`Recovered handoff ${journal.handoffId}`, "info");
	}
}

async function reusableJournal(sourcePath: string, leafId: string | undefined, focus: string): Promise<HandoffJournal | undefined> {
	const canonical = canonicalPath(sourcePath);
	return (await listHandoffJournals())
		.filter((journal) => journal.state !== "COMMITTED"
			&& canonicalPath(journal.source.sessionPath) === canonical
			&& journal.source.leafId === leafId
			&& (journal.focus ?? "") === focus)
		.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
}

export function registerHandoff(pi: ExtensionAPI): void {
	let autoHandoffQueued = false;

	pi.on("session_start", async (event, ctx) => {
		autoHandoffQueued = false;
		await recoverPersistedHandoff(pi, ctx);
		const path = ctx.sessionManager.getSessionFile();
		if (!path) return;
		// Pi emits session_start before newSession.setup(). The source operation
		// marker is therefore the only safe way to avoid indexing an unprepared target.
		if (isHandoffReplacement(event.previousSessionFile)) return;
		const activeTarget = (await listHandoffJournals()).some((journal) =>
			journal.state === "SWITCHING"
			&& journal.ownerPid === process.pid
			&& journal.target
			&& canonicalPath(journal.target.sessionPath) === canonicalPath(path));
		if (!activeTarget) await ensureSessionIdentity(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (autoHandoffQueued || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const path = ctx.sessionManager.getSessionFile();
		if (path && (await listHandoffJournals()).some((journal) =>
			journal.state === "SWITCHING"
			&& journal.ownerPid === process.pid
			&& journal.target
			&& canonicalPath(journal.target.sessionPath) === canonicalPath(path))) return;
		const identity = await ensureSessionIdentity(ctx);
		if (!identity) return;
		const project = await readProject(ctx.cwd);
		if (!project.autoHandoff) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent === null || usage?.percent === undefined || usage.percent < AUTO_HANDOFF_PERCENT) return;
		const leafId = ctx.sessionManager.getLeafId() ?? undefined;
		const session = currentSession(project, ctx.sessionManager.getSessionFile());
		if (!session || session.lastHandoffLeafId === leafId || activeOperations().has(session.path)) return;

		autoHandoffQueued = true;
		if (ctx.hasUI) ctx.ui.notify(
			`Context usage reached ${usage.percent.toFixed(1)}%; preparing a handoff`,
			"info",
		);
		setImmediate(() => pi.sendUserMessage("/handoff", { deliverAs: "followUp", expandPromptTemplates: true }));
	});

	pi.registerCommand("handoff-auto", {
		description: "Enable or disable automatic handoff for this project",
		getArgumentCompletions: (prefix) => ["on", "off"]
			.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (!value) {
				const project = await readProject(ctx.cwd);
				ctx.ui.notify(`Automatic handoff is ${project.autoHandoff ? "on" : "off"} (threshold ${AUTO_HANDOFF_PERCENT}%)`, "info");
				return;
			}
			if (value !== "on" && value !== "off") {
				ctx.ui.notify("Usage: /handoff-auto on|off", "error");
				return;
			}
			await updateProject(ctx.cwd, (project) => {
				project.autoHandoff = value === "on";
			});
			autoHandoffQueued = false;
			ctx.ui.notify(`Automatic handoff: ${value}`, "info");
		},
	});

	pi.registerCommand("handoff", {
		description: "Checkpoint this Task and continue it in a durable new Session",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const automatic = autoHandoffQueued;
			autoHandoffQueued = false;
			const sourcePath = ctx.sessionManager.getSessionFile();
			if (!sourcePath) {
				ctx.ui.notify("Handoff requires a persisted source Session", "error");
				return;
			}
			const canonicalSource = canonicalPath(sourcePath);
			if (activeOperations().has(canonicalSource)) {
				ctx.ui.notify("A handoff is already in progress for this Session", "warning");
				return;
			}
			activeOperations().add(canonicalSource);

			let journal: HandoffJournal | undefined;
			try {
				const selectedModel = ctx.model;
				if (!selectedModel) throw new Error("No model selected");
				await ctx.waitForIdle();
				const focus = compactText(args, 1200);
				let sourceLeafId = ctx.sessionManager.getLeafId() ?? undefined;
				const identity = await ensureSessionIdentity(ctx);
				if (!identity) throw new Error("Current Session could not receive a provisional Task identity");
				journal = await reusableJournal(canonicalSource, sourceLeafId, focus);
				if (!journal) {
					const now = new Date().toISOString();
					journal = {
						version: 1,
						handoffId: randomUUID(),
						state: "PREPARING",
						ownerPid: process.pid,
						automatic,
						focus: focus || undefined,
						source: {
							cwd: canonicalPath(ctx.cwd),
							sessionId: identity.session.id,
							sessionPath: canonicalSource,
							leafId: sourceLeafId,
						},
						attempts: 0,
						createdAt: now,
						updatedAt: now,
					};
					await writeHandoffJournal(journal);
				} else {
					journal.ownerPid = process.pid;
					journal.automatic = automatic;
					journal.error = undefined;
					await writeHandoffJournal(journal);
				}

				if (!journal.checkpoint) {
					while (true) {
						const branch = ctx.sessionManager.getBranch();
						const authority = collectAuthority(branch, identity.session.id);
						if (authority.length === 0) throw new Error("No authoritative user message is available to hand off");
						journal.attempts += 1;
						await writeHandoffJournal(journal);
						const generated = await generateCheckpoint(ctx, journal.handoffId, focus, authority);
						if (ctx.sessionManager.getLeafId() === sourceLeafId && ctx.isIdle() && !ctx.hasPendingMessages()) {
							const latestProject = await readProject(ctx.cwd);
							const latestSource = currentSession(latestProject, sourcePath);
							const latestTask = latestSource?.taskId
								? latestProject.tasks.find((task) => task.id === latestSource.taskId)
								: undefined;
							if (!latestSource || !latestTask) throw new Error("Task identity disappeared while preparing the checkpoint");
							const monitors = await activeMonitors(sourcePath);
							journal.checkpoint = {
								schemaVersion: 2,
								source: {
									handoffId: journal.handoffId,
									sessionId: latestSource.id,
									sessionPath: canonicalSource,
									leafId: sourceLeafId,
									createdAt: new Date().toISOString(),
								},
								task: {
									taskId: latestTask.id,
									title: latestTask.title,
									provisional: latestTask.provisional,
								},
								authority: referencedAuthority(generated, authority),
								state: {
									objective: generated.objective,
									completed: generated.completed,
									inProgress: generated.inProgress,
									nextActions: generated.nextActions,
									awaitingUser: generated.awaitingUser,
									files: generated.files,
									verification: generated.verification,
									constraints: generated.constraints,
									activeProcesses: generated.activeProcesses,
									monitors,
								},
							};
							journal.state = "PREPARED";
							await writeHandoffJournal(journal);
							break;
						}
						await ctx.waitForIdle();
						sourceLeafId = ctx.sessionManager.getLeafId() ?? undefined;
						journal.source.leafId = sourceLeafId;
						journal.state = "PREPARING";
						await writeHandoffJournal(journal);
					}
				}

				const checkpoint = journal.checkpoint;
				if (automatic && checkpoint.state.inProgress.length === 0
					&& checkpoint.state.nextActions.length === 0 && checkpoint.state.awaitingUser.length === 0) {
					await commitHandoff(journal);
					ctx.ui.notify("No unfinished work or pending user question was found; staying in this Session", "info");
					return;
				}

				const continueText = continuationPrompt(checkpoint) ?? waitingPrompt(checkpoint);
				const title = compactText(`Continuation · ${identity.session.title ?? checkpoint.task.title}`, 90);
				const sourceCwd = journal.source.cwd;
				const sourceAssignment = identity.session.assignmentSource;
				const sourceRootId = identity.session.rootSessionId ?? identity.session.id;
				const bootstrapModel = { api: selectedModel.api, provider: selectedModel.provider, id: selectedModel.id };
				let setupError: unknown;
				const finishReplacement = async (replacementCtx: ReplacementContext): Promise<void> => {
					if (setupError) {
						journal!.state = "FAILED";
						journal!.error = setupError instanceof Error ? setupError.message : String(setupError);
						await writeHandoffJournal(journal!).catch(() => undefined);
						const message = `Handoff target setup failed: ${journal!.error}`;
						await replacementCtx.switchSession(canonicalSource, {
							withSession: async (sourceCtx) => sourceCtx.ui.notify(message, "error"),
						});
						return;
					}
					let continuationError: unknown;
					if (continueText) {
						try {
							await replacementCtx.sendUserMessage(continueText);
						} catch (error) {
							continuationError = error;
							if (journal!.target && !(await targetHasContinuationPrompt(journal!.target.sessionPath, journal!.handoffId))) {
								try {
									await replacementCtx.sendUserMessage(continueText);
									continuationError = undefined;
								} catch (retryError) {
									continuationError = retryError;
								}
							}
						}
					}
					try {
						await verifyTargetSession(journal!.target!.sessionPath, journal!.target!.sessionId, journal!.handoffId);
						await commitHandoff(journal!);
					} catch (error) {
						journal!.state = "SWITCHING";
						journal!.error = error instanceof Error ? error.message : String(error);
						await writeHandoffJournal(journal!).catch(() => undefined);
						replacementCtx.ui.notify(`Handoff recovery is pending: ${journal!.error}`, "error");
						return;
					}
					if (checkpoint.state.monitors.length > 0) replacementCtx.ui.notify(
						`${checkpoint.state.monitors.length} active monitor(s) were recorded; verify that the task-monitor extension transferred them to this Session`,
						"warning",
					);
					if (continuationError) replacementCtx.ui.notify(
						`Handoff committed, but automatic continuation failed: ${continuationError instanceof Error ? continuationError.message : String(continuationError)}`,
						"error",
					);
					else replacementCtx.ui.notify(
						continueText ? "Handoff committed and continuation started." : "Handoff committed; the new Session is ready.",
						"info",
					);
				};

				let cancelled: boolean;
				if (journal.target && await targetExists(journal)) {
					await verifyTargetSession(journal.target.sessionPath, journal.target.sessionId, journal.handoffId);
					cancelled = (await ctx.switchSession(journal.target.sessionPath, { withSession: finishReplacement })).cancelled;
				} else {
					cancelled = (await ctx.newSession({
						parentSession: canonicalSource,
						setup: async (sessionManager) => {
							try {
								const path = sessionManager.getSessionFile();
								const header = sessionManager.getHeader();
								if (!path || !header) throw new Error("The continuation Session has no durable identity");
								const createdAt = header.timestamp;
								const targetPath = canonicalPath(path);
								const record: SessionRecord = {
									id: sessionManager.getSessionId(),
									path: targetPath,
									cwd: sourceCwd,
									title,
									taskId: checkpoint.task.taskId,
									assignmentSource: sourceAssignment,
									parentPath: canonicalSource,
									parentId: identity.session.id,
									rootSessionId: sourceRootId,
									kind: "continuation",
									confidence: 1,
									locked: false,
									createdAt,
									updatedAt: createdAt,
									card: {
										originalName: title,
										recentUserMessages: [],
										files: checkpoint.state.files,
										createdAt,
										updatedAt: createdAt,
										parentSession: canonicalSource,
										sessionId: sessionManager.getSessionId(),
									},
								};
								journal!.target = { sessionId: record.id, sessionPath: targetPath, record };
								journal!.state = "SWITCHING";
								journal!.attempts += 1;
								await writeHandoffJournal(journal!);
								sessionManager.appendSessionInfo(title);
								sessionManager.appendCustomMessageEntry(CUSTOM_TYPE, checkpointMarkdown(checkpoint), true, checkpoint);
								sessionManager.appendMessage({
									role: "assistant",
									content: [{ type: "text", text: "Continuation checkpoint loaded. The Session is ready." }],
									api: bootstrapModel.api,
									provider: bootstrapModel.provider,
									model: bootstrapModel.id,
									usage: emptyUsage(),
									stopReason: "stop",
									timestamp: Date.now(),
								});
								const entries = sessionManager.getEntries();
								record.card.firstEntryId = entries[0]?.id;
								record.card.latestEntryId = entries.at(-1)?.id;
								await verifyTargetSession(targetPath, record.id, journal!.handoffId);
								await writeHandoffJournal(journal!);
							} catch (error) {
								setupError = error;
							}
						},
						withSession: finishReplacement,
					})).cancelled;
				}
				if (cancelled) {
					journal.state = "FAILED";
					journal.error = "Session switch was cancelled";
					await writeHandoffJournal(journal);
					ctx.ui.notify("Handoff cancelled", "info");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (journal) {
					journal.state = journal.target && await targetExists(journal) ? "SWITCHING" : "FAILED";
					journal.error = message;
					await writeHandoffJournal(journal).catch(() => undefined);
				}
				// A session replacement invalidates the original command context even
				// when setup fails. Never let a second stale-context error escape here.
				try {
					ctx.ui.notify(`Handoff failed: ${message}`, "error");
				} catch {
					console.error(`[pi-task-manager] Handoff failed: ${message}`);
				}
			} finally {
				activeOperations().delete(canonicalSource);
			}
		},
	});
}
