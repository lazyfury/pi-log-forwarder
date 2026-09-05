# pi-logfwd

实时命令日志转发：当 pi 运行命令时，把输出**实时流式**转发回来（而不是内置 bash 工具那样攒到最后一次性返回 + 截断）。

- **bash_logged 工具**：pi 扩展，经 Go 二进制 `pi-logfwd` 在伪终端（PTY）中运行命令，JSONL 事件流逐块推送，可选追加日志文件。
- **pi-logfwd 二进制**：跨平台预编译二进制，作为 npm 平台包随主包一起分发（见下方「平台支持」）。

动机：pi 内置 bash/process 工具是缓冲式的——输出攒到最后一次性返回，且截断为末尾 2000 行 / 50KB；没有 TTY、没有交互输入通道。pi-logfwd 补上：实时流式输出、PTY 支持、日志落盘。

> 密码提示与 GUI 授权弹窗**不支持**（PTY 只能渲染提示、无人应答；弹窗无法程序化操作）——此时告诉用户手动执行。

## 架构

```
pi (agent)
  │  bash_logged 工具（@sukeai/pi-logfwd 扩展）
  ▼
pi-logfwd run -- "shell script"          ← 接收 shell 脚本 / 任意命令
  │  内部：PTY 分配（默认）或管道（--no-pty）
  │  实时：每块输出 → JSONL 事件 → stdout + 可选 --log-file
  ▼
{ "ts":…, "event":"start",  "pid":123,  "command":"echo hi" }
{ "ts":…, "event":"output", "stream":"stdout", "data":"hi\n" }
{ "ts":…, "event":"exit",   "code":0,   "durationMs":12 }
```

## 安装

```bash
# 推荐：npm 安装（自动带上当前平台的预编译二进制）
pi install npm:@sukeai/pi-logfwd

# 从 GitHub（仓库公开后可用；需在 settings 或命令行指定版本 tag）
pi install git:github.com/lazyfury/pi-log-forwarder@v0.1.0

# 本地路径开发（不安装依赖，适合改源码）
pi install /path/to/pi-log-forwarder

# 试用一次（不写 settings）
pi -e npm:@sukeai/pi-logfwd
```

装完在 pi 里 `/reload`，即可调用 `bash_logged` 工具（参数 `command` / `timeout` / `cwd` / `logFile` / `noPty`）。

## 平台支持

二进制分发模型：npm **platform companion 包**（esbuild 同款机制）。主包把全部平台包列为 `optionalDependencies`，npm 只安装与当前 `os`/`cpu` 匹配的那一个，其余静默跳过；扩展在运行时按平台定位二进制。

| 平台 | 预编译包 | 状态 |
| --- | --- | --- |
| macOS arm64 | `@sukeai/pi-logfwd-darwin-arm64` | ✅ 实机验证 |
| macOS amd64 | `@sukeai/pi-logfwd-darwin-amd64` | ⚠️ 交叉编译，未实机验证 |
| Linux arm64 | `@sukeai/pi-logfwd-linux-arm64` | ⚠️ 交叉编译，未实机验证 |
| Linux amd64 | `@sukeai/pi-logfwd-linux-amd64` | ⚠️ 交叉编译，未实机验证 |
| Windows | 无 | ❌ 不支持 |

**Windows 为什么不支持**：`pi-logfwd` 的 PTY 层用 creack/pty，它在 Windows 上直接返回 `ErrUnsupported`（`--no-pty` 管道模式理论上可行，但需额外改 shell 默认值/信号处理，成本高收益低），因此不发布 win32 平台包。

**不支持的平台如何提醒**：全部平台包被 npm 跳过 → 二进制缺失 → `bash_logged` 不会静默报 ENOENT，而是返回明确说明：

- **win32**：提示「Windows 不受支持（creack/pty ErrUnsupported），建议在 WSL/容器中运行 pi」；自行编译仅管道版可设 `PI_LOG_FWD_BIN` 绕过。
- **其他缺二进制**：给出三种装法（`pi install npm:@sukeai/pi-logfwd` / `go build` / 放入 PATH 或 `~/.pi/agent/bin`）。

### 二进制解析顺序（每次调用时）

```
1. env PI_LOG_FWD_BIN                     （显式指定，设了但缺失会直接报错）
2. 平台 companion 包                      （@sukeai/pi-logfwd-<os>-<arch>）
3. ~/.pi/agent/bin/pi-logfwd              （兼容旧的本地安装方式）
4. PATH 上的 pi-logfwd                    （兼容旧的 PATH 安装方式）
```

## pi-logfwd CLI 用法（独立于 pi 使用）

```bash
pi-logfwd run [flags] [--] <shell-script>   # PTY 模式（默认），JSONL 事件流
pi-logfwd run [flags] -                     # 从 stdin 读脚本
pi-logfwd version | help

# flags: --no-pty --plain --timeout D --cwd DIR --log-file FILE
```

示例：

```bash
pi-logfwd run 'echo hi; echo err >&2'                    # JSONL
pi-logfwd run --plain 'make test'                        # 人类可读
cat deploy.sh | pi-logfwd run --log-file /tmp/deploy.log -
pi-logfwd run --timeout 30s 'npm run build'
```

退出码：透传子进程退出码；超时被杀死为 124；信号终止为 128+信号。

## 开发者

### 仓库结构

```
cmd/pi-logfwd/           Go 源码（main.go / runner.go）
extension/extension.ts   pi 扩展：注册 bash_logged 工具（平台解析 + 提醒逻辑）
package.json             主包（pi manifest + optionalDependencies 平台包列表）
scripts/release.sh       交叉编译 + 发布（Go build → 平台包 → npm publish）
scripts/set-version.js   主包/平台包版本同步
.pi/skills/log-forwarding.md  pi 项目 skill（用法 + 边界调研结论）
```

### 本地构建（不经 npm）

```bash
go build -o ~/.pi/agent/bin/pi-logfwd ./cmd/pi-logfwd   # 单二进制，无配置依赖
# 或放 PATH；扩展解析顺序第 3/4 步会找到它
```

### 发布（Go 二进制 + npm 包一体）

所有包共用同一版本号（主包 + 4 个平台包），一条命令完成：

```bash
scripts/release.sh 0.1.0                 # 构建矩阵 + 打包 dry-run（验证内容，不发）
scripts/release.sh 0.1.0 --publish       # 真发布
# 然后 git tag v0.1.0 && git push --tags
```

发布流程：`go build`（CGO_ENABLED=0，`GOOS/GOARCH` 矩阵）→ 每个平台生成只含二进制的 npm 平台包（`os`/`cpu` 字段匹配）→ 依次 `npm publish --access public` → 主包最后发。

> 平台包命名 `@sukeai/pi-logfwd-<os>-<arch>`，每个包 `bin: { "pi-logfwd": "bin/pi-logfwd" }`——npm 会把匹配平台的二进制链入 `node_modules/.bin`。

### 备注

- 新增平台：在 `scripts/release.sh` 的 `PLATFORMS` 加一行 + `package.json` 的 `optionalDependencies` 加对应项；Windows 除外（见上）。
- 本仓库 LICENSE 沿用 pi-fun-placeholder 先例（MIT / robotnoname）；如需改署名，替换 `LICENSE` 与两处 `package.json` 的 license 说明即可。
