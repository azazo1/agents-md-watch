import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

    writeFileSync(ctx.projectAgentsPath, "# changed once\n");

    const firstA = runHook({ command: "pre-tool" }, payloadA, ctx.options);
    const secondA = runHook({ command: "pre-tool" }, payloadA, ctx.options);
    const firstB = runHook({ command: "pre-tool" }, payloadB, ctx.options);

    expect(firstA.alerts).toHaveLength(1);
    expect(secondA.alerts).toHaveLength(0);
    expect(firstB.alerts).toHaveLength(1);
  });

  test("same change is only warned once inside one session", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-single", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    writeFileSync(ctx.projectAgentsPath, "# changed once\n");

    const first = runHook({ command: "pre-tool" }, payload, ctx.options);
    const second = runHook({ command: "post-tool" }, payload, ctx.options);

    expect(first.alerts).toHaveLength(1);
    expect(second.alerts).toHaveLength(0);
  });

  test("later content changes trigger a fresh alert", () => {
    const ctx = createFixture();
    const payload = { sessionId: "session-repeat", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    writeFileSync(ctx.projectAgentsPath, "# changed once\n");
    runHook({ command: "pre-tool" }, payload, ctx.options);

    writeFileSync(ctx.projectAgentsPath, "# changed twice\n");
    const second = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(second.alerts).toHaveLength(1);
  });

  test("missing baseline file becoming present also triggers an alert", () => {
    const ctx = createFixture({ createGlobalAgents: false });
    const payload = { sessionId: "session-global", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    writeFileSync(ctx.globalAgentsPath, "# new global agents\n");

    const result = runHook({ command: "pre-tool" }, payload, ctx.options);

    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.path).toBe(ctx.globalAgentsPath);
  });

  test("strict pre-tool returns a deny decision", () => {
    const ctx = createFixture({ mode: "strict" });
    const payload = { sessionId: "session-strict-pre", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    writeFileSync(ctx.projectAgentsPath, "# changed once\n");

    const result = runHook({ command: "pre-tool" }, payload, ctx.options);
    const hookOutput = result.response.hookSpecificOutput as Record<string, string>;

    expect(hookOutput.hookEventName).toBe("PreToolUse");
    expect(hookOutput.permissionDecision).toBe("deny");
  });

  test("strict post-tool stops the run", () => {
    const ctx = createFixture({ mode: "strict" });
    const payload = { sessionId: "session-strict-post", cwd: ctx.cwd };

    runHook({ command: "session-start" }, payload, ctx.options);
    writeFileSync(ctx.projectAgentsPath, "# changed once\n");

    const result = runHook({ command: "post-tool" }, payload, ctx.options);

    expect(result.response.continue).toBe(false);
    expect(result.response.stopReason).toBeString();
  });
});

function createFixture(options?: {
  createGlobalAgents?: boolean;
  mode?: "warn" | "strict";
}) {
  const root = mkdtempSync(join(tmpdir(), "agents-md-watch-"));
  testRoots.push(root);

  const codexHome = join(root, "codex-home");
  const projectRoot = join(root, "repo");
  const cwd = join(projectRoot, "src", "nested");
  const globalAgentsPath = join(codexHome, "AGENTS.md");
  const projectAgentsPath = join(projectRoot, "AGENTS.md");
  const dbPath = join(root, "state", "agents-md-watch.sqlite3");

  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dirname(globalAgentsPath), { recursive: true });
  mkdirSync(dirname(projectAgentsPath), { recursive: true });

  if (options?.createGlobalAgents !== false) {
    writeFileSync(globalAgentsPath, "# global baseline\n");
  }

  writeFileSync(projectAgentsPath, "# project baseline\n");

  return {
    cwd,
    globalAgentsPath,
    projectAgentsPath,
    options: {
      dbPath,
      mode: options?.mode ?? ("warn" as const),
      codexHome,
      projectRoot,
      now: (() => {
        let step = 0;
        return () => `2026-06-25T12:00:${String(step++).padStart(2, "0")}Z`;
      })(),
    },
  };
}
