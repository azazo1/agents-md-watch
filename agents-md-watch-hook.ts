#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type HookCommand = "session-start" | "pre-tool" | "post-tool" | "stop";
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
  last_seen_signature: string;
  last_notified_signature: string | null;
  last_change_at: string | null;
}

interface AlertRecord {
  path: string;
  scope: Scope;
  previousSignature: string;
  currentSignature: string;
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
        startSession(db, session, now);
        cleanupOldRecords(db, now, session.sessionKey);
        return {
          sessionKey: session.sessionKey,
          alerts: [],
          response: {},
        };
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
    command !== "pre-tool" &&
    command !== "post-tool" &&
    command !== "stop"
  ) {
    throw new Error(
      "Usage: bun agents-md-watch-hook.ts <session-start|pre-tool|post-tool|stop> [--db-path PATH] [--mode warn|strict] [--project-root PATH] [--codex-home PATH] [--stable-delay-seconds SECONDS]",
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
      last_seen_exists INTEGER NOT NULL,
      last_seen_size TEXT NOT NULL,
      last_seen_mtime_ns TEXT NOT NULL,
      last_seen_sha256 TEXT NOT NULL,
      last_seen_signature TEXT NOT NULL,
      last_notified_signature TEXT,
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

function startSession(db: Database, session: SessionContext, now: string): void {
  ensureSessionRow(db, session, now);
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
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_notified_signature,
      last_change_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
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
      last_seen_signature,
      last_change_at,
      last_notified_signature
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
      last_seen_exists,
      last_seen_size,
      last_seen_mtime_ns,
      last_seen_sha256,
      last_seen_signature,
      last_notified_signature,
      last_change_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
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
      last_change_at = ?
    WHERE session_key = ? AND path = ?
  `);
  const markAlerted = db.prepare(`
    UPDATE tracked_files
    SET
      last_notified_signature = ?,
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
        insertTracked.run(
          session.sessionKey,
          snapshot.path,
          snapshot.scope,
          snapshot.exists ? 1 : 0,
          snapshot.size,
          snapshot.mtimeNs,
          snapshot.sha256,
          snapshot.signature,
          snapshot.exists ? 1 : 0,
          snapshot.size,
          snapshot.mtimeNs,
          snapshot.sha256,
          snapshot.signature,
        );
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
        currentContent: snapshot.content,
      });
      markAlerted.run(
        snapshot.signature,
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

  const mtime = snapshotMtimeIso(currentSnapshot);

  if (mtime) {
    return mtime;
  }

  if (
    existing.last_seen_signature === currentSnapshot.signature &&
    existing.last_change_at
  ) {
    return existing.last_change_at;
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
): Array<string | number> {
  return [
    sessionKey,
    snapshot.path,
    snapshot.scope,
    snapshot.exists ? 1 : 0,
    snapshot.size,
    snapshot.mtimeNs,
    snapshot.sha256,
    snapshot.signature,
    snapshot.exists ? 1 : 0,
    snapshot.size,
    snapshot.mtimeNs,
    snapshot.sha256,
    snapshot.signature,
  ];
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
    const relativePath = relative(cwd, alert.path) || alert.path;
    return `- ${alert.scope} ${relativePath}: ${compactSignature(alert.previousSignature)} -> ${compactSignature(alert.currentSignature)}`;
  });
  const contentLines = alerts.flatMap((alert) => {
    const relativePath = relative(cwd, alert.path) || alert.path;
    const content = alert.currentContent ?? "<missing>";

    return [`${relativePath} 最新内容:`, "<<<AGENTS.md", content, ">>>"];
  });
  const hookEventName = mapHookEventName(command);
  const title = "检测到当前 session 的 AGENTS 指令文件发生变化";
  const detail = [
    title,
    ...lines,
    ...contentLines,
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
    if (command === "pre-tool") {
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

function mapHookEventName(command: HookCommand): string {
  switch (command) {
    case "session-start":
      return "SessionStart";
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

if (import.meta.main) {
  await main(process.argv);
}
