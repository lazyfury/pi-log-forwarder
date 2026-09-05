---
name: log-forwarding
description: 用 pi-logfwd（Go 编写的命令日志转发器）运行 shell 脚本/命令，实时转发日志、支持需要 PTY 的命令、可把日志落盘。当内置 bash/process 工具输出被缓冲截断、命令需要伪终端、或需要把日志转发到文件时使用。触发词：转发日志、实时输出、流式日志、PTY、日志文件、bash_logged、pi-logfwd。
---

# log-forwarding

pi-logfwd 是独立发布的 pi package（npm `@sukeai/pi-logfwd`），扩展注册 `bash_logged` 工具，经 Go 二进制 `pi-logfwd` 运行命令并实时转发日志。

## 安装与更新

```bash
# 安装 / 更新（npm 源，随包自动装当前平台预编译二进制）
pi install npm:@sukeai/pi-logfwd            # 或带版本 npm:@sukeai/pi-logfwd@x.y.z
pi update --extensions                       # 更新全部扩展包

# 本地开发（改源码）
pi install /path/to/pi-log-forwarder
```

装完 pi 内 `/reload` 生效。本机 settings.json `packages` 应为 `npm:@sukeai/pi-logfwd@<ver>`（不再是 extensions/ 手工副本）。

## 何时用

用 `bash_logged`（或直接调用 `pi-logfwd`）替代内置 `bash` 工具，当满足任一条件：

- 需要**实时**看到命令输出（内置 bash 是最后一次性返回，且截断为末尾 2000 行 / 50KB）
- 命令**需要伪终端（PTY）**：交互式 CLI、进度条、ssh 会话、htop 等（内置 process 无 TTY，会报错或行为异常）
- 需要把日志**转发/落盘**到文件，供后续查看

## 用法

```bash
# 直接命令行（PTY 模式，JSONL 事件流）
pi-logfwd run --timeout 30s 'make test'

# 管道传入脚本
cat script.sh | pi-logfwd run -

# 纯文本输出 + 日志落盘（人类可读）
pi-logfwd run --plain --log-file /tmp/run.log 'npm run build'

# 不需要 TTY 时用 --no-pty（stderr 与 stdout 分开）
pi-logfwd run --no-pty 'go test ./...'
```

在 pi 里：用扩展注册的工具 `bash_logged`，参数 `command` / `timeout` / `cwd` / `logFile` / `noPty`，输出实时流入会话。

JSONL 事件：`start`（pid/command）→ `output`（stream/data 分块）→ `exit`（code/durationMs），错误时 `error`。

## 平台支持

- 预编译平台包：darwin/linux × arm64/amd64（`@sukeai/pi-logfwd-<os>-<arch>`，npm optionalDependencies 自动按 os/cpu 匹配安装）
- **Windows 不支持**（creack/pty 在 Windows 返回 ErrUnsupported）→ bash_logged 在 win32 返回明确提示，建议 WSL/容器
- 二进制解析顺序：`PI_LOG_FWD_BIN` → 平台 companion 包 → `~/.pi/agent/bin/pi-logfwd` → PATH
- 本机开发快速安装：`go build -o ~/.pi/agent/bin/pi-logfwd ./cmd/pi-logfwd`（走解析顺序第 3 步）

## 调研结论：内置 process 对特殊环境的支持

| 场景 | 内置 bash/process 工具 | pi-logfwd（PTY） | 结论 |
| --- | --- | --- | --- |
| 普通命令、管道、脚本 | ✅ | ✅ | 支持 |
| 长输出 / 持续输出（build、log 尾随） | ⚠️ 缓冲到结束，截断末尾 | ✅ 实时分块转发 | 用 pi-logfwd |
| 需要 TTY 的命令（htop、ssh、交互 CLI） | ❌ 无 PTY，报错/挂起 | ✅ 能启动并转发输出 | 用 pi-logfwd |
| 命令行要求输入密码（sudo、ssh、read -s） | ❌ 无输入通道，挂起或失败 | ⚠️ PTY 能渲染提示符，但**无人应答**，超时被杀死 | **不适用** |
| 弹出授权弹窗（macOS Touch ID / 钥匙串 / GUI 授权） | ❌ 无法程序化操作弹窗 | ❌ 同上 | **不适用** |

### 不适用场景的处理（必须这样做）

当命令会要求密码、口令或弹出系统授权弹窗时：

1. **不要**尝试用任何工具代输密码或模拟点击——不可行，也不该做
2. 明确告知用户：这条命令需要交互式密码/GUI 授权，pi 无法代劳
3. 给出用户手动执行的**最小可执行命令**（一条命令或一个点击路径）
4. 用户执行完成后，再继续后续步骤

> 判断标准（全局 AGENTS.md）：人做更简单的事，交给人类。这类场景让用户花 1 分钟手动完成，远优于工具实现的高复杂度与失败率。

## 发布（开发者在仓库内）

```bash
cd ~/Documents/projects/pi-log-forwarder
./scripts/release.sh 0.1.1                 # 构建矩阵 + 打包 dry-run
./scripts/release.sh 0.1.1 --publish       # npm publish（主包 + 4 平台包同版本）
git tag v0.1.1 && git push --tags
```

## 验证

```bash
go build -o bin/pi-logfwd ./cmd/pi-logfwd
bin/pi-logfwd run 'echo hi; echo err >&2'          # JSONL
bin/pi-logfwd run --plain --timeout 1s 'sleep 10'  # 验证超时被杀
```
