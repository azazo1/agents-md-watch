#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type HookCommand =
  | "session-start"
  | "user-prompt"
  | "pre-tool"
  | "post-tool"
  | "stop";
type WatchMode = "warn" | "strict";
type Scope = "global" | "project";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface HookPayload {
  [key: string]: JsonValue;
}

interface HookCliOptions {
  command: HookCommand;
  dbPath?: string;
  mode?: WatchMode;
  projectRoot?: string;
  codexHome?: string;
  stableDelayMs?: number;
}

interface RunHookOptions {
  dbPath: string;
  mode: WatchMode;
  projectRoot?: string;
  codexHome?: string;
  stableDelayMs?: number;
  now?: () => string;
}

interface SessionContext {
  sessionKey: string;
  cwd: string;
  projectRoot: string;
  codexHome: string;
}

interface SessionRow {
  session_key: string;
  cwd: string;
  project_root: string;
  codex_home: string;
}

interface FileSnapshot {
  path: string;
  scope: Scope;
  exists: boolean;
  size: string;
  mtimeNs: string;
  sha256: string;
  signature: string;
  content: string | null;
}

interface TrackedFileRow {
  session_key: string;
  path: string;
  scope: Scope;
  baseline_signature: string;
  baseline_content: string | null;
  last_seen_signature: string;
  last_notified_signature: string | null;
  last_notified_content: string | null;
  last_change_at: string | null;
}

interface InheritedTrackedFileRow {
  path: string;
  scope: Scope;
  baseline_exists: number;
  baseline_size: string;
  baseline_mtime_ns: string;
  baseline_sha256: string;
  baseline_signature: string;
  baseline_content: string | null;
  last_seen_exists: number;
  last_seen_size: string;
  last_seen_mtime_ns: string;
  last_seen_sha256: string;
  last_seen_signature: string;
  last_seen_content: string | null;
  last_notified_signature: string | null;
  last_notified_content: string | null;
  last_change_at: string | null;
}

interface AlertRecord {
  path: string;
  scope: Scope;
  previousSignature: string;
  currentSignature: string;
  previousContent: string | null | undefined;
  currentContent: string | null;
}

interface RunHookResult {
  sessionKey: string;
  alerts: AlertRecord[];
  response: Record<string, JsonValue>;
}

const DEFAULT_MODE: WatchMode = "warn";
const DEFAULT_STABLE_DELAY_MS = 10_000;
const DEFAULT_RETENTION_DAYS = 30;
const DIFF_CONTEXT_LINES = 3;
const LCS_CELL_LIMIT = 1_500_000;
const MAX_DIFF_LINES = 400;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SESSION_ID_KEYS = [
  "sessionId",
  "session_id",
  "runId",
  "run_id",
  "threadId",
  "thread_id",
  "conversationId",
  "conversation_id",
  "taskId",
  "task_id",
];
const CWD_KEYS = ["cwd", "workingDirectory", "workspaceCwd", "workspace_dir"];
const TRANSCRIPT_KEYS = [
  "transcriptPath",
  "transcript_path",
  "logPath",
  "log_path",
];
const PARENT_SESSION_ID_KEYS = [
  "parentSessionId",
  "parent_session_id",
  "parentThreadId",
  "parent_thread_id",
  "sourceSessionId",
  "source_session_id",
  "sourceThreadId",
  "source_thread_id",
  "forkedFromSessionId",
  "forked_from_session_id",
  "forkedFromThreadId",
  "forked_from_thread_id",
  "forkSourceSessionId",
  "fork_source_session_id",
  "forkSourceThreadId",
  "fork_source_thread_id",
  "originalSessionId",
  "original_session_id",
  "originalThreadId",
  "original_thread_id",
];
const PARENT_CONTAINER_KEYS = [
  "parent",
  "source",
  "fork",
  "forkedFrom",
  "forked_from",
  "sourceSession",
  "source_session",
  "sourceThread",
  "source_thread",
  "parentSession",
  "parent_session",
  "parentThread",
  "parent_thread",
];
const PARENT_CONTAINER_ID_KEYS = ["id", ...SESSION_ID_KEYS];

export async function main(argv: string[]): Promise<void> {
  const cliOptions = parseCli(argv);
  const stdinText = await new Response(Bun.stdin.stream()).text();
  const payload = parseHookPayload(stdinText);
  const result = runHook(cliOptions, payload, {
    dbPath: cliOptions.dbPath ?? defaultDbPath(),
    mode: cliOptions.mode ?? DEFAULT_MODE,
    projectRoot: cliOptions.projectRoot,
    codexHome: cliOptions.codexHome,
    stableDelayMs: cliOptions.stableDelayMs ?? DEFAULT_STABLE_DELAY_MS,
  });

  process.stdout.write(`${JSON.stringify(result.response, null, 2)}\n`);
}

export function runHook(
  cliOptions: HookCliOptions,
  payload: HookPayload,
  options: RunHookOptions,
): RunHookResult {
  const db = openDatabase(options.dbPath);

  try {
    ensureSchema(db);

    const session = resolveSessionContext(payload, options);
    const now = (options.now ?? (() => new Date().toISOString()))();
    const stableDelayMs = options.stableDelayMs ?? DEFAULT_STABLE_DELAY_MS;

    switch (cliOptions.command) {
      case "session-start":
        startSession(
          db,
          session,
          now,
          resolveParentSessionKey(payload, session.sessionKey),
        );
        cleanupOldRecords(db, now, session.sessionKey);
        return {
          sessionKey: session.sessionKey,
          alerts: [],
          response: {},
        };
      case "user-prompt":
      case "pre-tool":
      case "post-tool": {
        ensureSessionRow(db, session, now);
        cleanupOldRecords(db, now, session.sessionKey);
        const alerts = checkForChanges(db, session, now, stableDelayMs);
        const response = buildHookResponse(
          alerts,
          cliOptions.command,
          options.mode,
          session.cwd,
        );
        return {
          sessionKey: session.sessionKey,
          alerts,
          response,
        };
      }
      case "stop":
        markSessionStopped(db, session.sessionKey, now);
        cleanupOldRecords(db, now, session.sessionKey);
        return {
          sessionKey: session.sessionKey,
          alerts: [],
          response: {},
        };
      default:
        throw new Error(`Unsupported command: ${String(cliOptions.command)}`);
    }
  } finally {
    db.close();
  }
}

function parseCli(argv: string[]): HookCliOptions {
  const command = argv[2];

  if (
    command !== "session-start" &&
    command !== "user-prompt" &&
    command !== "pre-tool" &&
    command !== "post-tool" &&
    command !== "stop"
  ) {
    throw new Error(
      "Usage: bun agents-md-watch-hook.ts <session-start|user-prompt|pre-tool|post-tool|stop> [--db-path PATH] [--mode warn|strict] [--project-root PATH] [--codex-home PATH] [--stable-delay-seconds SECONDS]",
    );
  }

  const cliOptions: HookCliOptions = {
    command,
    dbPath: process.env.CODEX_AGENTS_WATCH_DB,
    mode: readMode(process.env.CODEX_AGENTS_WATCH_MODE),
    projectRoot: process.env.CODEX_AGENTS_WATCH_PROJECT_ROOT,
    codexHome: process.env.CODEX_HOME,
    stableDelayMs: readStableDelayMs(
      process.env.CODEX_AGENTS_WATCH_STABLE_DELAY_SECONDS,
    ),
  };

  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (flag === "--db-path" && value) {
      cliOptions.dbPath = value;
      index += 1;
      continue;
    }

    if (flag === "--mode" && value) {
      cliOptions.mode = readMode(value);
      index += 1;
      continue;
    }

    if (flag === "--project-root" && value) {
      cliOptions.projectRoot = value;
      index += 1;
      continue;
    }

    if (flag === "--codex-home" && value) {
      cliOptions.codexHome = value;
      index += 1;
      continue;
    }

    if (flag === "--stable-delay-seconds" && value) {
      cliOptions.stableDelayMs = readStableDelayMs(value);
      index += 1;
      continue;
    }
  }

  return cliOptions;
}

function readStableDelayMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Unsupported stable delay seconds: ${value}`);
  }

  return Math.round(seconds * 1000);
}

function readMode(value: string | undefined): WatchMode | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "warn" || value === "strict") {
    return value;
  }

  throw new Error(`Unsupported watch mode: ${value}`);
}

function parseHookPayload(stdinText: string): HookPayload {
  const trimmed = stdinText.trim();

  if (!trimmed) {
    return {};
  }

  const parsed = JSON.parse(trimmed) as unknown;

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as HookPayload;
  }

  return {
    raw: parsed as JsonValue,
  };
}

function openDatabase(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new Database(dbPath);
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      project_root TEXT NOT NULL,
      codex_home TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracked_files (
      session_key TEXT NOT NULL,
      path TEXT NOT NULL,
      scope TEXT NOT NULL,
      baseline_exists INTEGER NOT NULL,
      baseline_size TEXT NOT NULL,
      baseline_mtime_ns TEXT NOT NULL,
      baseline_sha256 TEXT NOT NULL,
      baseline_signature TEXT NOT NULL,
      baseline_content TEXT,
      last_seen_exists INTEGER NOT NULL,
      last_seen_size TEXT NOT NULL,
      last_seen_mtime_ns TEXT NOT NULL,
      last_seen_sha256 TEXT NOT NULL,
      last_seen_signature TEXT NOT NULL,
      last_seen_content TEXT,
      last_notified_signature TEXT,
      last_notified_content TEXT,
      last_change_at TEXT,
      PRIMARY KEY (session_key, path)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      path TEXT NOT NULL,
      scope TEXT NOT NULL,
      previous_signature TEXT NOT NULL,
      current_signature TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS alerts_session_key_idx
      ON alerts (session_key);
  `);
  ensureTrackedFilesContentColumns(db);
}

function ensureTrackedFilesContentColumns(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(tracked_files)").all() as Array<{
    name: string;
  }>;
  const columnNames = new Set(columns.map((column) => column.name));

  for (const columnName of [
    "baseline_content",
    "last_seen_content",
    "last_notified_content",
  ]) {
    if (!columnNames.has(columnName)) {
      db.exec(`ALTER TABLE tracked_files ADD COLUMN ${columnName} TEXT`);
    }
  }
}

function resolveSessionContext(
  payload: HookPayload,
  options: RunHookOptions,
): SessionContext {
  const cwd = resolve(
    options.projectRoot
      ? readCwdFromPayload(payload) ?? options.projectRoot
      : readCwdFromPayload(payload) ?? process.cwd(),
  );
  const projectRoot = resolve(
    options.projectRoot ?? detectProjectRoot(cwd),
  );
  const codexHome = resolve(
    options.codexHome ?? defaultCodexHome(),
  );
  const sessionKey = resolveSessionKey(payload, cwd);

  return {
    sessionKey,
    cwd,
    projectRoot,
    codexHome,
  };
}

function readCwdFromPayload(payload: HookPayload): string | undefined {
  return findFirstString(payload, CWD_KEYS) ?? process.env.PWD ?? undefined;
}

function resolveSessionKey(payload: HookPayload, cwd: string): string {
  const explicit = findFirstString(payload, SESSION_ID_KEYS);

  if (explicit) {
    return explicit;
  }

  const envSession =
    process.env.CODEX_SESSION_ID ??
    process.env.CODEX_RUN_ID ??
    process.env.CODEX_THREAD_ID;

  if (envSession) {
    return envSession;
  }

  const transcriptHint = findFirstString(payload, TRANSCRIPT_KEYS) ?? "";
  const fallbackSeed = `${cwd}\n${transcriptHint}`;

  return `synthetic-${digestText(fallbackSeed).slice(0, 24)}`;
}

function resolveParentSessionKey(
  payload: HookPayload,
  sessionKey: string,
): string | undefined {
  const explicit = findFirstString(payload, PARENT_SESSION_ID_KEYS);

  if (explicit && explicit !== sessionKey) {
    return explicit;
  }

  const nested = findFirstStringInsideContainers(
    payload,
    PARENT_CONTAINER_KEYS,
    PARENT_CONTAINER_ID_KEYS,
  );

  if (nested && nested !== sessionKey) {
    return nested;
  }

  return undefined;
}

function detectProjectRoot(cwd: string): string {
  let current = resolve(cwd);

  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, ".codex"))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return cwd;
    }

    current = parent;
  }
}

function startSession(
  db: Database,
  session: SessionContext,
  now: string,
  parentSessionKey?: string,
): void {
  ensureSessionRow(db, session, now);

  if (
    parentSessionKey &&
    !hasTrackedFiles(db, session.sessionKey) &&
    inheritTrackedFiles(db, parentSessionKey, session)
  ) {
    seedMissingTrackedFiles(db, session);
    return;
  }

  seedSessionBaseline(db, session);
}

function seedSessionBaseline(db: Database, session: SessionContext): void {
  const snapshots = collectSnapshots(session);

  const insertFile = db.prepare(`
    INSERT OR REPLACE INTO tracked_files (
      session_key,
      path,
      scope,
      baseline_exists,
      baseline_size,
      baseline_mtime_ns,
      baseline_sha256,
      baseline_signature,
      baseline_content,
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_seen_content,
      last_notified_signature,
      last_notified_content,
      last_change_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      NULL,
      NULL,
      NULL
    )
  `);

  db.transaction(() => {
    for (const snapshot of snapshots) {
      insertFile.run(...trackedInsertValues(session.sessionKey, snapshot));
    }
  })();
}

function hasTrackedFiles(db: Database, sessionKey: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM tracked_files WHERE session_key = ? LIMIT 1")
    .get(sessionKey) as { found: number } | null;

  return row !== null;
}

function inheritTrackedFiles(
  db: Database,
  parentSessionKey: string,
  session: SessionContext,
): boolean {
  const parentSession = db
    .prepare(
      "SELECT session_key, cwd, project_root, codex_home FROM sessions WHERE session_key = ?",
    )
    .get(parentSessionKey) as SessionRow | null;

  if (!parentSession) {
    return false;
  }

  const rows = db.prepare(`
    SELECT
      path,
      scope,
      baseline_exists,
      baseline_size,
      baseline_mtime_ns,
      baseline_sha256,
      baseline_signature,
      baseline_content,
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_seen_content,
      last_notified_signature,
      last_notified_content,
      last_change_at
    FROM tracked_files
    WHERE session_key = ?
  `).all(parentSessionKey) as InheritedTrackedFileRow[];

  if (rows.length === 0) {
    return false;
  }

  const snapshots = new Map(
    collectSnapshots(session).map((snapshot) => [snapshot.path, snapshot]),
  );
  const insertInherited = db.prepare(`
    INSERT OR REPLACE INTO tracked_files (
      session_key,
      path,
      scope,
      baseline_exists,
      baseline_size,
      baseline_mtime_ns,
      baseline_sha256,
      baseline_signature,
      baseline_content,
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_seen_content,
      last_notified_signature,
      last_notified_content,
      last_change_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const row of rows) {
      const mappedPath = mapInheritedPath(row, parentSession, session);
      const snapshot = snapshots.get(mappedPath);
      const baseline = remapSnapshotState(
        {
          exists: row.baseline_exists,
          size: row.baseline_size,
          mtimeNs: row.baseline_mtime_ns,
          sha256: row.baseline_sha256,
          signature: row.baseline_signature,
          content: row.baseline_content,
        },
        snapshot,
      );
      const lastSeen = remapSnapshotState(
        {
          exists: row.last_seen_exists,
          size: row.last_seen_size,
          mtimeNs: row.last_seen_mtime_ns,
          sha256: row.last_seen_sha256,
          signature: row.last_seen_signature,
          content: row.last_seen_content,
        },
        snapshot,
      );
      const lastNotifiedSignature =
        row.last_notified_signature && contentMatchesSnapshot(
          row.last_notified_content,
          snapshot,
        )
          ? snapshot.signature
          : row.last_notified_signature;

      insertInherited.run(
        session.sessionKey,
        mappedPath,
        row.scope,
        baseline.exists,
        baseline.size,
        baseline.mtimeNs,
        baseline.sha256,
        baseline.signature,
        baseline.content,
        lastSeen.exists,
        lastSeen.size,
        lastSeen.mtimeNs,
        lastSeen.sha256,
        lastSeen.signature,
        lastSeen.content,
        lastNotifiedSignature,
        row.last_notified_content,
        row.last_change_at,
      );
    }
  })();

  return true;
}

function mapInheritedPath(
  row: InheritedTrackedFileRow,
  parentSession: SessionRow,
  session: SessionContext,
): string {
  const parentRoot =
    row.scope === "global"
      ? parentSession.codex_home
      : parentSession.project_root;
  const currentRoot =
    row.scope === "global"
      ? session.codexHome
      : session.projectRoot;
  const pathFromRoot = relative(parentRoot, row.path);

  if (
    pathFromRoot &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${"/"}`) &&
    !isAbsolute(pathFromRoot)
  ) {
    return resolve(currentRoot, pathFromRoot);
  }

  return row.path;
}

function remapSnapshotState(
  state: {
    exists: number;
    size: string;
    mtimeNs: string;
    sha256: string;
    signature: string;
    content: string | null;
  },
  snapshot: FileSnapshot | undefined,
): {
  exists: number;
  size: string;
  mtimeNs: string;
  sha256: string;
  signature: string;
  content: string | null;
} {
  if (!contentMatchesSnapshot(state.content, snapshot)) {
    return state;
  }

  return {
    exists: snapshot.exists ? 1 : 0,
    size: snapshot.size,
    mtimeNs: snapshot.mtimeNs,
    sha256: snapshot.sha256,
    signature: snapshot.signature,
    content: snapshot.content,
  };
}

function contentMatchesSnapshot(
  content: string | null,
  snapshot: FileSnapshot | undefined,
): snapshot is FileSnapshot {
  return snapshot !== undefined && content === snapshot.content;
}

function seedMissingTrackedFiles(db: Database, session: SessionContext): void {
  const snapshots = collectSnapshots(session);
  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO tracked_files (
      session_key,
      path,
      scope,
      baseline_exists,
      baseline_size,
      baseline_mtime_ns,
      baseline_sha256,
      baseline_signature,
      baseline_content,
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_seen_content,
      last_notified_signature,
      last_notified_content,
      last_change_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      NULL,
      NULL,
      NULL
    )
  `);

  db.transaction(() => {
    for (const snapshot of snapshots) {
      insertFile.run(...trackedInsertValues(session.sessionKey, snapshot));
    }
  })();
}

function ensureSessionRow(db: Database, session: SessionContext, now: string): void {
  const existing = db
    .prepare("SELECT session_key FROM sessions WHERE session_key = ?")
    .get(session.sessionKey) as { session_key: string } | null;

  if (existing) {
    db.prepare(
      "UPDATE sessions SET cwd = ?, project_root = ?, codex_home = ?, status = 'active', ended_at = NULL WHERE session_key = ?",
    ).run(session.cwd, session.projectRoot, session.codexHome, session.sessionKey);
    return;
  }

  db.prepare(`
    INSERT INTO sessions (
      session_key,
      cwd,
      project_root,
      codex_home,
      created_at,
      ended_at,
      status
    ) VALUES (?, ?, ?, ?, ?, NULL, 'active')
  `).run(
    session.sessionKey,
    session.cwd,
    session.projectRoot,
    session.codexHome,
    now,
  );
}

function checkForChanges(
  db: Database,
  session: SessionContext,
  now: string,
  stableDelayMs: number,
): AlertRecord[] {
  const snapshots = collectSnapshots(session);
  const selectTracked = db.prepare(`
    SELECT
      session_key,
      path,
      scope,
      baseline_signature,
      baseline_content,
      last_seen_signature,
      last_change_at,
      last_notified_signature,
      last_notified_content
    FROM tracked_files
    WHERE session_key = ? AND path = ?
  `);
  const insertTracked = db.prepare(`
    INSERT INTO tracked_files (
      session_key,
      path,
      scope,
      baseline_exists,
      baseline_size,
      baseline_mtime_ns,
      baseline_sha256,
      baseline_signature,
      baseline_content,
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_seen_content,
      last_notified_signature,
      last_notified_content,
      last_change_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
  `);
  const updateLastSeen = db.prepare(`
    UPDATE tracked_files
    SET
      scope = ?,
      last_seen_exists = ?,
      last_seen_size = ?,
      last_seen_mtime_ns = ?,
      last_seen_sha256 = ?,
      last_seen_signature = ?,
      last_seen_content = ?,
      last_change_at = ?
    WHERE session_key = ? AND path = ?
  `);
  const markAlerted = db.prepare(`
    UPDATE tracked_files
    SET
      last_notified_signature = ?,
      last_notified_content = ?,
      last_change_at = NULL
    WHERE session_key = ? AND path = ?
  `);
  const insertAlert = db.prepare(`
    INSERT INTO alerts (
      session_key,
      path,
      scope,
      previous_signature,
      current_signature,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const alerts: AlertRecord[] = [];

  db.transaction(() => {
    for (const snapshot of snapshots) {
      const existing = selectTracked.get(
        session.sessionKey,
        snapshot.path,
      ) as TrackedFileRow | null;

      if (!existing) {
        insertTracked.run(...trackedInsertValues(session.sessionKey, snapshot));
        continue;
      }

      const previousSignature =
        existing.last_notified_signature ?? existing.baseline_signature;
      const pendingSince = resolvePendingSince(
        existing,
        snapshot,
        previousSignature,
        now,
      );

      updateLastSeen.run(
        snapshot.scope,
        snapshot.exists ? 1 : 0,
        snapshot.size,
        snapshot.mtimeNs,
        snapshot.sha256,
        snapshot.signature,
        snapshot.content,
        pendingSince,
        session.sessionKey,
        snapshot.path,
      );

      if (snapshot.signature === previousSignature) {
        continue;
      }

      if (!pendingSince || !hasStableDelayElapsed(pendingSince, now, stableDelayMs)) {
        continue;
      }

      alerts.push({
        path: snapshot.path,
        scope: existing.scope,
        previousSignature,
        currentSignature: snapshot.signature,
        previousContent: resolvePreviousContent(existing, previousSignature),
        currentContent: snapshot.content,
      });
      markAlerted.run(
        snapshot.signature,
        snapshot.content,
        session.sessionKey,
        snapshot.path,
      );
      insertAlert.run(
        session.sessionKey,
        snapshot.path,
        snapshot.scope,
        previousSignature,
        snapshot.signature,
        now,
      );
    }
  })();

  return alerts;
}

function resolvePendingSince(
  existing: TrackedFileRow,
  currentSnapshot: FileSnapshot,
  previousSignature: string,
  now: string,
): string | null {
  if (currentSnapshot.signature === previousSignature) {
    return null;
  }

  if (
    existing.last_seen_signature === currentSnapshot.signature &&
    existing.last_change_at
  ) {
    return existing.last_change_at;
  }

  const mtime = snapshotMtimeIso(currentSnapshot);

  if (mtime) {
    return mtime;
  }

  return now;
}

function snapshotMtimeIso(snapshot: FileSnapshot): string | null {
  if (!snapshot.exists || snapshot.mtimeNs === "0") {
    return null;
  }

  try {
    const mtimeNs = BigInt(snapshot.mtimeNs);
    const mtimeMs = mtimeNs / 1_000_000n;

    return new Date(Number(mtimeMs)).toISOString();
  } catch {
    return null;
  }
}

function hasStableDelayElapsed(
  pendingSince: string,
  now: string,
  stableDelayMs: number,
): boolean {
  const pendingMs = Date.parse(pendingSince);
  const nowMs = Date.parse(now);

  if (!Number.isFinite(pendingMs) || !Number.isFinite(nowMs)) {
    return false;
  }

  return nowMs - pendingMs >= stableDelayMs;
}

function markSessionStopped(db: Database, sessionKey: string, now: string): void {
  db.prepare(`
    UPDATE sessions
    SET status = 'stopped', ended_at = ?
    WHERE session_key = ?
  `).run(now, sessionKey);
}

function cleanupOldRecords(
  db: Database,
  now: string,
  currentSessionKey: string,
): void {
  const cutoff = retentionCutoffIso(now);

  if (!cutoff) {
    return;
  }

  const oldSessions = db.prepare(`
    SELECT session_key
    FROM sessions
    WHERE session_key != ?
      AND COALESCE(ended_at, created_at) < ?
  `).all(currentSessionKey, cutoff) as Array<{ session_key: string }>;

  if (oldSessions.length === 0) {
    return;
  }

  const deleteTrackedFiles = db.prepare(
    "DELETE FROM tracked_files WHERE session_key = ?",
  );
  const deleteAlerts = db.prepare(
    "DELETE FROM alerts WHERE session_key = ?",
  );
  const deleteSession = db.prepare(
    "DELETE FROM sessions WHERE session_key = ?",
  );

  db.transaction(() => {
    for (const session of oldSessions) {
      deleteTrackedFiles.run(session.session_key);
      deleteAlerts.run(session.session_key);
      deleteSession.run(session.session_key);
    }
  })();

  tryVacuumDatabase(db);
}

function retentionCutoffIso(now: string): string | null {
  const nowMs = Date.parse(now);

  if (!Number.isFinite(nowMs)) {
    return null;
  }

  return new Date(nowMs - DEFAULT_RETENTION_DAYS * MS_PER_DAY).toISOString();
}

function tryVacuumDatabase(db: Database): void {
  try {
    db.exec("VACUUM");
  } catch {
    return;
  }
}

function collectSnapshots(session: SessionContext): FileSnapshot[] {
  const directories = buildDirectoryChain(session.projectRoot, session.cwd);
  const candidates = new Map<string, Scope>();

  candidates.set(join(session.codexHome, "AGENTS.md"), "global");
  candidates.set(join(session.codexHome, "AGENTS.override.md"), "global");

  for (const directory of directories) {
    candidates.set(join(directory, "AGENTS.md"), "project");
    candidates.set(join(directory, "AGENTS.override.md"), "project");
  }

  return [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, scope]) => snapshotFile(filePath, scope));
}

function buildDirectoryChain(projectRoot: string, cwd: string): string[] {
  const chain: string[] = [];
  let current = resolve(cwd);
  const root = resolve(projectRoot);

  while (true) {
    chain.push(current);

    if (current === root) {
      break;
    }

    const parent = dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return chain.reverse();
}

function snapshotFile(filePath: string, scope: Scope): FileSnapshot {
  if (!existsSync(filePath)) {
    return {
      path: resolve(filePath),
      scope,
      exists: false,
      size: "0",
      mtimeNs: "0",
      sha256: "",
      signature: "missing",
      content: null,
    };
  }

  const stats = statSync(filePath, { bigint: true });
  const content = readFileSync(filePath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const size = stats.size.toString();
  const mtimeNs =
    "mtimeNs" in stats ? stats.mtimeNs.toString() : BigInt(Math.floor(stats.mtimeMs * 1_000_000)).toString();

  return {
    path: resolve(filePath),
    scope,
    exists: true,
    size,
    mtimeNs,
    sha256,
    signature: `present:${mtimeNs}:${size}:${sha256}`,
    content: content.toString("utf8"),
  };
}

function trackedInsertValues(
  sessionKey: string,
  snapshot: FileSnapshot,
): Array<string | number | null> {
  return [
    sessionKey,
    snapshot.path,
    snapshot.scope,
    snapshot.exists ? 1 : 0,
    snapshot.size,
    snapshot.mtimeNs,
    snapshot.sha256,
    snapshot.signature,
    snapshot.content,
    snapshot.exists ? 1 : 0,
    snapshot.size,
    snapshot.mtimeNs,
    snapshot.sha256,
    snapshot.signature,
    snapshot.content,
  ];
}

function resolvePreviousContent(
  existing: TrackedFileRow,
  previousSignature: string,
): string | null | undefined {
  if (previousSignature === "missing") {
    return null;
  }

  if (existing.last_notified_signature === previousSignature) {
    return existing.last_notified_content ?? undefined;
  }

  if (existing.baseline_signature === previousSignature) {
    return existing.baseline_content ?? undefined;
  }

  return undefined;
}

function buildHookResponse(
  alerts: AlertRecord[],
  command: HookCommand,
  mode: WatchMode,
  cwd: string,
): Record<string, JsonValue> {
  if (alerts.length === 0) {
    return {};
  }

  const lines = alerts.map((alert) => {
    const displayPath = formatAlertPath(alert, cwd);
    return `- ${alert.scope} ${displayPath}: ${compactSignature(alert.previousSignature)} -> ${compactSignature(alert.currentSignature)}`;
  });
  const diffLines = alerts.flatMap((alert) => {
    const displayPath = formatAlertPath(alert, cwd);

    return [
      `${displayPath} diff:`,
      ...buildUnifiedDiff(
        displayPath,
        alert.previousContent,
        alert.currentContent,
      ),
    ];
  });
  const hookEventName = mapHookEventName(command);
  const title = "检测到当前 session 的 AGENTS 指令文件发生变化";
  const detail = [
    title,
    ...lines,
    ...diffLines,
    "请按最新指令继续后续工作.",
  ].join("\n");
  const response: Record<string, JsonValue> = {
    systemMessage: detail,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: detail,
    },
  };

  if (mode === "strict") {
    if (command === "pre-tool" || command === "user-prompt") {
      response.hookSpecificOutput = {
        hookEventName,
        additionalContext: detail,
        permissionDecision: "deny",
        permissionDecisionReason: "检测到 AGENTS 指令已变化. 请在重新确认新指令后继续.",
      };
    } else if (command === "post-tool") {
      response.continue = false;
      response.stopReason = "检测到 AGENTS 指令已变化. 请在重新确认新指令后继续.";
    }
  }

  return response;
}

function formatAlertPath(alert: AlertRecord, cwd: string): string {
  if (alert.scope === "global") {
    return alert.path;
  }

  return relative(cwd, alert.path) || alert.path;
}

type DiffLineKind = "context" | "add" | "remove";

interface NumberedDiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number;
  newLine: number;
}

function buildUnifiedDiff(
  fileLabel: string,
  previousContent: string | null | undefined,
  currentContent: string | null,
): string[] {
  const previousLabel = previousContent === null ? "/dev/null" : `a/${fileLabel}`;
  const currentLabel = currentContent === null ? "/dev/null" : `b/${fileLabel}`;
  const header = [`--- ${previousLabel}`, `+++ ${currentLabel}`];

  if (previousContent === undefined) {
    return [
      ...header,
      "@@ content unavailable @@",
      "previous content was not stored for this existing session",
    ];
  }

  const previousLines = previousContent === null ? [] : splitDiffLines(previousContent);
  const currentLines = currentContent === null ? [] : splitDiffLines(currentContent);
  const diffLines = buildDiffLines(previousLines, currentLines);

  if (diffLines.every((line) => line.kind === "context")) {
    const emptyStateChanged = previousContent !== currentContent;
    const marker = emptyStateChanged
      ? "@@ empty file state changed @@"
      : "@@ metadata-only change @@";

    return [...header, marker];
  }

  return [...header, ...truncateDiffLines(formatDiffHunks(diffLines))];
}

function splitDiffLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function buildDiffLines(
  previousLines: string[],
  currentLines: string[],
): NumberedDiffLine[] {
  const cellCount = (previousLines.length + 1) * (currentLines.length + 1);

  if (cellCount > LCS_CELL_LIMIT) {
    return buildWindowDiffLines(previousLines, currentLines);
  }

  const lcs = Array.from(
    { length: previousLines.length + 1 },
    () => new Uint32Array(currentLines.length + 1),
  );

  for (let oldIndex = previousLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = currentLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (previousLines[oldIndex] === currentLines[newIndex]) {
        lcs[oldIndex][newIndex] = lcs[oldIndex + 1][newIndex + 1] + 1;
      } else {
        lcs[oldIndex][newIndex] = Math.max(
          lcs[oldIndex + 1][newIndex],
          lcs[oldIndex][newIndex + 1],
        );
      }
    }
  }

  const diffLines: NumberedDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let oldLine = 1;
  let newLine = 1;

  while (oldIndex < previousLines.length && newIndex < currentLines.length) {
    if (previousLines[oldIndex] === currentLines[newIndex]) {
      diffLines.push({
        kind: "context",
        text: previousLines[oldIndex],
        oldLine,
        newLine,
      });
      oldIndex += 1;
      newIndex += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (lcs[oldIndex + 1][newIndex] >= lcs[oldIndex][newIndex + 1]) {
      diffLines.push({
        kind: "remove",
        text: previousLines[oldIndex],
        oldLine,
        newLine: Math.max(0, newLine - 1),
      });
      oldIndex += 1;
      oldLine += 1;
      continue;
    }

    diffLines.push({
      kind: "add",
      text: currentLines[newIndex],
      oldLine: Math.max(0, oldLine - 1),
      newLine,
    });
    newIndex += 1;
    newLine += 1;
  }

  while (oldIndex < previousLines.length) {
    diffLines.push({
      kind: "remove",
      text: previousLines[oldIndex],
      oldLine,
      newLine: Math.max(0, newLine - 1),
    });
    oldIndex += 1;
    oldLine += 1;
  }

  while (newIndex < currentLines.length) {
    diffLines.push({
      kind: "add",
      text: currentLines[newIndex],
      oldLine: Math.max(0, oldLine - 1),
      newLine,
    });
    newIndex += 1;
    newLine += 1;
  }

  return diffLines;
}

function buildWindowDiffLines(
  previousLines: string[],
  currentLines: string[],
): NumberedDiffLine[] {
  let prefixLength = 0;

  while (
    prefixLength < previousLines.length &&
    prefixLength < currentLines.length &&
    previousLines[prefixLength] === currentLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;

  while (
    suffixLength < previousLines.length - prefixLength &&
    suffixLength < currentLines.length - prefixLength &&
    previousLines[previousLines.length - 1 - suffixLength] ===
      currentLines[currentLines.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const diffLines: NumberedDiffLine[] = [];
  const contextStart = Math.max(0, prefixLength - DIFF_CONTEXT_LINES);

  for (let index = contextStart; index < prefixLength; index += 1) {
    diffLines.push({
      kind: "context",
      text: previousLines[index],
      oldLine: index + 1,
      newLine: index + 1,
    });
  }

  for (let index = prefixLength; index < previousLines.length - suffixLength; index += 1) {
    diffLines.push({
      kind: "remove",
      text: previousLines[index],
      oldLine: index + 1,
      newLine: Math.max(0, prefixLength),
    });
  }

  for (let index = prefixLength; index < currentLines.length - suffixLength; index += 1) {
    diffLines.push({
      kind: "add",
      text: currentLines[index],
      oldLine: Math.max(0, prefixLength),
      newLine: index + 1,
    });
  }

  const suffixContextLength = Math.min(suffixLength, DIFF_CONTEXT_LINES);
  const previousSuffixStart = previousLines.length - suffixLength;
  const currentSuffixStart = currentLines.length - suffixLength;

  for (let offset = 0; offset < suffixContextLength; offset += 1) {
    diffLines.push({
      kind: "context",
      text: previousLines[previousSuffixStart + offset],
      oldLine: previousSuffixStart + offset + 1,
      newLine: currentSuffixStart + offset + 1,
    });
  }

  return diffLines;
}

function formatDiffHunks(diffLines: NumberedDiffLine[]): string[] {
  const hunks: string[] = [];
  let index = 0;

  while (index < diffLines.length) {
    while (index < diffLines.length && diffLines[index].kind === "context") {
      index += 1;
    }

    if (index >= diffLines.length) {
      break;
    }

    const hunkStart = Math.max(0, index - DIFF_CONTEXT_LINES);
    let scanIndex = index;
    let lastChangeIndex = index;

    while (scanIndex < diffLines.length) {
      if (diffLines[scanIndex].kind !== "context") {
        lastChangeIndex = scanIndex;
      }

      if (scanIndex - lastChangeIndex > DIFF_CONTEXT_LINES) {
        break;
      }

      scanIndex += 1;
    }

    const hunkEnd = Math.min(
      diffLines.length,
      lastChangeIndex + DIFF_CONTEXT_LINES + 1,
    );
    const hunkLines = diffLines.slice(hunkStart, hunkEnd);

    hunks.push(formatHunkHeader(hunkLines));
    hunks.push(...hunkLines.map(formatDiffLine));
    index = hunkEnd;
  }

  return hunks;
}

function formatHunkHeader(hunkLines: NumberedDiffLine[]): string {
  const oldCount = hunkLines.filter((line) => line.kind !== "add").length;
  const newCount = hunkLines.filter((line) => line.kind !== "remove").length;
  const firstOldLine =
    hunkLines.find((line) => line.kind !== "add")?.oldLine ??
    hunkLines[0]?.oldLine ??
    0;
  const firstNewLine =
    hunkLines.find((line) => line.kind !== "remove")?.newLine ??
    hunkLines[0]?.newLine ??
    0;

  return `@@ -${formatDiffRange(firstOldLine, oldCount)} +${formatDiffRange(firstNewLine, newCount)} @@`;
}

function formatDiffRange(startLine: number, lineCount: number): string {
  if (lineCount === 0) {
    return `${startLine},0`;
  }

  if (lineCount === 1) {
    return `${startLine}`;
  }

  return `${startLine},${lineCount}`;
}

function formatDiffLine(line: NumberedDiffLine): string {
  if (line.kind === "add") {
    return `+${line.text}`;
  }

  if (line.kind === "remove") {
    return `-${line.text}`;
  }

  return ` ${line.text}`;
}

function truncateDiffLines(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) {
    return lines;
  }

  const omittedCount = lines.length - MAX_DIFF_LINES;

  return [
    ...lines.slice(0, MAX_DIFF_LINES),
    `... diff truncated, ${omittedCount} lines omitted ...`,
  ];
}

function mapHookEventName(command: HookCommand): string {
  switch (command) {
    case "session-start":
      return "SessionStart";
    case "user-prompt":
      return "UserPromptSubmit";
    case "pre-tool":
      return "PreToolUse";
    case "post-tool":
      return "PostToolUse";
    case "stop":
      return "Stop";
    default:
      return command;
  }
}

function compactSignature(signature: string): string {
  if (signature === "missing") {
    return "missing";
  }

  const segments = signature.split(":");

  if (segments.length < 4) {
    return signature;
  }

  return `${segments[0]}:${segments[1]}:${segments[2]}:${segments[3].slice(0, 12)}`;
}

function defaultCodexHome(): string {
  return resolve(process.env.CODEX_HOME ?? join(process.env.HOME ?? ".", ".codex"));
}

function defaultDbPath(): string {
  return join(defaultCodexHome(), "state", "agents-md-watch.sqlite3");
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findFirstString(
  value: JsonValue | HookPayload,
  keys: string[],
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFirstString(entry, keys);

      if (found) {
        return found;
      }
    }

    return undefined;
  }

  for (const key of keys) {
    const maybeValue = value[key];

    if (typeof maybeValue === "string" && maybeValue.length > 0) {
      return maybeValue;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = findFirstString(nestedValue, keys);

    if (found) {
      return found;
    }
  }

  return undefined;
}

function findFirstStringInsideContainers(
  value: JsonValue | HookPayload,
  containerKeys: string[],
  keys: string[],
): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  for (const containerKey of containerKeys) {
    const container = value[containerKey];
    const found = findFirstString(container, keys);

    if (found) {
      return found;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = findFirstStringInsideContainers(
      nestedValue,
      containerKeys,
      keys,
    );

    if (found) {
      return found;
    }
  }

  return undefined;
}

if (import.meta.main) {
  await main(process.argv);
}
