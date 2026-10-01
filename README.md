# pi-monitor

给 Pi 加三个工具：把「盯着某个东西，有变化就告诉我」交给一个活在回合之外的后台监视器，工具本身立刻返回。事件攒成一条通知唤醒新的回合，Agent 不用自己循环 sleep 占住整个回合。

```text
monitor(source=tail, path=/tmp/build.log, pattern="error|failed")   # 构建日志里出现错误就叫我
monitor(source=poll, command="docker compose ps --format json")    # 服务状态变了就叫我
monitor(source=watch, path=src, pattern="\\.ts$")                  # 源码目录有文件变动就叫我
```

三种源：

| source  | 盯什么 | 默认检查间隔 |
| ------- | ------ | ------------ |
| `tail`  | 一个文件的新增行（从当前末尾开始，等价于 `tail -f`，不重放旧内容；文件还没出现就先等它） | 1s |
| `poll`  | 每隔 `interval_sec` 跑一次命令，输出有增量时报告 | 5s |
| `watch` | 一个目录（递归）里的文件增删改 | 1s |

`pattern` 是正则：`tail`/`poll` 按行过滤，`watch` 按文件路径过滤。

## 工具与命令

| 名字 | 作用 |
| ---- | ---- |
| `monitor` | 起一个监视器，立刻返回 id 和期限 |
| `monitor_list` | 列本会话的监视器（在跑的在前），带事件数和通知数 |
| `monitor_stop` | 停掉一个或全部，并返回还没通知过的事件 |
| `/monitor list \| status \| stop <id\|all>` | 给人看的同一件事；`status` 还会显示生效的配置与配置错误 |

有监视器在跑时，状态栏会显示 `◉ N monitoring`。

## 通知的规矩

监视器活到期限到点（`timeout_sec`，默认 300s）或 `maxNotifications` 条通知用完，都会自动停，并在最后一条通知里说明原因。三道闸门防止刷爆会话：

- 同一个监视器两次通知至少隔 `minNotifyIntervalSec`（默认 2s），期间的事件合并进下一次；
- 一条通知最多列 `maxLinesPerNotification`（默认 20）行，其余折成 `…and N more event(s) suppressed`；
- 单行超过 `maxEventChars`（默认 2000）截断。

Agent 正在跑（回合未完）时通知不打断它，等这一回合结束再投递。

## 配置

优先级（高到低）：单次调用参数、环境变量、项目 `.pi/monitor.json`、全局 `<agentDir>/monitor.json`、默认值。项目配置只在项目受信任时读取——它能决定 `poll` 跑什么命令。

| 键 | 默认 | 说明 |
| -- | ---- | ---- |
| `maxConcurrent` | 8 | 同时运行的监视器上限，满了之后 `monitor` 直接报错 |
| `defaultTimeoutSec` | 300 | 不传 `timeout_sec` 时的期限 |
| `maxTimeoutSec` | 1800 | 模型能要求的最长期限，0 表示不限 |
| `minNotifyIntervalSec` | 2 | 同一个监视器两次通知的最小间隔 |
| `maxNotifications` | 50 | 单个监视器最多发多少条通知 |
| `maxEventChars` | 2000 | 单行事件字符上限 |
| `maxLinesPerNotification` | 20 | 单条通知最多列多少行 |
| `watchCoalesceMs` | 500 | `watch` 把一批变化合并成一次通知的时间窗 |

环境变量：`PI_MONITOR_MAX_CONCURRENT`、`PI_MONITOR_DEFAULT_TIMEOUT_SEC`、`PI_MONITOR_MAX_TIMEOUT_SEC`、`PI_MONITOR_MIN_NOTIFY_INTERVAL_SEC`、`PI_MONITOR_MAX_NOTIFICATIONS`。未知键、非法值都会在 `/monitor status` 里报出来，不会静默忽略。

## 实现上的几个取舍

- **`tail` 自己按间隔轮询 stat，不用 `fs.watchFile`**：后者的第一次 stat 是在线程池里异步做的，文件若在注册之后、那次 stat 之前又长了一截，它会把这截当成基线，之后再不为它回调，那段内容就永远漏了。自己 stat 则一直从启动那一刻的 size 往前读。
- 文件被替换（`logrotate` 常见）会从头读新文件并说明一句；被截断（`copytruncate`）则回到开头继续跟；删掉则报错停下。`tail` 只在文件一直没出现时默默等——先起监视、日志稍后写出来是常见用法，不算错。
- `watch` 启动后 300ms 内的变动不报：macOS 的 FSEvents 会把注册前刚发生的事件补报一遍。
- 单次读取上限 1MB、`poll` 单次命令输出上限 256KB、单次命令最多跑 120s（超了就杀进程组，不拖住下一轮）。

## 安装

```bash
pi install git:github.com/liu-zhengdong/pi-monitor@v0.1.1
```

## 开发

```bash
./test/run.sh        # 单元测试（node:test，被测代码不依赖 pi）
./test/typecheck.sh  # tsc --noEmit
```
