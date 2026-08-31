import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContinuationCheckpoint } from "./checkpoint.ts";
import type { SessionRecord } from "./types.ts";

export type HandoffState = "PREPARING" | "PREPARED" | "SWITCHING" | "COMMITTED" | "FAILED";

export interface HandoffJournal {
	version: 1;
	handoffId: string;
	state: HandoffState;
	ownerPid: number;
	automatic: boolean;
	focus?: string;
	source: {
		cwd: string;
		sessionId: string;
		sessionPath: string;
		leafId?: string;
	};
	checkpoint?: ContinuationCheckpoint;
	target?: {
		sessionId: string;
		sessionPath: string;
		record: SessionRecord;
	};
	attempts: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

const JOURNAL_DIR = join(getAgentDir(), "task-manager", "handoffs");

function journalPath(handoffId: string): string {
	return join(JOURNAL_DIR, `${handoffId}.json`);
}

export async function writeHandoffJournal(journal: HandoffJournal): Promise<void> {
	journal.updatedAt = new Date().toISOString();
	const path = journalPath(journal.handoffId);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

export async function readHandoffJournal(handoffId: string): Promise<HandoffJournal | undefined> {
	try {
		const value = JSON.parse(await readFile(journalPath(handoffId), "utf8")) as HandoffJournal;
		return value.version === 1 && value.handoffId === handoffId ? value : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function listHandoffJournals(): Promise<HandoffJournal[]> {
	let names: string[];
	try {
		names = (await readdir(JOURNAL_DIR)).filter((name) => name.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const journals = await Promise.all(names.map(async (name) => {
		try {
			const value = JSON.parse(await readFile(join(JOURNAL_DIR, name), "utf8")) as HandoffJournal;
			return value.version === 1 ? value : undefined;
		} catch {
			return undefined;
		}
	}));
	return journals.filter((value): value is HandoffJournal => Boolean(value));
}

export async function targetExists(journal: HandoffJournal): Promise<boolean> {
	if (!journal.target) return false;
	try {
		return (await stat(journal.target.sessionPath)).isFile();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
