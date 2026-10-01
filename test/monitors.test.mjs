import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { MonitorManager } from "../src/monitors.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等条件成立，超时就报错——比固定 sleep 稳，测试也不会为了保险而变慢。 */
async function waitFor(check, what, timeoutMs = 4000, snapshot) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await sleep(25);
	}
	assert.fail(`超时等待：${what}；现场：${snapshot ? snapshot() : "(无)"}`);
}

function harness(overrides = {}) {
	const config = { ...DEFAULT_CONFIG, minNotifyIntervalSec: 0.2, ...overrides };
	const batches = [];
	const changes = [];
	const manager = new MonitorManager(() => config, {
		notify: (list) => batches.push(...list),
		isBusy: () => false,
		onChange: () => changes.push(Date.now()),
	});
	const lines = () => batches.flatMap((b) => b.lines);
	return { manager, batches, changes, config, lines };
}

function tempFile(name = "app.log", initial = "") {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-"));
	const file = join(dir, name);
	writeFileSync(file, initial);
	return { dir, file };
}

test("tail：从文件末尾开始，只报新增行", async () => {
	const { file } = tempFile("app.log", "old line\n");
	const { manager, lines } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	assert.equal(monitor.running, true);
	appendFileSync(file, "hello\nworld\n");
	await waitFor(() => monitor.eventCount === 2, "两行新内容", 4000, () => `${JSON.stringify(manager.list()[0])} size=${statSync(file).size}`);
	manager.flush();
	assert.deepEqual(lines(), ["hello", "world"]);
	manager.shutdown();
});

test("tail：pattern 只放行匹配的行", async () => {
	const { file } = tempFile("app.log", "");
	const { manager, lines } = harness();
	const monitor = manager.start({ source: "tail", path: file, pattern: /ERROR/, intervalSec: 0.05, timeoutSec: 5 });
	appendFileSync(file, "INFO ok\nERROR boom\n");
	await waitFor(() => monitor.eventCount >= 1, "匹配行");
	manager.flush();
	assert.deepEqual(lines(), ["ERROR boom"]);
	manager.shutdown();
});

test("tail：文件还不存在时先等它出现，出现后从头读", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-monitor-"));
	const file = join(dir, "later.log");
	const { manager, lines } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	assert.equal(monitor.running, true); // 日志还没写出来不是错误
	await sleep(150);
	writeFileSync(file, "ERROR: born\n");
	await waitFor(() => monitor.eventCount === 1, "文件出现后的首行", 4000, () => JSON.stringify(manager.list()[0]));
	manager.flush();
	assert.deepEqual(lines(), ["ERROR: born"]);
	manager.shutdown();
});

test("tail：出现过的文件被删掉报错", async () => {
	const { file } = tempFile("gone.log", "");
	const { manager } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	rmSync(file);
	await waitFor(() => monitor.stopReason === "error", "文件消失后报错");
	manager.shutdown();
});

test("poll：第一次全量，之后只报增量", async () => {
	const { dir, file } = tempFile("out.txt", "a\n");
	const { manager, lines } = harness();
	const monitor = manager.start({ source: "poll", command: `cat ${file}`, intervalSec: 0.2, timeoutSec: 5, cwd: dir });
	await waitFor(() => monitor.eventCount === 1, "第一次输出");
	appendFileSync(file, "b\n");
	await waitFor(() => monitor.eventCount === 2, "增量输出");
	manager.flush();
	assert.deepEqual(lines(), ["a", "b"]);
	manager.shutdown();
});

test("poll：命令失败只报一次退出码", async () => {
	const { dir } = tempFile("noop.txt", "");
	const { manager, lines } = harness();
	manager.start({ source: "poll", command: "exit 3", intervalSec: 0.15, timeoutSec: 5, cwd: dir });
	await waitFor(() => lines().some((l) => l.includes("exited with code 3")), "退出码");
	await sleep(500);
	assert.equal(lines().filter((l) => l.includes("exited with code 3")).length, 1);
	manager.shutdown();
});

test("watch：目录里新增文件会报事件", async () => {
	const { dir } = tempFile("keep.txt", "");
	const { manager, lines } = harness({ watchCoalesceMs: 50 });
	const monitor = manager.start({ source: "watch", path: dir, intervalSec: 0.05, timeoutSec: 5 });
	await sleep(500); // 越过启动静默期
	writeFileSync(join(dir, "new.txt"), "x");
	await waitFor(() => lines().some((l) => l.includes("new.txt")), "new.txt 事件");
	assert.ok(monitor.eventCount >= 1);
	manager.shutdown();
});

test("watch：pattern 过滤文件名", async () => {
	const { dir } = tempFile("keep.txt", "");
	const { manager, lines } = harness({ watchCoalesceMs: 50 });
	manager.start({ source: "watch", path: dir, pattern: /\.log$/, intervalSec: 0.05, timeoutSec: 5 });
	await sleep(500); // 越过启动静默期
	writeFileSync(join(dir, "ignore.txt"), "x");
	writeFileSync(join(dir, "want.log"), "y");
	await waitFor(() => lines().some((l) => l.includes("want.log")), "want.log 事件");
	assert.deepEqual(lines().filter((l) => l.includes("ignore.txt")), []);
	manager.shutdown();
});

test("期限到点自动停，留下停止说明", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager, batches } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 0.3 });
	await waitFor(() => !monitor.running, "自动停止");
	assert.equal(monitor.stopReason, "timeout");
	manager.flush();
	const notices = batches.flatMap((b) => (b.notice ? [b.notice] : []));
	assert.equal(notices.length, 1);
	assert.match(notices[0], /time limit/);
	manager.shutdown();
});

test("通知条数到上限自动停", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager } = harness({ maxNotifications: 1 });
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	appendFileSync(file, "one\n");
	await waitFor(() => monitor.eventCount >= 1, "事件");
	manager.flush();
	assert.equal(monitor.notificationCount, 1);
	assert.equal(monitor.running, false);
	assert.equal(monitor.stopReason, "limit");
	manager.shutdown();
});

test("stop 取走还没投递的事件，之后不再有该 monitor 的通知", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager, batches } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	appendFileSync(file, "late\n");
	await waitFor(() => monitor.eventCount >= 1, "事件");
	const { stopped } = manager.stop(monitor.id);
	assert.equal(stopped.length, 1);
	const pending = manager.takePending(monitor.id);
	assert.deepEqual(pending.lines, ["late"]);
	assert.equal(manager.list().filter((m) => m.running).length, 0);
	await sleep(600);
	manager.flush();
	assert.deepEqual(batches.flatMap((b) => b.lines), []);
	manager.shutdown();
});

test("stop all 与未知 id", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager } = harness();
	manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	assert.equal(manager.list().filter((m) => m.running).length, 2);
	assert.deepEqual(manager.stop("nope").missing, ["nope"]);
	assert.equal(manager.stop("all").stopped.length, 2);
	assert.equal(manager.list().filter((m) => m.running).length, 0);
	manager.shutdown();
});

test("并发上限", () => {
	const { file } = tempFile("x.txt", "");
	const { manager } = harness({ maxConcurrent: 1 });
	manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	assert.throws(() => manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 }), /上限 1/);
	manager.shutdown();
});

test("shutdown 停掉全部并清理", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	manager.shutdown();
	assert.equal(monitor.stopReason, "shutdown");
	appendFileSync(file, "after\n");
	await sleep(300);
	assert.equal(monitor.eventCount, 0);
});

test("list 保留已结束的 monitor", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager } = harness();
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 0.2 });
	await waitFor(() => !monitor.running, "自动停止");
	const listed = manager.list();
	assert.equal(listed.length, 1);
	assert.equal(listed[0].id, monitor.id);
	assert.equal(listed[0].running, false);
	assert.equal(listed[0].stopReason, "timeout");
	manager.shutdown();
});

test("事件太多时单条通知只列前 maxLinesPerNotification 行", async () => {
	const { file } = tempFile("x.txt", "");
	const { manager, batches } = harness({ maxLinesPerNotification: 3 });
	const monitor = manager.start({ source: "tail", path: file, intervalSec: 0.05, timeoutSec: 5 });
	appendFileSync(file, "l1\nl2\nl3\nl4\nl5\n");
	await waitFor(() => monitor.eventCount === 5, "五行事件");
	manager.flush();
	assert.equal(monitor.eventCount, 5);
	const first = batches[0];
	assert.equal(first.lines.length, 3);
	assert.equal(first.more, 2);
	manager.shutdown();
});
