import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, resolveConfig, resolveTimeout } from "../src/config.ts";

const agentDir = () => mkdtempSync(join(tmpdir(), "pi-monitor-agent-"));
const projectDir = () => mkdtempSync(join(tmpdir(), "pi-monitor-project-"));

function writeConfig(dir, name, value) {
	const target = name === "global" ? join(dir, "monitor.json") : join(dir, ".pi", "monitor.json");
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, JSON.stringify(value, null, 2));
}

test("默认值", () => {
	const { config, errors, sources } = resolveConfig({ agentDir: agentDir(), env: {} });
	assert.deepEqual(errors, []);
	assert.equal(config.defaultTimeoutSec, 300);
	assert.equal(config.maxTimeoutSec, 1800);
	assert.equal(config.maxConcurrent, 8);
	assert.equal(config.maxNotifications, 50);
	assert.equal(sources.defaultTimeoutSec, "default");
});

test("全局配置覆盖默认值", () => {
	const dir = agentDir();
	writeConfig(dir, "global", { defaultTimeoutSec: 60, maxNotifications: 5 });
	const { config, sources } = resolveConfig({ agentDir: dir, env: {} });
	assert.equal(config.defaultTimeoutSec, 60);
	assert.equal(config.maxNotifications, 5);
	assert.equal(sources.defaultTimeoutSec, "global");
	assert.equal(config.maxConcurrent, 8);
});

test("项目配置只在受信任时读取，且优先于全局", () => {
	const global = agentDir();
	writeConfig(global, "global", { defaultTimeoutSec: 60 });
	const project = projectDir();
	writeConfig(project, "project", { defaultTimeoutSec: 30 });

	const untrusted = resolveConfig({ agentDir: global, cwd: project, projectTrusted: false, env: {} });
	assert.equal(untrusted.config.defaultTimeoutSec, 60);

	const trusted = resolveConfig({ agentDir: global, cwd: project, projectTrusted: true, env: {} });
	assert.equal(trusted.config.defaultTimeoutSec, 30);
	assert.equal(trusted.sources.defaultTimeoutSec, "project");
});

test("环境变量优先级最高", () => {
	const dir = agentDir();
	writeConfig(dir, "global", { defaultTimeoutSec: 60 });
	const { config, sources } = resolveConfig({ agentDir: dir, env: { PI_MONITOR_DEFAULT_TIMEOUT_SEC: "45", PI_MONITOR_MAX_CONCURRENT: "2" } });
	assert.equal(config.defaultTimeoutSec, 45);
	assert.equal(config.maxConcurrent, 2);
	assert.equal(sources.defaultTimeoutSec, "env");
});

test("非法值与未知键记进 errors 并跳过", () => {
	const dir = agentDir();
	writeConfig(dir, "global", { defaultTimeoutSec: "abc", maxConcurrent: 4, wat: 1 });
	const { config, errors } = resolveConfig({ agentDir: dir, env: {} });
	assert.equal(config.defaultTimeoutSec, 300);
	assert.equal(config.maxConcurrent, 4);
	assert.equal(errors.length, 2);
	assert.match(errors[0], /defaultTimeoutSec 必须是非负数/);
	assert.match(errors[1], /未知配置项 wat/);
});

test("解析失败的文件整份忽略", () => {
	const dir = agentDir();
	writeFileSync(join(dir, "monitor.json"), "{ not json");
	const { config, errors } = resolveConfig({ agentDir: dir, env: {} });
	assert.equal(config.defaultTimeoutSec, DEFAULT_CONFIG.defaultTimeoutSec);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /解析失败/);
});

test("默认期限超过上限时报错并说明", () => {
	const dir = agentDir();
	writeConfig(dir, "global", { defaultTimeoutSec: 900, maxTimeoutSec: 600 });
	const { errors } = resolveConfig({ agentDir: dir, env: {} });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /900s.*超过 maxTimeoutSec \(600s\)/);
});

test("resolveTimeout 裁剪与兜底", () => {
	const config = { ...DEFAULT_CONFIG, defaultTimeoutSec: 300, maxTimeoutSec: 600 };
	assert.equal(resolveTimeout(undefined, config), 300);
	assert.equal(resolveTimeout(0, config), 300);
	assert.equal(resolveTimeout(-1, config), 300);
	assert.equal(resolveTimeout("120", config), 300);
	assert.equal(resolveTimeout(120, config), 120);
	assert.equal(resolveTimeout(9999, config), 600);
	const unlimited = { ...config, maxTimeoutSec: 0 };
	assert.equal(resolveTimeout(9999, unlimited), 9999);
});
