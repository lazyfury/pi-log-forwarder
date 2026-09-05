/**
 * pi-logfwd - pi package extension registering a "bash" tool that REPLACES
 * pi's built-in (buffered) bash.
 *
 * 为什么注册名用 bash：pi 的工具注册表里与内置工具同名的扩展工具会覆盖内置定义
 * （_refreshToolRegistry：先放 built-in，再按工具名 set 扩展工具）。注册成 bash
 * 后，模型每次调用 bash 都固定走 pi-logfwd（PTY + 实时流式转发 + 可选日志文件），
 * 不再存在 "bash / bash_logged 由模型随缘二选一" 的触发不规律问题。
 *
 * Runs commands through the Go binary `pi-logfwd` (PTY, real-time log
 * forwarding, optional log file). Streaming chunks are pushed into the
 * conversation via onUpdate, so output appears as it happens instead of
 * being buffered until the process exits. Output longer than MAX_CHARS is
 * mirrored to a temp file (reported at the end) instead of silently losing
 * its head - the safety net pi's built-in bash used to provide via
 * temp files.
 *
 * Binary resolution order (checked on every execute):
 *   1. env PI_LOG_FWD_BIN                      (explicit override)
 *   2. bundled platform package                (@sukeai/pi-logfwd-<os>-<arch>,
 *                                              installed via optionalDependencies)
 *   3. ~/.pi/agent/bin/pi-logfwd               (legacy local install)
 *   4. PATH 上的 pi-logfwd                     (legacy, spawn-by-name fallback)
 *
 * Platform support: darwin (arm64/amd64) + linux (arm64/amd64) ship prebuilt
 * binaries through npm optionalDependencies; npm installs only the package
 * matching the current os/cpu and silently skips the rest. Windows is NOT
 * supported (creack/pty returns ErrUnsupported on Windows, so the PTY core
 * cannot work) - on win32 the tool returns an explicit notice instead of a
 * cryptic spawn failure.
 *
 * Install:
 *   pi install npm:@sukeai/pi-logfwd    # 推荐：随包自动装当前平台二进制
 *
 *   装好后 /reload 即覆盖内置 bash（所有 shell 命令经 pi-logfwd 实时转发）；
 *   想还原内置 bash：pi remove npm:@sukeai/pi-logfwd 后 /reload。
 *
 * Dev / manual overrides:
 *   PI_LOG_FWD_BIN=/path/to/pi-logfwd   # 指向自建/自编译二进制
 *   cd cmd/pi-logfwd && go build -o ~/.pi/agent/bin/pi-logfwd ./cmd/pi-logfwd
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const MAX_CHARS = 60_000; // 会话文本保留的尾部上限；超出部分镜像到临时文件并报告路径
const STREAM_INTERVAL_MS = 150;

/** Prebuilt binary platform packages published alongside this package. */
const COMPANION_PREFIX = "@sukeai/pi-logfwd-";
const COMPANION_ARCHES = new Set(["arm64", "x64"]);

type Resolution =
	| { ok: true; bin: string }
	| { ok: false; bin: string | null; notice: string };

/**
 * Resolve the pi-logfwd binary for the current platform. Returns a binary
 * path when found, or a human-readable notice explaining how to fix it
 * (or why the platform is unsupported).
 */
function resolveBin(): Resolution {
	// 1. Explicit override. If it is set but missing, say so - do not
	//    silently fall through, the user clearly wanted this exact path.
	const fromEnv = process.env.PI_LOG_FWD_BIN;
	if (fromEnv) {
		if (existsSync(fromEnv)) return { ok: true, bin: fromEnv };
		return {
			ok: false,
			bin: null,
			notice: `PI_LOG_FWD_BIN 指向的文件不存在: ${fromEnv}`,
		};
	}

	// 2. Windows is unsupported by design: creack/pty (the PTY layer pi-logfwd
	//    relies on) returns ErrUnsupported on Windows, so no win32 prebuilt
	//    package is published and the PTY core cannot work there.
	if (process.platform === "win32") {
		return {
			ok: false,
			bin: null,
			notice:
				"Windows 不受支持: pi-logfwd 的 PTY 依赖 (creack/pty) 在 Windows 上返回 ErrUnsupported，未发布 win32 预编译包。\n" +
				"建议: 在 WSL / 容器中运行 pi 以使用本 bash 工具（实时转发）。\n" +
				"自行交叉编译仅管道版本 (--no-pty，无 PTY) 后，可设 PI_LOG_FWD_BIN 指向该二进制以绕过此提示。",
		};
	}

	// 3. Bundled platform package (installed by npm from optionalDependencies,
	//    only the one matching os/cpu is present).
	const archOk = COMPANION_ARCHES.has(process.arch);
	if (archOk) {
		const companion = COMPANION_PREFIX + `${process.platform}-${process.arch}`;
		try {
			const pkgRoot = dirname(require.resolve(`${companion}/package.json`));
			const bin = join(pkgRoot, "bin", "pi-logfwd");
			if (existsSync(bin)) return { ok: true, bin };
		} catch {
			/* companion not installed - keep resolving */
		}
	}

	// 4. Legacy local install location (keep working for existing setups).
	const agentBin = join(homedir(), ".pi", "agent", "bin", "pi-logfwd");
	if (existsSync(agentBin)) return { ok: true, bin: agentBin };

	// 5. PATH fallback: spawn by name and let ENOENT surface a clear error.
	const platformTag =
		process.platform === "darwin" || process.platform === "linux"
			? `${process.platform}-${process.arch}`
			: process.platform;
	return {
		ok: false,
		bin: "pi-logfwd",
		notice:
			`未找到 pi-logfwd 二进制 (平台 ${platformTag}${archOk ? "" : "，无对应预编译包"})。安装方式任选其一:\n` +
			"  1. pi install npm:@sukeai/pi-logfwd    # 推荐: 随包自动安装当前平台预编译二进制\n" +
			"  2. go build -o <bin> ./cmd/pi-logfwd   # 本仓库自行编译后设 PI_LOG_FWD_BIN=<bin>\n" +
			"  3. 把 pi-logfwd 放入 PATH 或 ~/.pi/agent/bin/pi-logfwd",
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Run a bash command in the current working directory through pi-logfwd (PTY, real-time " +
			"log forwarding). Output is streamed back in real time instead of being buffered until " +
			"the process exits; the conversation keeps the last 60000 chars and longer output is " +
			"mirrored to a temp file whose path is reported at the end. The real exit status is never " +
			"silent: a non-zero exit appends `(exit code: N)` and a tool-timeout kill appends " +
			"`(timed out after Ns, exit code 124)` at the end of the result. This tool replaces " +
			"pi's built-in buffered bash. NOT supported: interactive secret prompts (sudo/ssh " +
			"password) and GUI authorization dialogs - PTY can render a prompt but nothing can " +
			"answer it, so tell the user to run those manually. Optionally provide a timeout " +
			"(seconds), cwd, logFile to append to, or noPty.",
		promptSnippet: "Execute bash commands (ls, grep, find, etc.) with real-time streamed output (PTY)",
		promptGuidelines: [
			"You can inspect PI_* environment variables for current model and session details.",
		],
		// 自定义 renderCall：TUI 里完整显示命令，并追加一行 log-fwd 标签标识「经 pi-logfwd 实时转发」
			renderCall(args, theme, _context) {
				const command = typeof args.command === "string" ? args.command : "";
				const commandDisplay = command || theme.fg("toolOutput", "...");
				let text = theme.fg("toolTitle", theme.bold(commandDisplay));
				if (typeof args.timeout === "number") {
					text += theme.fg("muted", ` (timeout ${args.timeout}s)`);
				}
				const tag = theme.fg("dim", theme.bold("log-fwd"));
				return new Text(`${text}\n${tag}`, 0, 0);
			},
		parameters: Type.Object({
			command: Type.String({ description: "Shell script or command to run" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: none)" })),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
			logFile: Type.Optional(Type.String({ description: "Append forwarded logs to this file" })),
			noPty: Type.Optional(
				Type.Boolean({ description: "Run without a pseudo-terminal (stdout/stderr stay separate)" }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Resolve the binary on every call: the package (and with it the
			// companion binary) may be added/updated between pi restarts, and a
			// missing binary should produce a clear notice instead of ENOENT.
			const res = resolveBin();
			if (!res.ok) {
				return {
					content: [{ type: "text", text: `bash (pi-logfwd) 不可用:\n${res.notice}` }],
					details: { exitCode: null, forwarded: false, reason: "binary-unavailable" },
				};
			}

			const args = ["run"];
			if (params.noPty) args.push("--no-pty");
			if (params.cwd) args.push("--cwd", params.cwd);
			if (params.logFile) args.push("--log-file", params.logFile);
			if (params.timeout) args.push("--timeout", `${params.timeout}s`);
			args.push("--", params.command);

			const child = spawn(res.bin, args, { cwd: ctx.cwd, env: process.env });

			// 全量镜像到临时文件（原内置 bash 的“完整输出”兜底）：输出 <= MAX_CHARS 时删除
			// 临时文件；超长时在结果末尾报告文件路径。会话文本始终只保留尾部 MAX_CHARS。
			let totalChars = 0;
			let tail = "";
			let lastStream = 0;
			let logPath: string | null = null;
			let logStream: import("node:fs").WriteStream | null = null;
			const push = (chunk: string) => {
				totalChars += chunk.length;
				if (!logStream) {
					logPath = join(tmpdir(), `pi-logfwd-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`);
					logStream = createWriteStream(logPath, { flags: "a" });
				}
				logStream.write(chunk);
				tail = (tail + chunk).slice(-MAX_CHARS);
				const now = Date.now();
				if (now - lastStream > STREAM_INTERVAL_MS) {
					lastStream = now;
					onUpdate?.({ content: [{ type: "text", text: tail }] });
				}
			};

			// 消费 JSONL：output 事件进流式文本；exit 事件携带「真正」的命令退出码
			// （超时被杀为 124 + message "killed by --timeout"）。child(Go 进程) 的 close
			// code 虽经 os.Exit 透传命令退出码，但 Go 自身报错/被杀时即偏离、且丢失
			// timeout 的 message 与 durationMs；故一律以 exit 事件为准，close code 仅在
			// 事件缺失时兜底。
			type ExitInfo = { code: number | null; durationMs: number; message: string };
			let exitEv: ExitInfo | null = null;
			const rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				try {
					const ev = JSON.parse(line);
					if (ev.event === "output") {
						push(ev.data);
					} else if (ev.event === "exit") {
						exitEv = {
							code: typeof ev.code === "number" ? ev.code : null,
							durationMs: typeof ev.durationMs === "number" ? ev.durationMs : 0,
							message: typeof ev.message === "string" ? ev.message : "",
						};
					}
				} catch {
					/* ignore malformed lines */
				}
			});

			let goExitCode: number | null = null; // child(Go 进程) 自身退出码，仅作 exit 事件缺失时的兜底
			let errText = "";
			child.stderr.on("data", (d: Buffer) => (errText += d.toString()));
			child.on("error", (e: Error) => {
				if (e && (e as NodeJS.ErrnoException).code === "ENOENT") {
					errText += `\nbash (pi-logfwd) 不可用: ${res.bin} 不存在或不可执行。\n${res.notice}`;
				} else {
					errText += `pi-logfwd: ${e.message}\n`;
				}
			});
			child.on("close", (c) => (goExitCode = c));
			signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });

			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				child.on("close", finish);
				child.on("error", finish);
			});

			// 关闭日志流；只在文本被截断（输出超长）时保留临时文件
			if (logStream) {
				await new Promise<void>((r) => logStream!.end(() => r()));
				if (totalChars <= MAX_CHARS && logPath) {
					try {
						await rm(logPath, { force: true });
					} catch {
						/* best-effort cleanup */
					}
					logPath = null;
				}
			}

			// 真退出码优先（exit 事件）；只有 Go 进程异常退出（未发 exit 事件）时才退回其进程退出码。
			const exitCode = exitEv ? exitEv.code : goExitCode;
			// 超时判据只看 exit 事件 message：Go 端仅在 timeout 杀死时写 "killed by --timeout"；
			// 命令自己 exit 124（如 gnu timeout 惯例）时 message 为空，不应误判为超时。
			const timedOut = /timeout/i.test(exitEv?.message ?? "");

			const text = tail || "(no output)";
			const notes: string[] = [];
			if (timedOut) {
				const t =
					typeof params.timeout === "number"
						? `${params.timeout}s`
						: `${((exitEv?.durationMs ?? 0) / 1000).toFixed(1)}s`;
				notes.push(`(timed out after ${t}, exit code 124)`);
			} else if (exitCode !== null && exitCode !== 0) {
				notes.push(`(exit code: ${exitCode})`);
			}

			let resultText = errText ? `${text}\n${errText.trimEnd()}` : text;
			if (notes.length) resultText += `\n${notes.join("\n")}`;
			if (logPath) resultText += `\n(输出超长，完整日志已存 ${logPath})`;
			return {
				content: [{ type: "text", text: resultText }],
				details: {
					exitCode,
					forwarded: true,
					timedOut,
					durationMs: exitEv?.durationMs ?? null,
					logFile: params.logFile ?? null,
				},
			};
		},
	});
}
