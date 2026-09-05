/**
 * pi-logfwd - pi package extension registering a "bash_logged" tool.
 *
 * Runs commands through the Go binary `pi-logfwd` (PTY, real-time log
 * forwarding, optional log file). Streaming chunks are pushed into the
 * conversation via onUpdate, so output appears as it happens instead of
 * being buffered and truncated by the built-in bash tool.
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
 * Dev / manual overrides:
 *   PI_LOG_FWD_BIN=/path/to/pi-logfwd   # 指向自建/自编译二进制
 *   cd cmd/pi-logfwd && go build -o ~/.pi/agent/bin/pi-logfwd ./cmd/pi-logfwd
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const MAX_CHARS = 60_000;
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
				"建议: 在 WSL / 容器中运行 pi 以使用 bash_logged。\n" +
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
		name: "bash_logged",
		label: "Bash (streamed log forward)",
		description:
			"Run a shell command or script through pi-logfwd and stream its logs back in real time. " +
			"Prefer bash_logged over bash when you need: (a) real-time output streaming instead of " +
			"end-buffered/truncated output, (b) a command that requires a pseudo-terminal (PTY), or " +
			"(c) a persistent log file. " +
			"NOT supported by any pi tool (including this one): interactive secret prompts " +
			"(sudo/ssh password) and GUI authorization dialogs - PTY can render a prompt but nothing " +
			"can answer it. For those, tell the user to run the command manually.",
		promptSnippet: "Run a shell command with real-time log forwarding (PTY support)",
		// 自定义 renderCall：TUI 里完整显示命令，并追加一行 log-fwd 标签标识控制来源
			renderCall(args, theme, _context) {
				const command = typeof args.command === "string" ? args.command : "";
				const commandDisplay = command || theme.fg("toolOutput", "...");
				let text = theme.fg("toolTitle", theme.bold(`bash_logged ${commandDisplay}`));
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
					content: [{ type: "text", text: `bash_logged 不可用:\n${res.notice}` }],
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

			let accumulated = "";
			let lastStream = 0;
			const push = (chunk: string) => {
				accumulated += chunk;
				if (accumulated.length > MAX_CHARS * 2) accumulated = accumulated.slice(-MAX_CHARS);
				const now = Date.now();
				if (now - lastStream > STREAM_INTERVAL_MS) {
					lastStream = now;
					onUpdate?.({ content: [{ type: "text", text: accumulated.slice(-MAX_CHARS) }] });
				}
			};

			const rl = createInterface({ input: child.stdout });
			rl.on("line", (line) => {
				try {
					const ev = JSON.parse(line);
					if (ev.event === "output") push(ev.data);
				} catch {
					/* ignore malformed lines */
				}
			});

			let exitCode: number | null = null;
			let errText = "";
			child.stderr.on("data", (d: Buffer) => (errText += d.toString()));
			child.on("error", (e: Error) => {
				if (e && (e as NodeJS.ErrnoException).code === "ENOENT") {
					errText += `\nbash_logged 不可用: ${res.bin} 不存在或不可执行。\n${res.notice}`;
				} else {
					errText += `pi-logfwd: ${e.message}\n`;
				}
			});
			child.on("close", (c) => (exitCode = c));
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

			const text = (accumulated || "(no output)").slice(-MAX_CHARS);
			const resultText = errText ? `${text}\n${errText.trimEnd()}` : text;
			return {
				content: [{ type: "text", text: resultText }],
				details: { exitCode, forwarded: true, logFile: params.logFile ?? null },
			};
		},
	});
}
