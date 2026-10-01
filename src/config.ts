// 配置读取与合并。
//
// 优先级（高 → 低）：单次调用参数 > 环境变量 > 项目 .pi/monitor.json >
// 全局 <agentDir>/monitor.json > 默认值。单次调用参数在 index.ts 里处理，
// 这里只合并后四层。纯逻辑，不依赖 pi，可以直接用 node 跑测试。
//
// 项目配置只在项目受信任时读取：它能决定 poll 跑什么命令。

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "monitor.json";

export interface MonitorConfig {
	/** 同时运行的 monitor 上限，满了之后 monitor 工具直接报错。 */
	maxConcurrent: number;
	/** 不传 timeout_sec 时的默认期限（秒）。 */
	defaultTimeoutSec: number;
	/** 模型通过 timeout_sec 能要求的最长期限（秒），0 表示不设上限。 */
	maxTimeoutSec: number;
	/** 同一个 monitor 两次通知之间至少隔这么多秒，期间的事件合并进下一次。 */
	minNotifyIntervalSec: number;
	/** 单个 monitor 最多发这么多条通知，到顶就自动停止并说明原因。 */
	maxNotifications: number;
	/** 单行事件的字符数上限，超出截断。 */
	maxEventChars: number;
	/** 单条通知里最多列多少行事件，其余合并成计数。 */
	maxLinesPerNotification: number;
	/** watch 源把同一批文件变化合并成一次通知的时间窗（毫秒）。 */
	watchCoalesceMs: number;
}

export type ConfigSource = "default" | "global" | "project" | "env";

export interface ResolvedConfig {
	config: MonitorConfig;
	sources: Record<keyof MonitorConfig, ConfigSource>;
	errors: string[];
}

export const DEFAULT_CONFIG: MonitorConfig = {
	maxConcurrent: 8,
	defaultTimeoutSec: 300,
	maxTimeoutSec: 1800,
	minNotifyIntervalSec: 2,
	maxNotifications: 50,
	maxEventChars: 2000,
	maxLinesPerNotification: 20,
	watchCoalesceMs: 500,
};

const NUMBER_KEYS = [
	"maxConcurrent",
	"defaultTimeoutSec",
	"maxTimeoutSec",
	"minNotifyIntervalSec",
	"maxNotifications",
	"maxEventChars",
	"maxLinesPerNotification",
	"watchCoalesceMs",
] as const satisfies readonly (keyof MonitorConfig)[];

const ENV_MAP: Record<string, keyof MonitorConfig> = {
	PI_MONITOR_MAX_CONCURRENT: "maxConcurrent",
	PI_MONITOR_DEFAULT_TIMEOUT_SEC: "defaultTimeoutSec",
	PI_MONITOR_MAX_TIMEOUT_SEC: "maxTimeoutSec",
	PI_MONITOR_MIN_NOTIFY_INTERVAL_SEC: "minNotifyIntervalSec",
	PI_MONITOR_MAX_NOTIFICATIONS: "maxNotifications",
};

function parseNumber(raw: unknown): number | undefined {
	const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function readJsonFile(path: string): Record<string, unknown> | Error | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const { mtimeMs } = statSync(path);
		const cached = fileCache.get(path);
		if (cached && cached.mtimeMs === mtimeMs) return cached.value;
		let value: Record<string, unknown> | Error;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : new Error("顶层必须是对象");
		} catch (err) {
			value = err instanceof Error ? err : new Error(String(err));
		}
		fileCache.set(path, { mtimeMs, value });
		return value;
	} catch (err) {
		return err instanceof Error ? err : new Error(String(err));
	}
}

// 按 mtime 缓存：monitor 工具每次调用都会重新解析配置。
const fileCache = new Map<string, { mtimeMs: number; value: Record<string, unknown> | Error }>();

function applyLayer(target: MonitorConfig, sources: Record<string, ConfigSource>, layer: Record<string, unknown>, source: ConfigSource, label: string, errors: string[]): void {
	for (const [key, raw] of Object.entries(layer)) {
		if (raw === undefined) continue;
		if (!(NUMBER_KEYS as readonly string[]).includes(key)) {
			errors.push(`${label}: 未知配置项 ${key}，已忽略`);
			continue;
		}
		const value = parseNumber(raw);
		if (value === undefined) {
			errors.push(`${label}: ${key} 必须是非负数，已忽略`);
			continue;
		}
		(target as unknown as Record<string, number>)[key] = value;
		sources[key as keyof MonitorConfig] = source;
	}
}

export interface ResolveOptions {
	agentDir: string;
	cwd?: string;
	projectTrusted?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function globalConfigPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", CONFIG_FILE_NAME);
}

export function resolveConfig(options: ResolveOptions): ResolvedConfig {
	const config = { ...DEFAULT_CONFIG };
	const sources = Object.fromEntries(Object.keys(config).map((k) => [k, "default"])) as Record<keyof MonitorConfig, ConfigSource>;
	const errors: string[] = [];

	const layers: Array<{ path: string; source: ConfigSource }> = [{ path: globalConfigPath(options.agentDir), source: "global" }];
	if (options.cwd && options.projectTrusted) layers.push({ path: projectConfigPath(options.cwd), source: "project" });
	for (const { path, source } of layers) {
		const layer = readJsonFile(path);
		if (layer === undefined) continue;
		if (layer instanceof Error) {
			errors.push(`${path}: 解析失败（${layer.message}），整份文件已忽略`);
			continue;
		}
		applyLayer(config, sources, layer, source, path, errors);
	}

	const env = options.env ?? process.env;
	for (const [name, key] of Object.entries(ENV_MAP)) {
		const raw = env[name];
		if (raw === undefined || raw === "") continue;
		const value = parseNumber(raw);
		if (value === undefined) {
			errors.push(`${name}: 必须是非负数，已忽略`);
			continue;
		}
		(config as unknown as Record<string, number>)[key] = value;
		sources[key] = "env";
	}

	// 下限兜底：0 会让定时器变成忙轮询，1 秒是能用的最小值。
	config.maxConcurrent = Math.max(0, Math.floor(config.maxConcurrent));
	config.minNotifyIntervalSec = Math.max(1, config.minNotifyIntervalSec);
	config.maxEventChars = Math.max(100, Math.floor(config.maxEventChars));
	config.maxLinesPerNotification = Math.max(1, Math.floor(config.maxLinesPerNotification));

	if (config.maxTimeoutSec > 0 && config.defaultTimeoutSec > config.maxTimeoutSec) {
		errors.push(`defaultTimeoutSec (${config.defaultTimeoutSec}s) 超过 maxTimeoutSec (${config.maxTimeoutSec}s)，默认期限按 ${config.maxTimeoutSec}s 生效`);
	}

	return { config, sources, errors };
}

/** 单次调用的期限：请求值经上限裁剪，缺省时用默认值。 */
export function resolveTimeout(requested: unknown, config: MonitorConfig): number {
	const value = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : config.defaultTimeoutSec;
	if (config.maxTimeoutSec > 0) return Math.min(value, config.maxTimeoutSec);
	return value;
}
