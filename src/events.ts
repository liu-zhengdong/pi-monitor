// 事件的纯函数工具：清理、截断、求增量、格式化。
// 不依赖 pi，也不碰 IO，直接跑单元测试。

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 去掉 ANSI 转义和回车，收掉行尾空白。 */
export function cleanText(raw: string): string {
	return raw.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

/** 单行清理：去掉控制字符和行尾空白，保留缩进。 */
export function cleanLine(raw: string): string {
	return cleanText(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

/** next 里去掉与 prev 相同的开头，返回新增的部分。 */
export function linesAfterCommonPrefix(prev: readonly string[], next: readonly string[]): string[] {
	let common = 0;
	while (common < prev.length && common < next.length && prev[common] === next[common]) common += 1;
	return next.slice(common);
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

/** 编译用户给的正则，失败时抛出能直接给模型看的错误。 */
export function compilePattern(pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern.trim() === "") return undefined;
	try {
		return new RegExp(pattern);
	} catch (err) {
		throw new Error(`pattern 不是合法正则：${err instanceof Error ? err.message : String(err)}`);
	}
}
