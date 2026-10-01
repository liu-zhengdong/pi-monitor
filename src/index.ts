// 后台监视：把「盯着某个东西，有变化告诉我」交给一个长期运行的 monitor，
// 工具本身立刻返回，事件以通知的形式回到会话里。
//
// 三种源：
//   tail   跟一个文件的新增行（从当前末尾开始，等价于 tail -f）
//   poll   每隔 interval_sec 跑一次命令，输出有增量时报告（可再用 pattern 过滤）
//   watch  盯一个目录（递归），文件增删改时报告
//
// 为什么不让模型自己循环 sleep：那会占住整个回合。这里 monitor 活在回合之外，
// 事件按 minNotifyIntervalSec 合并成一条通知，由通知唤醒新的回合。
//
// 三道闸门防止把会话刷爆：单条通知最多 maxLinesPerNotification 行、
// 同一 monitor 通知间隔不小于 minNotifyIntervalSec、总共最多 maxNotifications 条，
// 到顶自动停并说明原因。期限到点也自动停（默认 300s，上限 1800s）。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type MonitorConfig,
	type ResolvedConfig,
	globalConfigPath,
	projectConfigPath,
	resolveConfig,
	resolveTimeout,
} from "./config.ts";
import { compilePattern, formatDuration } from "./events.ts";
import {
	type MonitorBatch,
	type MonitorSpec,
	type MonitorSource,
	type MonitorSnapshot,
	MonitorManager,
} from "./monitors.ts";

export const MESSAGE_TYPE = "monitor";
const STATUS_KEY = "monitor";

const monitorIdSchema = Type.String({ description: 'Monitor id returned by monitor, e.g. mon1, or "all"' });

// ---- shell 设置：poll 命令沿用 Pi settings 里的 shellPath / shellCommandPrefix ----

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

export function readShellSettings(agentDir: string, cwd: string, projectTrusted: boolean): { shellPath?: string; commandPrefix?: string } {
	const layers = [readJson(join(agentDir, "settings.json"))];
	if (projectTrusted) layers.push(readJson(join(cwd, ".pi", "settings.json")));
	let shellPath: string | undefined;
	let commandPrefix: string | undefined;
	for (const layer of layers) {
		if (!layer) continue;
		if (typeof layer.shellPath === "string" && layer.shellPath) shellPath = layer.shellPath;
		if (typeof layer.shellCommandPrefix === "string") commandPrefix = layer.shellCommandPrefix || undefined;
	}
	if (shellPath?.startsWith("~/")) shellPath = join(homedir(), shellPath.slice(2));
	return { shellPath, commandPrefix };
}

// ---- 文案 ----

export function formatTarget(monitor: Pick<MonitorSnapshot, "id" | "source" | "target" | "label">): string {
	const label = monitor.label ? `${monitor.label} · ` : "";
	return `${monitor.id} · ${label}${monitor.source} ${monitor.target}`;
}

export function batchHead(batch: MonitorBatch): string {
	const monitor = batch.monitor;
	const pattern = monitor.spec.pattern ? ` (pattern: ${monitor.spec.pattern.source})` : "";
	const count = batch.lines.length + batch.more;
	const what = batch.notice !== undefined ? "stopped" : `${count} new event${count === 1 ? "" : "s"}`;
	return `${formatTarget(monitor.snapshot())}${pattern} — ${what}`;
}

export function notificationText(batches: MonitorBatch[]): string {
	const blocks: string[] = [];
	for (const batch of batches) {
		const lines = [batchHead(batch), ...batch.lines];
		if (batch.more > 0) lines.push(`…and ${batch.more} more event(s) suppressed`);
		if (batch.notice !== undefined) lines.push(batch.notice);
		blocks.push(lines.join("\n"));
	}
	return `<monitor-notification>\n${blocks.join("\n\n")}\n</monitor-notification>`;
}

export function startText(monitor: MonitorSnapshot, intervalSec: number): string {
	const pattern = monitor.pattern ? `, pattern ${JSON.stringify(monitor.pattern)}` : "";
	const every = monitor.source === "poll" ? `runs every ${intervalSec}s, ` : monitor.source === "tail" ? `checked every ${intervalSec}s, ` : "";
	return [
		`Monitor ${formatTarget(monitor)} started${pattern}.`,
		`It ${monitor.source === "poll" ? "polls" : "watches"} in the background (${every}expires in ${formatDuration(monitor.expiresAt - Date.now())}).`,
		"You will get a notification when something matches. Keep working or end your turn - do not poll it yourself. Stop it with monitor_stop when you no longer need it.",
	].join("\n");
}

function listLine(monitor: MonitorSnapshot): string {
	const life = monitor.running
		? `running ${formatDuration(Date.now() - monitor.startedAt)}/${formatDuration(monitor.expiresAt - monitor.startedAt)}`
		: `stopped (${monitor.stopReason ?? "unknown"})${monitor.error ? `: ${monitor.error}` : ""}`;
	return `${formatTarget(monitor)}${monitor.pattern ? ` (pattern: ${monitor.pattern})` : ""}  ${life}  ${monitor.eventCount} event(s), ${monitor.notificationCount} notification(s)`;
}

function quotaText(config: MonitorConfig): string {
	const maxTimeout = config.maxTimeoutSec > 0 ? `${config.maxTimeoutSec}s` : "不限";
	return `limit: ${config.maxConcurrent} concurrent, ${config.defaultTimeoutSec}s default (max ${maxTimeout}), at most ${config.maxNotifications} notifications per monitor`;
}

// ---- 扩展 ----

export default function monitorExtension(pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let uiCtx: ExtensionContext | undefined;
	let manager: MonitorManager | undefined;
	let boot = resolveConfig({ agentDir });

	const currentConfig = (ctx?: ExtensionContext): ResolvedConfig => {
		const resolved = resolveConfig({ agentDir, cwd: ctx?.cwd, projectTrusted: ctx ? safeTrusted(ctx) : false });
		boot = resolved;
		return resolved;
	};

	const getManager = (): MonitorManager => {
		if (manager) return manager;
		manager = new MonitorManager(
			() => boot.config,
			{
				notify: (batches) => {
					try {
						pi.sendMessage(
							{
								customType: MESSAGE_TYPE,
								content: notificationText(batches),
								display: true,
								details: {
									batches: batches.map((batch) => ({
										id: batch.monitor.id,
										source: batch.monitor.spec.source,
										target: batch.monitor.target,
										label: batch.monitor.spec.label,
										events: batch.lines.length + batch.more,
										stopped: batch.notice !== undefined ? (batch.monitor.stopReason ?? "stopped") : undefined,
									})),
								},
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					} catch {
						// session 已经不在了
					}
				},
				isBusy: () => {
					try {
						return uiCtx !== undefined && !uiCtx.isIdle();
					} catch {
						return false;
					}
				},
				onChange: () => refreshUi(),
			},
		);
		return manager;
	};

	const buildSpec = (params: MonitorParams, config: MonitorConfig, ctx: ExtensionContext): MonitorSpec => {
		const source = params.source as MonitorSource;
		if (source === "poll") {
			if (!params.command?.trim()) throw new Error("source=poll 需要 command");
		} else if (!params.path?.trim()) {
			throw new Error(`source=${source} 需要 path`);
		}
		const pattern = compilePattern(params.pattern);
		const fallback = source === "tail" ? 1 : 5;
		const requested = typeof params.interval_sec === "number" && Number.isFinite(params.interval_sec) && params.interval_sec > 0 ? params.interval_sec : fallback;
		const intervalSec = Math.max(0.2, requested);
		const timeoutSec = resolveTimeout(params.timeout_sec, config);
		const shellSettings = source === "poll" ? readShellSettings(agentDir, ctx.cwd, safeTrusted(ctx)) : { shellPath: undefined, commandPrefix: undefined };
		const command = params.command === undefined ? undefined : shellSettings.commandPrefix ? `${shellSettings.commandPrefix}\n${params.command}` : params.command;
		return {
			source,
			path: params.path,
			command,
			pattern,
			intervalSec,
			timeoutSec,
			label: params.label,
			cwd: ctx.cwd,
			env: process.env,
			shell: source === "poll" ? getShellConfig(shellSettings.shellPath) : undefined,
		};
	};

	pi.registerTool({
		name: "monitor",
		label: "monitor",
		description: [
			"Start a background monitor and return immediately: it keeps watching after this turn ends and sends you a notification when something happens.",
			"source=tail follows new lines appended to a file (starts at the current end, like tail -f); source=poll runs a command every interval_sec and reports output changes; source=watch reports filesystem changes under a directory (recursive).",
			"Use it to wait for a build to finish, a log to show an error, a port to open, or files to appear - without blocking or polling in a loop yourself.",
			`It expires on its own (timeout_sec) and stops itself if it floods (${quotaText(boot.config)}). Stop it earlier with monitor_stop.`,
		].join(" "),
		promptSnippet: "Watch a file, command or directory in the background and get notified on changes",
		parameters: Type.Object({
			source: Type.Union([Type.Literal("tail"), Type.Literal("poll"), Type.Literal("watch")], {
				description: "what to monitor: tail a file, poll a command, or watch a directory",
			}),
			path: Type.Optional(Type.String({ description: "file to follow (source=tail) or directory to watch recursively (source=watch)" })),
			command: Type.Optional(Type.String({ description: "shell command to run every interval_sec (source=poll)" })),
			pattern: Type.Optional(Type.String({ description: "regular expression; only matching lines (tail/poll) or matching file paths (watch) are reported" })),
			interval_sec: Type.Optional(Type.Number({ description: "how often to check: poll interval (default 5s) or file check interval for tail (default 1s)" })),
			timeout_sec: Type.Optional(Type.Number({ description: `how long the monitor lives; default ${boot.config.defaultTimeoutSec}s, max ${boot.config.maxTimeoutSec > 0 ? `${boot.config.maxTimeoutSec}s` : "unlimited"}` })),
			label: Type.Optional(Type.String({ description: "short label shown in notifications and monitor_list" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolved = currentConfig(ctx);
			const spec = buildSpec(params, resolved.config, ctx);
			const monitor = getManager().start(spec);
			const snapshot = monitor.snapshot();
			if (!snapshot.running) throw new Error(`monitor 启动失败：${snapshot.error ?? snapshot.stopReason ?? "unknown error"}`);
			refreshUi();
			return {
				content: [{ type: "text" as const, text: startText(snapshot, spec.intervalSec) }],
				details: { monitorId: snapshot.id, source: snapshot.source, target: snapshot.target, timeoutSec: spec.timeoutSec, pattern: snapshot.pattern },
			};
		},
	});

	pi.registerTool({
		name: "monitor_list",
		label: "monitor list",
		description: "List the monitors of this session (running first, then the ones that already stopped) with their event and notification counts.",
		promptSnippet: "List background monitors",
		parameters: Type.Object({}),
		async execute() {
			const monitors = manager?.list() ?? [];
			if (monitors.length === 0) return { content: [{ type: "text" as const, text: "No monitors in this session." }], details: { monitors: [] } };
			const running = monitors.filter((m) => m.running).length;
			return {
				content: [{ type: "text" as const, text: `${running} running, ${monitors.length - running} stopped:\n${monitors.map(listLine).join("\n\n")}` }],
				details: { monitors: monitors.map((m) => ({ ...m })) },
			};
		},
	});

	pi.registerTool({
		name: "monitor_stop",
		label: "monitor stop",
		description: "Stop a monitor (or all of them) and return everything it collected since the last notification.",
		promptSnippet: "Stop a background monitor",
		parameters: Type.Object({
			id: monitorIdSchema,
		}),
		async execute(_toolCallId, params) {
			const mgr = manager;
			if (!mgr) throw new Error("这个会话里还没有 monitor。");
			const { stopped, missing } = mgr.stop(String(params.id).trim());
			if (stopped.length === 0) {
				const known = mgr.list().map((m) => `${m.id} (${m.running ? "running" : "stopped"})`);
				throw new Error(`Unknown monitor: ${missing.join(", ")}.${known.length ? ` Known monitors: ${known.join(", ")}` : " There are no monitors in this session."}`);
			}
			refreshUi();
			const blocks = stopped.map((monitor) => {
				const snapshot = monitor.snapshot();
				const pending = mgr.takePending(monitor.id);
				const head = `Stopped ${formatTarget(snapshot)} after ${formatDuration(Date.now() - snapshot.startedAt)}: ${snapshot.eventCount} event(s), ${snapshot.notificationCount} notification(s) already sent.`;
				const collected = [...pending.lines];
				if (pending.more > 0) collected.push(`…and ${pending.more} more event(s)`);
				return collected.length === 0 ? head : `${head}\nNot yet reported:\n${collected.join("\n")}`;
			});
			return {
				content: [{ type: "text" as const, text: blocks.join("\n\n") }],
				details: { stopped: stopped.map((m) => m.id), missing },
			};
		},
	});

	// ---- 给用户看的：状态栏与 /monitor ----

	const refreshUi = (): void => {
		const ctx = uiCtx;
		if (!ctx?.hasUI) return;
		const running = manager?.list().filter((m) => m.running).length ?? 0;
		try {
			ctx.ui.setStatus(STATUS_KEY, running > 0 ? ctx.ui.theme.fg("accent", `◉ ${running} monitoring`) : undefined);
		} catch {
			// 忽略
		}
	};

	const SUBCOMMANDS = ["list", "status", "stop"];

	pi.registerCommand("monitor", {
		description: "Background monitors: list | status | stop <id|all>",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
				return items.length ? items : null;
			}
			if (parts[0] === "stop") {
				const ids = (manager?.list() ?? []).filter((m) => m.running).map((m) => m.id);
				ids.push("all");
				const items = ids.filter((id) => id.startsWith(parts[1] ?? "")).map((id) => ({ value: `stop ${id}`, label: id }));
				return items.length ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [sub = "list", arg] = args.trim().split(/\s+/).filter(Boolean);
			const monitors = manager?.list() ?? [];
			switch (sub) {
				case "status": {
					const resolved = currentConfig(ctx);
					const running = monitors.filter((m) => m.running);
					const lines = [
						`running: ${running.length === 0 ? "none" : running.map((m) => m.id).join(", ")}`,
						`config: ${globalConfigPath(agentDir)}${safeTrusted(ctx) ? `, ${projectConfigPath(ctx.cwd)}` : ""}`,
						quotaText(resolved.config),
					];
					if (resolved.errors.length > 0) lines.push(...resolved.errors.map((e) => `⚠ ${e}`));
					return ctx.ui.notify(lines.join("\n"), "info");
				}
				case "list": {
					if (monitors.length === 0) return ctx.ui.notify("No monitors in this session", "info");
					return ctx.ui.notify(monitors.map(listLine).join("\n\n"), "info");
				}
				case "stop": {
					if (!manager) return ctx.ui.notify("No monitors in this session", "info");
					if (!arg) return ctx.ui.notify("Usage: /monitor stop <id|all>", "error");
					const { stopped, missing } = manager.stop(arg);
					if (missing.length > 0) return ctx.ui.notify(`Not running: ${missing.join(", ")}`, "error");
					refreshUi();
					return ctx.ui.notify(`Stopped: ${stopped.map((m) => m.id).join(", ")}`, "info");
				}
				default:
					return ctx.ui.notify(`Unknown subcommand: ${sub}. Use ${SUBCOMMANDS.join(" | ")}`, "error");
			}
		},
	});

	// ---- 渲染：通知折叠成一行，展开看内容 ----

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const raw = typeof message.content === "string" ? message.content : (message.content as Array<{ text?: string }>).map((c) => c?.text ?? "").join("\n");
		const body = raw.replace(/^<monitor-notification>\n?/, "").replace(/\n?<\/monitor-notification>$/, "");
		const details = (message.details ?? {}) as { batches?: Array<{ id: string; events?: number; stopped?: string }> };
		const summary = (details.batches ?? [])
			.map((b) => (b.stopped ? theme.fg("warning", `${b.id} stopped`) : theme.fg("accent", `${b.id} ${b.events ?? 0} event(s)`)))
			.join(", ");
		const header = `${theme.fg("accent", "◉ monitor")}${summary ? ` ${summary}` : ""}`;
		return new Text(options.expanded ? `${header}\n${theme.fg("dim", body)}` : header, options.outputPad, 0);
	});

	// ---- 生命周期 ----

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		const resolved = currentConfig(ctx);
		if (resolved.errors.length > 0 && ctx.hasUI) ctx.ui.notify(`monitor config:\n${resolved.errors.join("\n")}`, "warning");
		refreshUi();
	});

	pi.on("agent_settled", async () => {
		manager?.flush();
	});

	pi.on("session_shutdown", async () => {
		manager?.shutdown();
		manager = undefined;
		try {
			uiCtx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// 忽略
		}
		uiCtx = undefined;
	});
}

interface MonitorParams {
	source: string;
	path?: string;
	command?: string;
	pattern?: string;
	interval_sec?: number;
	timeout_sec?: number;
	label?: string;
}

function safeTrusted(ctx: ExtensionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}
