# agents-md-watch

这是一套给 Codex hooks 用的 `AGENTS.md` 变更观察工具.

它解决两个问题:

- 数据库存储可以共享, 但观察状态按 session 隔离.
- agent 工作途中通过 `PreToolUse` 和 `PostToolUse` 检查 `AGENTS.md` 是否变化, 并在变化稳定后提醒.

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

`pre-tool`

- agent 每次准备调用工具前检查快照.
- `warn` 模式下在变化稳定后返回提醒.
- 提醒内容会包含新的 AGENTS 文件全文.
- `strict` 模式下返回 `permissionDecision: deny`.

`post-tool`

- agent 每次工具执行后再次检查.
- `warn` 模式下在变化稳定后返回提醒.
- 提醒内容会包含新的 AGENTS 文件全文.
- `strict` 模式下返回 `continue: false`.

`stop`

- 将当前 session 标记为结束.

## session 隔离

数据库是单文件, 但每条基线和提醒都带 `session_key`.

- session A 收到过一次提醒, 不会压掉 session B 的提醒.
- 同一个 session 对同一个文件签名只提醒一次.
- 文件再次变化并稳定后, 同一个 session 会收到新的提醒.

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
3. 打开 `~/.codex/hooks.json`, 删除 command 指向 `agents-md-watch-hook.ts` 的 `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` hooks.

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
- 同一个签名不会重复提醒.
- 文件再次变化并稳定后会再次提醒.
- 稳定等待时间可以自定义.
- 启动时不存在的 AGENTS 文件, 后续创建后也会提醒.
- 严格模式下的 `PreToolUse` 和 `PostToolUse` 返回格式.
