import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { runHook } from "./agents-md-watch-hook";

const testRoots: string[] = [];

afterEach(() => {
  while (testRoots.length > 0) {
    const root = testRoots.pop();

    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("agents watch hook", () => {
  test("each session keeps its own alert state", () => {
    const ctx = createFixture();
    const payloadA = { sessionId: "session-a", cwd: ctx.cwd };
    const payloadB = { sessionId: "session-b", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payloadA, ctx.options);
    runHook({ command: "session-start" }, payloadB, ctx.options);

    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    const pendingA = runHook({ command: "pre-tool" }, payloadA, ctx.options);
    const pendingB = runHook({ command: "pre-tool" }, payloadB, ctx.options);

    ctx.advanceSeconds(10);

    const firstA = runHook({ command: "pre-tool" }, payloadA, ctx.options);
    const secondA = runHook({ command: "pre-tool" }, payloadA, ctx.options);
    const firstB = runHook({ command: "pre-tool" }, payloadB, ctx.options);

    expect(pendingA.alerts).toHaveLength(0);
    expect(pendingB.alerts).toHaveLength(0);
    expect(firstA.alerts).toHaveLength(1);
    expect(secondA.alerts).toHaveLength(0);
    expect(firstB.alerts).toHaveLength(1);
  });

  test("same change is only warned once inside one session", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-single", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    const pending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(10);

    const first = runHook({ command: "pre-tool" }, payload, ctx.options);
    const second = runHook({ command: "post-tool" }, payload, ctx.options);

    expect(pending.alerts).toHaveLength(0);
    expect(first.alerts).toHaveLength(1);
    expect(second.alerts).toHaveLength(0);
  });

  test("later content changes trigger a fresh alert", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-repeat", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    runHook({ command: "pre-tool" }, payload, ctx.options);
    ctx.advanceSeconds(10);
    runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed twice\n");
    const pending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(10);

    const second = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(pending.alerts).toHaveLength(0);
    expect(second.alerts).toHaveLength(1);
  });

  test("alert response includes diff from last notified content", () => {
    const ctx = createFixture({ stableDelayMs: 0 });
    const payload = { sessionId: "session-diff", cwd: ctx.cwd };

    ctx.writeAgentsFile(
      ctx.projectAgentsPath,
      "# title\nvalue: baseline\nend\n",
    );
    runHook({ command: "session-start" }, payload, ctx.options);

    ctx.writeAgentsFile(ctx.projectAgentsPath, "# title\nvalue: first\nend\n");

    const first = runHook({ command: "pre-tool" }, payload, ctx.options);
    const firstMessage = String(first.response.systemMessage);

    expect(firstMessage).toContain("--- a/");
    expect(firstMessage).toContain("+++ b/");
    expect(firstMessage).toContain("@@");
    expect(firstMessage).toContain("-value: baseline");
    expect(firstMessage).toContain("+value: first");
    expect(firstMessage).not.toContain("<<<AGENTS.md");
    expect(firstMessage).not.toContain("最新内容");

    ctx.writeAgentsFile(ctx.projectAgentsPath, "# title\nvalue: second\nend\n");

    const second = runHook({ command: "pre-tool" }, payload, ctx.options);
    const secondMessage = String(second.response.systemMessage);

    expect(secondMessage).toContain("-value: first");
    expect(secondMessage).toContain("+value: second");
    expect(secondMessage).not.toContain("-value: baseline");
  });

  test("unstable content changes reset the stable delay", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-unstable", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    const firstPending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(9);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed twice\n");

    const resetPending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(9);

    const stillPending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(1);

    const stable = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(firstPending.alerts).toHaveLength(0);
    expect(resetPending.alerts).toHaveLength(0);
    expect(stillPending.alerts).toHaveLength(0);
    expect(stable.alerts).toHaveLength(1);
  });

  test("stable delay can be customized", () => {
    const ctx = createFixture({ stableDelayMs: 2000 });
    const payload = { sessionId: "session-custom-delay", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    const pending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(2);

    const stable = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(pending.alerts).toHaveLength(0);
    expect(stable.alerts).toHaveLength(1);
  });

  test("missing baseline file becoming present also triggers an alert", () => {
    const ctx = createFixture({ createGlobalAgents: false });
    const payload = { sessionId: "session-global", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.globalAgentsPath, "# new global agents\n");

    const pending = runHook({ command: "pre-tool" }, payload, ctx.options);

    ctx.advanceSeconds(10);

    const result = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(pending.alerts).toHaveLength(0);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.path).toBe(ctx.globalAgentsPath);
  });

  test("global file alert response keeps an absolute path", () => {
    const ctx = createFixture({ stableDelayMs: 0 });
    const payload = { sessionId: "session-global-absolute", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.globalAgentsPath, "# global changed\n");

    const result = runHook({ command: "pre-tool" }, payload, ctx.options);
    const message = String(result.response.systemMessage);
    const relativeGlobalPath = relative(ctx.cwd, ctx.globalAgentsPath);

    expect(message).toContain(`global ${ctx.globalAgentsPath}`);
    expect(message).toContain(`${ctx.globalAgentsPath} diff:`);
    expect(message).not.toContain(relativeGlobalPath);
  });

  test("strict pre-tool returns a deny decision", () => {
    const ctx = createFixture({ mode: "strict" });
    const payload = { sessionId: "session-strict-pre", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    runHook({ command: "pre-tool" }, payload, ctx.options);
    ctx.advanceSeconds(10);

    const result = runHook({ command: "pre-tool" }, payload, ctx.options);
    const hookOutput = result.response.hookSpecificOutput as Record<string, string>;

    expect(hookOutput.hookEventName).toBe("PreToolUse");
    expect(hookOutput.permissionDecision).toBe("deny");
  });

  test("strict post-tool stops the run", () => {
    const ctx = createFixture({ mode: "strict" });
    const payload = { sessionId: "session-strict-post", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    ctx.writeAgentsFile(ctx.projectAgentsPath, "# changed once\n");

    runHook({ command: "post-tool" }, payload, ctx.options);
    ctx.advanceSeconds(10);

    const result = runHook({ command: "post-tool" }, payload, ctx.options);

    expect(result.response.continue).toBe(false);
    expect(result.response.stopReason).toBeString();
  });

  test("removes database records older than thirty days", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-retention", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    withDatabase(ctx.options.dbPath, (db) => {
      insertSessionRecords(db, "old-session", "2026-05-20T12:00:00.000Z");
      insertSessionRecords(db, "recent-session", "2026-06-10T12:00:00.000Z");
    });

    runHook({ command: "pre-tool" }, payload, ctx.options);

    const oldCounts = readSessionRecordCounts(ctx.options.dbPath, "old-session");
    const recentCounts = readSessionRecordCounts(
      ctx.options.dbPath,
      "recent-session",
    );
    const currentCounts = readSessionRecordCounts(
      ctx.options.dbPath,
      "session-retention",
    );

    expect(oldCounts.sessions).toBe(0);
    expect(oldCounts.trackedFiles).toBe(0);
    expect(oldCounts.alerts).toBe(0);
    expect(recentCounts.sessions).toBe(1);
    expect(recentCounts.trackedFiles).toBe(1);
    expect(recentCounts.alerts).toBe(1);
    expect(currentCounts.sessions).toBe(1);
    expect(currentCounts.trackedFiles).toBeGreaterThan(0);
  });

  test("migrates tracked file content columns for existing databases", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-migrate", cwd: ctx.cwd };

    mkdirSync(dirname(ctx.options.dbPath), { recursive: true });
    withDatabase(ctx.options.dbPath, (db) => {
      db.exec(`
        CREATE TABLE sessions (
          session_key TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          project_root TEXT NOT NULL,
          codex_home TEXT NOT NULL,
          created_at TEXT NOT NULL,
          ended_at TEXT,
          status TEXT NOT NULL
        );

        CREATE TABLE tracked_files (
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

        CREATE TABLE alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          path TEXT NOT NULL,
          scope TEXT NOT NULL,
          previous_signature TEXT NOT NULL,
          current_signature TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });

    runHook({ command: "session-start" }, payload, ctx.options);

    withDatabase(ctx.options.dbPath, (db) => {
      const columns = db.prepare("PRAGMA table_info(tracked_files)").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((column) => column.name);

      expect(columnNames).toContain("baseline_content");
      expect(columnNames).toContain("last_seen_content");
      expect(columnNames).toContain("last_notified_content");
    });
  });
});

describe("agents watch installer", () => {
  test("overwrites previous agents hooks and preserves other hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-md-watch-install-"));
    testRoots.push(root);

    const targetDir = join(root, "target");
    const dbPath = join(root, "state", "watch.sqlite3");
    const hooksJsonPath = join(root, "hooks.json");
    const keepCommand = "echo keep";

    writeFileSync(
      hooksJsonPath,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: ".*",
                hooks: [
                  {
                    type: "command",
                    command:
                      "bun /old/agents-md-watch-hook.ts pre-tool --stable-delay-seconds 1",
                  },
                  {
                    type: "command",
                    command: keepCommand,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const installResult = Bun.spawnSync({
      cmd: [
        "bun",
        "./install.ts",
        "--target-dir",
        targetDir,
        "--db-path",
        dbPath,
        "--hooks-json",
        hooksJsonPath,
        "--stable-delay-seconds",
        "4",
      ],
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(installResult.exitCode).toBe(0);

    const installed = JSON.parse(readFileSync(hooksJsonPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const preToolCommands = installed.hooks.PreToolUse.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    const agentsCommands = preToolCommands.filter((command) =>
      command.includes("agents-md-watch-hook.ts"),
    );

    expect(preToolCommands).toContain(keepCommand);
    expect(agentsCommands).toHaveLength(1);
    expect(agentsCommands[0]).toContain("--stable-delay-seconds 4");
  });
});

function createFixture(options?: {
  createGlobalAgents?: boolean;
  mode?: "warn" | "strict";
  stableDelayMs?: number;
}) {
  const root = mkdtempSync(join(tmpdir(), "agents-md-watch-"));
  testRoots.push(root);

  const codexHome = join(root, "codex-home");
  const projectRoot = join(root, "repo");
  const cwd = join(projectRoot, "src", "nested");
  const globalAgentsPath = join(codexHome, "AGENTS.md");
  const projectAgentsPath = join(projectRoot, "AGENTS.md");
  const dbPath = join(root, "state", "agents-md-watch.sqlite3");
  let nowMs = Date.parse("2026-06-25T12:00:00.000Z");
  const writeAgentsFile = (filePath: string, content: string) => {
    writeFileSync(filePath, content);
    const nowDate = new Date(nowMs);
    utimesSync(filePath, nowDate, nowDate);
  };

  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(globalAgentsPath), { recursive: true });
  mkdirSync(dirname(projectAgentsPath), { recursive: true });

  if (options?.createGlobalAgents !== false) {
    writeAgentsFile(globalAgentsPath, "# global baseline\n");
  }

  writeAgentsFile(projectAgentsPath, "# project baseline\n");

  return {
    cwd,
    globalAgentsPath,
    projectAgentsPath,
    writeAgentsFile,
    advanceSeconds(seconds: number) {
      nowMs += seconds * 1000;
    },
    options: {
      dbPath,
      mode: options?.mode ?? ("warn" as const),
      codexHome,
      projectRoot,
      stableDelayMs: options?.stableDelayMs,
      now: () => new Date(nowMs).toISOString(),
    },
  };
}

function withDatabase(dbPath: string, callback: (db: Database) => void): void {
  const db = new Database(dbPath);

  try {
    callback(db);
  } finally {
    db.close();
  }
}

function insertSessionRecords(
  db: Database,
  sessionKey: string,
  createdAt: string,
): void {
  const filePath = `/tmp/${sessionKey}/AGENTS.md`;

  db.prepare(`
    INSERT INTO sessions (
      session_key,
      cwd,
      project_root,
      codex_home,
      created_at,
      ended_at,
      status
    ) VALUES (?, '/', '/', '/', ?, ?, 'stopped')
  `).run(sessionKey, createdAt, createdAt);

  db.prepare(`
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
    ) VALUES (
      ?, ?, 'project', 0, '0', '0', '', 'missing',
      0, '0', '0', '', 'missing', NULL, NULL
    )
  `).run(sessionKey, filePath);

  db.prepare(`
    INSERT INTO alerts (
      session_key,
      path,
      scope,
      previous_signature,
      current_signature,
      created_at
    ) VALUES (?, ?, 'project', 'missing', 'missing', ?)
  `).run(sessionKey, filePath, createdAt);
}

function readSessionRecordCounts(dbPath: string, sessionKey: string): {
  sessions: number;
  trackedFiles: number;
  alerts: number;
} {
  const db = new Database(dbPath);

  try {
    return {
      sessions: readCount(db, "sessions", sessionKey),
      trackedFiles: readCount(db, "tracked_files", sessionKey),
      alerts: readCount(db, "alerts", sessionKey),
    };
  } finally {
    db.close();
  }
}

function readCount(
  db: Database,
  tableName: "sessions" | "tracked_files" | "alerts",
  sessionKey: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE session_key = ?`)
    .get(sessionKey) as { count: number };

  return row.count;
}
