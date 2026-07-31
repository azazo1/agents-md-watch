#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type WatchMode = "warn" | "strict";

interface HookCommandConfig {
  type: "command";
  command: string;
  commandWindows?: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookMatcherConfig {
  matcher?: string;
  hooks: HookCommandConfig[];
}

interface HooksFile {
  hooks: Record<string, HookMatcherConfig[]>;
}

const SCRIPT_FILES = [
  "agents-md-watch-hook.ts",
  "agents-md-watch-hook.test.ts",
  "README.md",
  "package.json",
  "justfile",
  ".gitignore",
] as const;

const parsed = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "target-dir": {
      type: "string",
      default: "~/.codex/agents-md-watch",
    },
    "db-path": {
      type: "string",
      default: "~/.codex/state/agents-md-watch.sqlite3",
    },
    mode: {
      type: "string",
      default: "warn",
    },
    "stable-delay-seconds": {
      type: "string",
      default: "10",
    },
    "hooks-json": {
      type: "string",
      default: "~/.codex/hooks.json",
    },
    "codex-home": {
      type: "string",
      default: process.env.CODEX_HOME ?? "~/.codex",
    },
    "print-only": {
      type: "boolean",
      default: false,
    },
  },
  allowPositionals: false,
});

const mode = readMode(parsed.values.mode);
const stableDelaySeconds = readStableDelaySeconds(
  parsed.values["stable-delay-seconds"],
);
const repoRoot = dirname(fileURLToPath(import.meta.url));
const targetDir = expandHome(parsed.values["target-dir"]);
const dbPath = expandHome(parsed.values["db-path"]);
const hooksJsonPath = expandHome(parsed.values["hooks-json"]);
const codexHome = expandHome(parsed.values["codex-home"]);
const generatedHooks = buildHooksConfig(
  join(targetDir, "agents-md-watch-hook.ts"),
  dbPath,
  codexHome,
  mode,
  stableDelaySeconds,
);

if (parsed.values["print-only"]) {
  process.stdout.write(`${JSON.stringify(generatedHooks, null, 2)}\n`);
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
mkdirSync(dirname(dbPath), { recursive: true });

for (const fileName of SCRIPT_FILES) {
  copyFileSync(join(repoRoot, fileName), join(targetDir, fileName));
}

const hooksMergeResult = mergeHooksJson(hooksJsonPath, generatedHooks);
const generatedHooksPath = join(targetDir, "hooks.generated.json");
writeFileSync(generatedHooksPath, `${JSON.stringify(generatedHooks, null, 2)}\n`);

const summary = [
  `已安装到: ${targetDir}`,
  `数据库路径: ${dbPath}`,
  `codex home: ${codexHome}`,
  `模式: ${mode}`,
  `稳定等待: ${stableDelaySeconds}s`,
  `hooks.json: ${hooksMergeResult}`,
  `生成的 hooks 示例: ${generatedHooksPath}`,
];

process.stdout.write(`${summary.join("\n")}\n`);

function readMode(value: string): WatchMode {
  if (value === "warn" || value === "strict") {
    return value;
  }

  throw new Error(`Unsupported mode: ${value}`);
}

function readStableDelaySeconds(value: string): number {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Unsupported stable delay seconds: ${value}`);
  }

  return seconds;
}

function expandHome(pathText: string): string {
  if (pathText === "~") {
    return homedir();
  }

  if (pathText.startsWith("~/")) {
    return join(homedir(), pathText.slice(2));
  }

  return resolve(pathText);
}

function buildHooksConfig(
  installedHookPath: string,
  dbPath: string,
  codexHome: string,
  mode: WatchMode,
  stableDelaySeconds: number,
): HooksFile {
  const renderPosixCommand = (eventCommand: string) =>
    `bun ${shellQuotePosix(installedHookPath)} ${eventCommand} --db-path ${shellQuotePosix(dbPath)} --codex-home ${shellQuotePosix(codexHome)} --mode ${mode} --stable-delay-seconds ${stableDelaySeconds}`;
  const renderWindowsCommand = (eventCommand: string) =>
    `bun ${shellQuoteWindows(installedHookPath)} ${eventCommand} --db-path ${shellQuoteWindows(dbPath)} --codex-home ${shellQuoteWindows(codexHome)} --mode ${mode} --stable-delay-seconds ${stableDelaySeconds}`;

  const hookCommand = (eventCommand: string) => ({
    type: "command" as const,
    command: renderPosixCommand(eventCommand),
    commandWindows: renderWindowsCommand(eventCommand),
  });

  return {
    hooks: {
      SessionStart: [
        {
          matcher: ".*",
          hooks: [
            {
              ...hookCommand("session-start"),
              timeout: 10,
              statusMessage: "Recording AGENTS baseline",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              ...hookCommand("pre-tool"),
              timeout: 10,
              statusMessage: "Checking AGENTS changes",
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              ...hookCommand("user-prompt"),
              timeout: 10,
              statusMessage: "Checking AGENTS changes",
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: ".*",
          hooks: [
            {
              ...hookCommand("post-tool"),
              timeout: 10,
              statusMessage: "Checking AGENTS changes",
            },
          ],
        },
      ],
      Stop: [
        {
          matcher: ".*",
          hooks: [
            {
              ...hookCommand("stop"),
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

function mergeHooksJson(hooksJsonPath: string, incoming: HooksFile): string {
  mkdirSync(dirname(hooksJsonPath), { recursive: true });
  const hadExistingFile = existsSync(hooksJsonPath);

  let existing: HooksFile = { hooks: {} };

  if (existsSync(hooksJsonPath)) {
    const raw = readFileSync(hooksJsonPath, "utf8").trim();

    if (raw.length > 0) {
      const parsedJson = JSON.parse(raw) as HooksFile;

      if (parsedJson && typeof parsedJson === "object" && parsedJson.hooks) {
        existing = parsedJson;
      }
    }
  }

  for (const [eventName, matcherConfigs] of Object.entries(incoming.hooks)) {
    const targetList = (existing.hooks[eventName] ?? [])
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((hook) => !isAgentsWatchHook(hook)),
      }))
      .filter((entry) => entry.hooks.length > 0);

    for (const matcherConfig of matcherConfigs) {
      targetList.push(matcherConfig);
    }

    existing.hooks[eventName] = targetList;
  }

  writeFileSync(hooksJsonPath, `${JSON.stringify(existing, null, 2)}\n`);
  return hadExistingFile ? `merged into ${hooksJsonPath}` : `created ${hooksJsonPath}`;
}

function isAgentsWatchHook(hook: HookCommandConfig): boolean {
  return hook.command.includes("agents-md-watch-hook.ts");
}

function shellQuotePosix(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function shellQuoteWindows(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '\\"')}"`;
}
