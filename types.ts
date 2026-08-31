export type SessionKind = "session" | "fork" | "clone" | "continuation";
export type AssignmentSource = "provisional" | "organized" | "manual";

export interface SessionCard {
	originalName?: string;
	firstUserMessage?: string;
	recentUserMessages: string[];
	compactionSummary?: string;
	files: string[];
	createdAt: string;
	updatedAt: string;
	parentSession?: string;
	sessionId: string;
	firstEntryId?: string;
	latestEntryId?: string;
}

export interface SessionRecord {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	taskId?: string;
	assignmentSource: AssignmentSource;
	parentPath?: string;
	parentId?: string;
	rootSessionId?: string;
	kind: SessionKind;
	forkPoint?: string;
	confidence?: number;
	lastHandoffLeafId?: string;
	locked: boolean;
	createdAt: string;
	updatedAt: string;
	card: SessionCard;
}

export interface TaskRecord {
	id: string;
	title: string;
	objective?: string;
	provisional: boolean;
	locked: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface FileFingerprint {
	mtimeMs: number;
	size: number;
}

export interface ProjectIndex {
	cwd: string;
	autoOrganize: boolean;
	autoHandoff: boolean;
	lastOrganizedAt?: string;
	tasks: TaskRecord[];
	sessions: SessionRecord[];
	fingerprints: Record<string, FileFingerprint>;
}

export interface TaskManagerIndex {
	version: 2;
	projects: Record<string, ProjectIndex>;
}

export type OrganizePhase = "scanning" | "parsing" | "organizing" | "saving";

export interface OrganizeProgress {
	phase: OrganizePhase;
	completed: number;
	total: number;
	elapsedMs: number;
}

export type OrganizeProgressCallback = (progress: OrganizeProgress) => void;

export interface OrganizeResult {
	scanned: number;
	changed: number;
	classified: number;
}
