# agents-md-watch

这是一套给 Codex hooks 用的 `AGENTS.md` 变更观察工具.

它解决两个问题:

- 数据库存储可以共享, 但观察状态按 session 隔离.
- fork 出来的 session 会继承父 session 的观察状态.
- agent 工作途中通过 `UserPromptSubmit`, `PreToolUse` 和 `PostToolUse` 检查 `AGENTS.md` 是否变化, 并在变化稳定后提醒.

## 仓库文件

- `agents-md-watch-hook.ts`: 核心 hook 脚本.
- `install.ts`: 安装脚本, 会复制文件并合并 `~/.codex/hooks.json`.
- `agents-md-watch-hook.test.ts`: 关键行为测试.
- `justfile`: 常用命令.

## 分发方式

这个项目适合作为一个普通公开仓库分发.

最简单的使用方式是:

```bash
git clone <repo-url>
cd agents-md-watch
bun run install:self
```

安装脚本会做 3 件事:

- 复制脚本到 `~/.codex/agents-md-watch`
- 生成 `~/.codex/state/agents-md-watch.sqlite3`
- 合并或创建 `~/.codex/hooks.json`
- 重复安装时会替换旧的 agents-md-watch hook, 其他 hook 会保留

如果你只想看要写入的 hooks 配置:

```bash
bun run print:hooks
```

## 运行模型

`session-start`

- 为当前 session 建立基线.
- 记录全局层和项目层的 `AGENTS.md` / `AGENTS.override.md` 快照.
- 如果 hook payload 带有父 session / 父 thread 标识, 且数据库中存在父 session 的观察记录, fork session 会继承父 session 的观察状态.

`user-prompt`

- 用户提交新提问时检查快照.
- `warn` 模式下在变化稳定后返回提醒.
- 提醒内容会包含 AGENTS 文件的 unified diff.
- `strict` 模式下返回 `permissionDecision: deny`.

`pre-tool`

- agent 每次准备调用工具前检查快照.
- `warn` 模式下在变化稳定后返回提醒.
- 提醒内容会包含 AGENTS 文件的 unified diff.
- `strict` 模式下返回 `permissionDecision: deny`.

`post-tool`

- agent 每次工具执行后再次检查.
- `warn` 模式下在变化稳定后返回提醒.
- 提醒内容会包含 AGENTS 文件的 unified diff.
- `strict` 模式下返回 `continue: false`.

`stop`

- 将当前 session 标记为结束.

## session 隔离

数据库是单文件, 但每条基线和提醒都带 `session_key`.

- session A 收到过一次提醒, 不会压掉 session B 的提醒.
- 同一个 session 对同一个文件签名只提醒一次.
- 文件再次变化并稳定后, 同一个 session 会收到新的提醒.
- fork session 如果识别到父 session, 会继承父 session 已提醒或待稳定的观察状态.

## 数据库结构

SQLite 文件默认位于 `~/.codex/state/agents-md-watch.sqlite3`.

`sessions`

| 字段 | 说明 |
| --- | --- |
| `session_key` | 当前 session 的稳定 id, 主键. |
| `cwd` | hook payload 中解析到的工作目录. |
| `project_root` | 项目根目录, 用于收集项目层 AGENTS 文件. |
| `codex_home` | Codex home 目录, 用于收集全局层 AGENTS 文件. |
| `created_at` | session 创建时间. |
| `ended_at` | session 结束时间, 仍运行时为 `NULL`. |
| `status` | session 状态, 当前使用 `active` 或 `stopped`. |

`tracked_files`

| 字段组 | 说明 |
| --- | --- |
| `session_key`, `path` | 跟踪文件的复合主键. |
| `scope` | 文件来源层级, 取值为 `global` 或 `project`. |
| `baseline_*` | `session-start` 时的基线快照, 包括 `exists`, `size`, `mtime_ns`, `sha256`, `signature`, `content`. |
| `last_seen_*` | 最近一次检查看到的快照, 包括 `exists`, `size`, `mtime_ns`, `sha256`, `signature`, `content`. |
| `last_notified_signature` | 当前 session 上一次已经提醒过的签名. |
| `last_notified_content` | 当前 session 上一次已经提醒过的内容, 用于后续 diff. |
| `last_change_at` | 当前未提醒变化第一次稳定候选时间. |

`alerts`

| 字段 | 说明 |
| --- | --- |
| `id` | 自增主键. |
| `session_key` | 触发提醒的 session. |
| `path` | 触发提醒的文件绝对路径. |
| `scope` | 文件来源层级. |
| `previous_signature` | 本次提醒对比的旧签名. |
| `current_signature` | 本次提醒对比的新签名. |
| `created_at` | 提醒创建时间. |

数据库迁移在 hook 打开数据库时执行. 如果旧数据库已经存在 `tracked_files`, 但缺少 `baseline_content`, `last_seen_content`, `last_notified_content`, 会自动使用 `ALTER TABLE` 补齐这些列. 旧 session 因为没有历史内容, 第一次跨版本提醒会显示内容不可用的 diff 占位, 之后新提醒会正常基于保存内容生成 diff.

## 数据保留

- 默认保留最近 30 天的 session 记录.
- 过期 session 会连同 `tracked_files` 和 `alerts` 一起清理.
- 清理发生后会尝试执行 `VACUUM`, 用来回收 SQLite 文件空间.
- 当前正在运行的 session 不会被本次清理删除.

## session key

脚本优先从 hook payload 里取这些字段:

- `sessionId`
- `session_id`
- `runId`
- `run_id`
- `threadId`
- `thread_id`
- `conversationId`
- `conversation_id`
- `taskId`
- `task_id`

如果 payload 里没有稳定 id, 脚本会退化成 synthetic key. 这种模式适合单 session 兜底, 不适合同一路径下并发多个 session.

## 安装参数

安装脚本支持这些参数:

- `--target-dir`: 默认 `~/.codex/agents-md-watch`
- `--db-path`: 默认 `~/.codex/state/agents-md-watch.sqlite3`
- `--mode`: `warn` 或 `strict`
- `--stable-delay-seconds`: 默认 `10`
- `--hooks-json`: 默认 `~/.codex/hooks.json`
- `--print-only`: 只打印配置, 不写文件

例如:

```bash
bun ./install.ts \
  --target-dir ~/.codex/agents-md-watch \
  --db-path ~/.codex/state/agents-md-watch.sqlite3 \
  --mode warn \
  --stable-delay-seconds 10
```

## 卸载

当前没有单独的卸载脚本, 按下面 3 步手动清理即可:

1. 删除安装目录 `~/.codex/agents-md-watch`.
2. 删除数据库文件 `~/.codex/state/agents-md-watch.sqlite3`.
3. 打开 `~/.codex/hooks.json`, 删除 command 指向 `agents-md-watch-hook.ts` 的 `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` hooks.

如果这份 `hooks.json` 只给这个项目使用, 也可以在确认没有其他自定义 hooks 后直接删除整个文件.

## 开发命令

```bash
just test
just install
just print-hooks
```

## 测试

```bash
bun test
```

当前测试覆盖了最关键的几件事:

- 每个 session 独立去重.
- fork session 继承父 session 的观察状态.
- 同一个签名不会重复提醒.
- 文件再次变化并稳定后会再次提醒.
- 用户提问时会检查 AGENTS 文件变化.
- 稳定等待时间可以自定义.
- 启动时不存在的 AGENTS 文件, 后续创建后也会提醒.
- 严格模式下的 `PreToolUse` 和 `PostToolUse` 返回格式.
