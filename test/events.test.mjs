import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLine, cleanText, compilePattern, formatDuration, linesAfterCommonPrefix, truncate } from "../src/events.ts";

test("truncate：短文本原样，长文本带说明", () => {
	assert.equal(truncate("abc", 10), "abc");
	const long = truncate("abcdefghijklmnop", 5);
	assert.match(long, /^abcde…\[truncated 11 chars\]$/);
});

test("cleanText：去掉 ANSI 转义和行尾空白", () => {
	assert.equal(cleanText("\u001b[31mred\u001b[0m  \nplain\r\n"), "red\nplain\n");
});

test("cleanLine：去掉控制字符，保留缩进", () => {
	assert.equal(cleanLine("\u0007  indented\t"), "  indented");
	assert.equal(cleanLine(""), "");
});

test("linesAfterCommonPrefix：取新增部分", () => {
	assert.deepEqual(linesAfterCommonPrefix(["a", "b"], ["a", "b", "c"]), ["c"]);
	assert.deepEqual(linesAfterCommonPrefix([], ["a"]), ["a"]);
	assert.deepEqual(linesAfterCommonPrefix(["a"], ["a"]), []);
	// 输出被替换（不是追加）时整段都算新增
	assert.deepEqual(linesAfterCommonPrefix(["a", "b"], ["z"]), ["z"]);
});

test("formatDuration", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(1500), "2s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(90_000), "1m30s");
	assert.equal(formatDuration(3_600_000), "1h0m");
});

test("compilePattern：空值返回 undefined，非法正则抛错", () => {
	assert.equal(compilePattern(undefined), undefined);
	assert.equal(compilePattern("  "), undefined);
	assert.equal(compilePattern("ERR").source, "ERR");
	assert.throws(() => compilePattern("(["), /pattern 不是合法正则/);
});
