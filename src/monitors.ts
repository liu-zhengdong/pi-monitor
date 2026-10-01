// monitor 的运行体与通知调度：三种源（tail / poll / watch）、期限、事件合并。
//
// 这里不依赖 pi：宿主通过两个回调决定怎么把事件交给模型（notify / isBusy），
// 所以源逻辑和配额逻辑可以用 node 直接跑测试。
//
// 通知有两层合并：源自己先合并（watch 的短窗去重、poll 的输出增量），
// 管理器再按 minNotifyIntervalSec 把同一 monitor 的事件攒成一条通知。

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync, watch as fsWatch, type FSWatcher, type Stats } from "node:fs";
import type { MonitorConfig } from "./config.ts";
import { cleanLine, cleanText, formatDuration, linesAfterCommonPrefix, truncate } from "./events.ts";

export type MonitorSource = "tail" | "poll" | "watch";
export type StopReason = "timeout" | "stopped" | "limit" | "error" | "shutdown";

/** 单次读取文件的上限，防止一次读进超大日志。 */
const MAX_READ_BYTES = 1024 * 1024;
/** poll 单次命令的输出上限。 */
const MAX_POLL_OUTPUT_CHARS = 256 * 1024;
/** poll 单次命令最多跑多久，超了就杀掉，避免拖住下一轮。 */
const POLL_RUN_LIMIT_MS = 120_000;
/** 事件攒多久发一次。 */
const NOTIFY_DEBOUNCE_MS = 500;
/** Agent 还在跑时多久重试一次投递。 */
const BUSY_RETRY_MS = 3000;
/** 保留多少个已结束的 monitor 供 monitor_list 查询。 */
const MAX_FINISHED = 20;
/** watch 启动后忽略这么久内的变动：macOS 的 FSEvents 会把注册前刚发生的事件补报一遍。 */
const WATCH_STARTUP_GRACE_MS = 300;

export interface MonitorSpec {
	source: MonitorSource;
	path?: string;
	command?: string;
	pattern?: RegExp;
	intervalSec: number;
	timeoutSec: number;
	label?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: { shell: string; args: string[] };
}

export interface MonitorSnapshot {
	id: string;
	source: MonitorSource;
	target: string;
	label?: string;
	pattern?: string;
	startedAt: number;
	expiresAt: number;
	eventCount: number;
	notificationCount: number;
	lastEventAt?: number;
	running: boolean;
	stopReason?: StopReason;
	error?: string;
}

export class Monitor {
	readonly id: string;
	readonly spec: MonitorSpec;
	readonly startedAt: number;
	readonly expiresAt: number;
	eventCount = 0;
	notificationCount = 0;
	stopReason?: StopReason;
	error?: string;
	lastEventAt?: number;
	stopped = false;

	private readonly config: MonitorConfig;
	private readonly sink: (monitor: Monitor, text: string) => void;
	private readonly closed: (monitor: Monitor) => void;
	private expireTimer?: NodeJS.Timeout;
	private watcher?: FSWatcher;
	private pollTimer?: NodeJS.Timeout;
	private pollRunTimer?: NodeJS.Timeout;
	private pollChild?: ChildProcess;
	private pollBusy = false;
	private pollSeen = false;
	private pollLastOutput = "";
	private pollLastExit: number | null | undefined;
	private pollKilledRun = false;
	private offset = 0;
	private tailIno?: number;
	private tailSeen = false;
	private carry = "";
	private tailTimer?: NodeJS.Timeout;
	private watchBuffer = new Map<string, string>();
	private watchTimer?: NodeJS.Timeout;

	constructor(id: string, spec: MonitorSpec, config: MonitorConfig, sink: (monitor: Monitor, text: string) => void, closed: (monitor: Monitor) => void) {
		this.id = id;
		this.spec = spec;
		this.config = config;
		this.sink = sink;
		this.closed = closed;
		this.startedAt = Date.now();
		this.expiresAt = this.startedAt + spec.timeoutSec * 1000;
	}

	get running(): boolean {
		return !this.stopped;
	}

	get target(): string {
		return this.spec.source === "poll" ? (this.spec.command ?? "") : (this.spec.path ?? "");
	}

	snapshot(): MonitorSnapshot {
		return {
			id: this.id,
			source: this.spec.source,
			target: this.target,
			label: this.spec.label,
			pattern: this.spec.pattern?.source,
			startedAt: this.startedAt,
			expiresAt: this.expiresAt,
			eventCount: this.eventCount,
			notificationCount: this.notificationCount,
			lastEventAt: this.lastEventAt,
			running: this.running,
			stopReason: this.stopReason,
			error: this.error,
		};
	}

	start(): void {
		this.expireTimer = setTimeout(() => this.stop("timeout"), this.spec.timeoutSec * 1000);
		this.expireTimer.unref?.();
		try {
			if (this.spec.source === "tail") this.startTail();
			else if (this.spec.source === "watch") this.startWatch();
			else this.startPoll();
		} catch (err) {
			this.stop("error", err instanceof Error ? err.message : String(err));
		}
	}

	stop(reason: StopReason, detail?: string): void {
		if (this.stopped) return;
		this.stopped = true;
		this.stopReason = reason;
		if (detail !== undefined) this.error = detail;
		this.cleanup();
		this.closed(this);
	}

	// ---- tail ----

	// 自己按 interval 轮询 stat，不用 fs.watchFile：后者的第一次 stat 是在线程池里异步做的，
	// 文件若在注册之后、那次 stat 之前又长了一截，它会把这截当成基线，之后再不为它回调，
	// 那段新内容就永远漏了。自己 stat 则一直从启动那一刻的 size 往前读，不会漏。
	private startTail(): void {
		const path = this.spec.path;
		if (!path) throw new Error("tail 需要 path");
		let stat: Stats | undefined;
		try {
			stat = statSync(path);
		} catch {
			// 文件还没写出来（先起监视、日志稍后才出现）不是错误，等它出现即可
			stat = undefined;
		}
		this.tailSeen = stat !== undefined;
		this.offset = stat ? stat.size : 0; // 从当前末尾开始，等价于 tail -f，不重放旧内容
		this.tailIno = stat?.ino;
		this.tailTimer = setInterval(() => this.pollTail(), Math.max(100, Math.round(this.spec.intervalSec * 1000)));
		this.tailTimer.unref?.();
	}

	private pollTail(): void {
		const path = this.spec.path;
		if (!path || this.stopped) return;
		let stat: Stats;
		try {
			stat = statSync(path);
		} catch {
			if (!this.tailSeen) return; // 还没出现过，继续等
			this.stop("error", `file was removed: ${path}`);
			return;
		}
		const size = stat.size;
		const ino = stat.ino;
		if (!this.tailSeen) {
			// 监视期间才出现的文件：它的内容对我们都是新的，从头读
			this.tailSeen = true;
			this.tailIno = ino;
			this.offset = 0;
		} else if (this.tailIno !== undefined && ino !== this.tailIno) {
			// 换了个文件（logrotate 常见）：新文件从头读，并说明一句
			this.offset = 0;
			this.carry = "";
			this.pushRaw("(file was replaced, following from the start)");
		}
		this.tailIno = ino;
		if (size < this.offset) {
			// 被截断（logrotate copytruncate 等）
			this.offset = 0;
			this.carry = "";
		}
		if (size === this.offset) return;
		const length = Math.min(size - this.offset, MAX_READ_BYTES);
		const buffer = Buffer.allocUnsafe(length);
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const read = readSync(fd, buffer, 0, length, this.offset);
			this.offset += read;
			this.consume(buffer.subarray(0, read).toString("utf8"));
		} catch (err) {
			this.stop("error", `读取失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// 忽略
				}
			}
		}
	}

	private consume(chunk: string): void {
		const text = this.carry + chunk;
		const parts = text.split("\n");
		this.carry = parts.pop() ?? "";
		for (const line of parts) this.pushLine(line);
		// 一直没有换行的超长行也会被送出去，避免无限攒在 carry 里。
		if (this.carry.length >= this.config.maxEventChars) {
			this.pushLine(this.carry);
			this.carry = "";
		}
	}

	// ---- poll ----

	private startPoll(): void {
		this.poll();
		this.pollTimer = setInterval(() => this.poll(), Math.max(200, Math.round(this.spec.intervalSec * 1000)));
		this.pollTimer.unref?.();
	}

	private poll(): void {
		if (this.stopped || this.pollBusy) return; // 上一轮没结束就跳过这一轮
		const command = this.spec.command;
		if (!command) return;
		const shell = this.spec.shell ?? { shell: "/bin/bash", args: ["-lc"] };
		let child: ChildProcess;
		try {
			child = spawn(shell.shell, [...shell.args, command], {
				cwd: this.spec.cwd,
				env: this.spec.env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			this.pushRaw(`command could not start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		this.pollBusy = true;
		this.pollChild = child;
		let output = "";
		const collect = (buf: Buffer) => {
			if (output.length < MAX_POLL_OUTPUT_CHARS) output += buf.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("error", (err) => {
			this.finishPoll(output, null, err.message);
		});
		child.on("close", (code) => {
			this.finishPoll(output, code);
		});
		this.pollRunTimer = setTimeout(() => this.killPollChild(), POLL_RUN_LIMIT_MS);
		this.pollRunTimer.unref?.();
	}

	private finishPoll(raw: string, code: number | null, error?: string): void {
		if (this.pollRunTimer) clearTimeout(this.pollRunTimer);
		this.pollRunTimer = undefined;
		this.pollChild = undefined;
		this.pollBusy = false;
		if (this.stopped) return;
		if (this.pollKilledRun) {
			// 被超时杀掉的这一轮不再算输出，免得把半截结果报出去。
			this.pollKilledRun = false;
			return;
		}
		const text = cleanText(raw).trim();
		const lines = text === "" ? [] : text.split("\n").map((l) => l.trimEnd());
		const diff = this.pollSeen ? linesAfterCommonPrefix(this.pollLastOutput.split("\n"), lines) : lines;
		this.pollSeen = true;
		this.pollLastOutput = text;
		for (const line of diff) this.pushLine(line);
		const failed = code !== null && code !== 0;
		if (error !== undefined) this.pushRaw(`command failed: ${error}`);
		if (failed && this.pollLastExit !== code) this.pushRaw(`command exited with code ${code}`);
		this.pollLastExit = code;
	}

	private killPollChild(): void {
		const child = this.pollChild;
		if (child?.pid === undefined) return;
		this.pollKilledRun = true;
		this.pushRaw(`command exceeded ${Math.round(POLL_RUN_LIMIT_MS / 1000)}s and was killed`);
		killTree(child);
		this.pollChild = undefined;
		this.pollBusy = false;
	}

	// ---- watch ----

	private startWatch(): void {
		const path = this.spec.path;
		if (!path) throw new Error("watch 需要 path");
		this.watcher = fsWatch(path, { recursive: true, persistent: true }, (event, filename) => this.onWatchEvent(event, filename));
		this.watcher.on("error", (err) => this.stop("error", `watch 失败：${err instanceof Error ? err.message : String(err)}`));
	}

	private onWatchEvent(event: string, filename: string | Buffer | null): void {
		if (this.stopped) return;
		// 启动瞬间补报的历史事件不是这次要看的，丢掉。
		if (Date.now() - this.startedAt < WATCH_STARTUP_GRACE_MS) return;
		const name = typeof filename === "string" ? filename : filename ? filename.toString() : "";
		// 有些平台不给文件名，退化成目录级的变动，也要报出去。
		const identity = name || "(unknown path)";
		if (name && this.spec.pattern && !this.spec.pattern.test(name)) return;
		this.watchBuffer.set(identity, event);
		if (!this.watchTimer) {
			this.watchTimer = setTimeout(() => this.flushWatch(), this.config.watchCoalesceMs);
			this.watchTimer.unref?.();
		}
	}

	private flushWatch(): void {
		this.watchTimer = undefined;
		const entries = [...this.watchBuffer.entries()].slice(0, this.config.maxLinesPerNotification);
		const overflow = this.watchBuffer.size - entries.length;
		this.watchBuffer.clear();
		for (const [name, event] of entries) this.pushRaw(`${event}: ${name}`);
		if (overflow > 0) this.pushRaw(`…and ${overflow} more changed paths`);
	}

	// ---- 事件出口 ----

	/** 按 pattern 过滤后送出（pattern 是对行内容/文件名生效的）。 */
	private pushLine(raw: string): void {
		const line = cleanLine(raw);
		if (line === "") return;
		if (this.spec.pattern && !this.spec.pattern.test(line)) return;
		this.pushRaw(line);
	}

	/** 不过滤，用于 monitor 自己的提示（文件被替换、命令超时等）。 */
	private pushRaw(text: string): void {
		if (this.stopped) return;
		this.eventCount += 1;
		this.lastEventAt = Date.now();
		this.sink(this, truncate(text, this.config.maxEventChars));
	}

	private cleanup(): void {
		if (this.expireTimer) clearTimeout(this.expireTimer);
		this.expireTimer = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.pollRunTimer) clearTimeout(this.pollRunTimer);
		this.pollRunTimer = undefined;
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = undefined;
		if (this.tailTimer) clearInterval(this.tailTimer);
		this.tailTimer = undefined;
		if (this.watcher) {
			try {
				this.watcher.close();
			} catch {
				// 忽略
			}
			this.watcher = undefined;
		}
		if (this.pollChild) {
			killTree(this.pollChild);
			this.pollChild = undefined;
		}
		this.watchBuffer.clear();
	}
}

/** 进程以 detached 启动，自成进程组，终止时对整个组发信号。 */
function killTree(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// 已经退出了
		}
	}
	const timer = setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 已经退出了
		}
	}, 5000);
	timer.unref?.();
}

export interface MonitorBatch {
	monitor: Monitor;
	lines: string[];
	more: number;
	/** 停止说明（时间到 / 通知超限 / 出错），与普通事件分行展示。 */
	notice?: string;
}

export interface ManagerHooks {
	/** 把攒好的通知交给宿主。 */
	notify: (batches: MonitorBatch[]) => void;
	/** Agent 是否正在生成。为真时先压住，等 agent_settled 再投。 */
	isBusy: () => boolean;
	/** 运行中的 monitor 数量变了（启动、停止、超时）。 */
	onChange: () => void;
}

export class MonitorManager {
	private readonly configRef: () => MonitorConfig;
	private readonly hooks: ManagerHooks;
	private readonly running = new Map<string, Monitor>();
	private readonly finished: Monitor[] = [];
	private readonly pending = new Map<string, { lines: string[]; more: number; notice?: string }>();
	private readonly lastNotifyAt = new Map<string, number>();
	private flushTimer?: NodeJS.Timeout;
	private counter = 0;
	private shutdownDone = false;

	constructor(config: () => MonitorConfig, hooks: ManagerHooks) {
		this.configRef = config;
		this.hooks = hooks;
	}

	/** 配置每次调用都重新解析，所以这里按需读，不缓存。 */
	private get config(): MonitorConfig {
		return this.configRef();
	}

	get count(): number {
		return this.running.size;
	}

	start(spec: MonitorSpec): Monitor {
		if (this.running.size >= this.config.maxConcurrent) {
			throw new Error(`已经有 ${this.running.size} 个 monitor 在跑（上限 ${this.config.maxConcurrent}），先停掉一个再开。`);
		}
		this.counter += 1;
		const monitor = new Monitor(`mon${this.counter}`, spec, this.config, this.onEvent, this.onClosed);
		this.running.set(monitor.id, monitor);
		monitor.start();
		if (!monitor.running) this.discard(monitor.id); // 启动就失败：结果直接由工具返回，不用再发通知
		return monitor;
	}

	stop(id: string): { stopped: Monitor[]; missing: string[] } {
		if (id === "all" || id === "*") {
			return { stopped: [...this.running.values()].map((m) => (m.stop("stopped"), m)), missing: [] };
		}
		const monitor = this.running.get(id);
		if (!monitor) return { stopped: [], missing: [id] };
		monitor.stop("stopped");
		return { stopped: [monitor], missing: [] };
	}

	list(): MonitorSnapshot[] {
		const running = [...this.running.values()].map((m) => m.snapshot());
		const finished = [...this.finished].reverse().map((m) => m.snapshot());
		return [...running, ...finished];
	}

	/** 丢掉某个 monitor 还没投递的事件（例如启动就失败，错误已经同步返回了）。 */
	discard(id: string): void {
		this.pending.delete(id);
	}

	/** 取走还没投递的事件：monitor_stop 直接把它们放进工具结果，避免再发一条通知。 */
	takePending(id: string): { lines: string[]; more: number; notice?: string } {
		const entry = this.pending.get(id) ?? { lines: [], more: 0 };
		this.pending.delete(id);
		return entry;
	}

	/** 投递攒下的事件。agent_settled 时由宿主调用；忙的时候会自己重试。 */
	flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pending.size === 0) return;
		if (this.hooks.isBusy()) {
			this.scheduleRetry(BUSY_RETRY_MS);
			return;
		}
		const batches: MonitorBatch[] = [];
		for (const [id, entry] of this.pending) {
			const monitor = this.running.get(id) ?? this.finished.find((m) => m.id === id);
			if (!monitor) continue;
			if (entry.lines.length === 0 && entry.more <= 0 && entry.notice === undefined) continue;
			batches.push({ monitor, lines: entry.lines, more: entry.more, notice: entry.notice });
		}
		this.pending.clear();
		if (batches.length === 0) return;
		const now = Date.now();
		for (const batch of batches) {
			batch.monitor.notificationCount += 1;
			this.lastNotifyAt.set(batch.monitor.id, now);
		}
		this.hooks.notify(batches);
		// 到通知上限的自动停下，避免一次观察把会话刷爆；停下的通知走同一条路发出去。
		for (const batch of batches) {
			if (batch.monitor.running && batch.monitor.notificationCount >= this.config.maxNotifications) batch.monitor.stop("limit");
		}
	}

	shutdown(): void {
		this.shutdownDone = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		for (const monitor of [...this.running.values()]) monitor.stop("shutdown");
		for (const monitor of this.finished) monitor.stop("shutdown");
		this.pending.clear();
		this.lastNotifyAt.clear();
	}

	private readonly onEvent = (monitor: Monitor, text: string): void => {
		if (this.shutdownDone) return;
		const entry = this.pending.get(monitor.id) ?? { lines: [], more: 0 };
		if (entry.lines.length < this.config.maxLinesPerNotification) entry.lines.push(text);
		else entry.more += 1;
		this.pending.set(monitor.id, entry);
		this.schedule();
	};

	private readonly onClosed = (monitor: Monitor): void => {
		this.running.delete(monitor.id);
		this.finished.push(monitor);
		if (this.finished.length > MAX_FINISHED) this.finished.shift();
		this.hooks.onChange();
		if (this.shutdownDone) return;
		// 用户主动停的（结果同步返回给模型）和会话结束的不再发通知；
		// 时间到、通知超限、出错这三种要主动说一声，否则模型会一直等下去。
		if (monitor.stopReason === "timeout" || monitor.stopReason === "limit" || monitor.stopReason === "error") {
			this.pushNotice(monitor, stopNotice(monitor));
		}
	};

	private pushNotice(monitor: Monitor, text: string): void {
		const entry = this.pending.get(monitor.id) ?? { lines: [], more: 0 };
		entry.notice = text;
		this.pending.set(monitor.id, entry);
		this.schedule();
	}

	private schedule(): void {
		if (this.flushTimer) return;
		const now = Date.now();
		let wait = NOTIFY_DEBOUNCE_MS;
		for (const id of this.pending.keys()) {
			const due = (this.lastNotifyAt.get(id) ?? 0) + this.config.minNotifyIntervalSec * 1000 - now;
			if (due > wait) wait = due;
		}
		this.scheduleRetry(wait);
	}

	private scheduleRetry(ms: number): void {
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			this.flush();
		}, ms);
		this.flushTimer.unref?.();
	}
}

/** 停下来的那句话：说清为什么停、报了多少事件、还要不要继续看。 */
export function stopNotice(monitor: Monitor): string {
	const lived = formatDuration(Date.now() - monitor.startedAt);
	const events = monitor.eventCount === 0 ? "no events" : `${monitor.eventCount} event(s)`;
	switch (monitor.stopReason) {
		case "timeout":
			return `monitor stopped after ${lived} (time limit reached): ${events} reported. Start a new monitor if you still need to watch this.`;
		case "limit":
			return `monitor stopped after ${monitor.notificationCount} notifications to avoid flooding the session: ${events} reported in total. Start a new monitor with a narrower pattern if you need to keep watching.`;
		case "error":
			return `monitor failed: ${monitor.error ?? "unknown error"} (${events} reported before it stopped).`;
		default:
			return `monitor stopped (${events} reported).`;
	}
}
