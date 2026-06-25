# just
# 默认展示可用命令.
default:
    @just --list

# just test
# 运行关键测试.
test:
    @bun test

# just install
# 安装到默认的 ~/.codex 目录.
install:
    @bun ./install.ts

# just print-hooks
# 打印 hooks.json 示例.
print-hooks:
    @bun ./install.ts --print-only
