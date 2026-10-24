# dsh-task-plan

DeepSeek Harness Web 插件：**谷值自动执行的任务计划表**。

白天在「任务计划」页面把想到的任务写进去；到谷值时段（默认北京时间 18:00）插件自动为每个待执行任务新建一个独立 Session 并发执行，并记录 token、金额、耗时与结果。

> 每晚的逐任务 token/金额日报已拆到独立插件 [`dsh-task-digest`](../dsh-task-digest/README.md)。两个插件可分别安装、启停和排障；本包不再包含日报代码、路由、定时器或页面。

## 查看方式

- **看单个任务**：每个任务是一个普通 Session，标题固定为任务名，出现在左侧会话列表里它工作目录对应的 workspace 分组下。运行中的会话不会被折叠，始终可见；点开就是中间的实时对话（工具调用、输出），会话头部的 token-cost 徽标可看实时用量。
- **看总览**：点左侧栏的「任务计划」图标，打开总看板：排队/运行/完成、耗时、token、金额、结果摘要，点「打开会话」直接跳到对应 Session。
- **回看板**：在任意会话里再点左侧「任务计划」图标即可切回，页面会重新拉取状态。

## 功能

- **计划表**：标题、说明、类型、工作目录、启用开关；持久化到本地 JSON，重启不丢。
- **谷值自动执行**：默认 18:00（北京时间）执行当天全部 `pending` 任务；若配置时刻落在峰时且 `offPeakOnly=true`，自动顺延到下一个谷值起点（12:00 或 18:00）。周末/节假日不调整。
- **并发**：每个任务一个 Session，默认并发 2，可配 1–8；单个任务失败/超时不影响其他任务。
- **费用可见**：任务完成后按峰/谷单价估算 token 金额，显示在任务表和结果里。
- **零常驻 token**：不注册任何模型侧工具、skill 或 prompt 片段；空闲时不增加请求 token。
- **可恢复**：Host 重启时把上次 `queued/running` 的任务标记为 `interrupted` 并补一条记录，不自动重跑，可在页面手动重试。

## 峰谷与计费口径

与 [`dsh-token-cost`](../dsh-token-cost) 和 [`dsh-task-digest`](../dsh-task-digest) 保持一致：

- 峰时 = 北京时间周一至周五（排除 `holidays` 配置的中国法定节假日）**09:00–12:00、14:00–18:00**；其余全部为谷值。
- 价格（元 / 百万 token，缓存命中 / 未命中 / 输出）：
  - `deepseek-flash`：谷 0.02 / 1 / 4，峰 0.04 / 2 / 8
  - `deepseek-v4-pro`：谷 0.15 / 4.5 / 13.5，峰 0.3 / 9 / 27
- 每个用量样本按它自己的事件时间判峰谷；未知模型只统计 token，金额标未知。

> 金额是按公开单价估算，不是账单。官方调价时改 `lib/tier.js` 的 `RATE_TABLE`；日报包有一份相同规则，两包由 parity 测试防止漂移。

## 从 GitHub / 插件市场安装

本包是标准 DSH **组合包**（`dsh.bundle.patch` + `cordis.patch.yml`），可以直接从 GitHub 安装：

```powershell
# 推荐固定 commit，避免后续推送改变实际运行内容
dsh plugin --profile web add github:nwasvsad/dsh-task-plan#<commit>
```

也可以使用插件市场索引（Discover → Index sources）：

```text
https://raw.githubusercontent.com/nwasvsad/dsh-plugin-market/main/index.json
```

Git 安装会拉取源码并执行 `prepare`（重新构建 `lib/client.js`）；如果 pnpm 要求构建授权，按提示把包名加入该 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds`。`lib/` 已提交，未授权构建时通常仍可直接加载。

安装后默认使用 `$DSH_HOME/task-plan`，在 profile 的 `cordis.patch.yml` 里按需覆盖。

## 本地安装（开发）

前置：已安装 dsh，并有一个可用的 Web profile（下面以 `web` 为例）。

```powershell
cd <repo>

# 1) 只读校验
node scripts/verify.mjs

# 2) 安装进 web profile：追加 patch 行 + pnpm add
node scripts/verify.mjs --apply

# 3) 重启 dsh web（会结束当前会话进程，请手动执行）
# 例如重新运行: dsh web
```

然后刷新 `http://127.0.0.1:3080`，左侧应出现「任务计划」。

`--apply` 会向 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
# dsh-task-plan: off-peak task plan
- insert:
    - id: task-plan
      name: dsh-task-plan
      config:
        dataDir: '~/.dsh/task-plan'
        defaultCwd: '~'
        runAt: '18:00'
        offPeakOnly: true
        concurrency: 2
        holidays: []
```

如果 profile 已有该行，脚本不会覆盖，按需手动改 config。旧版 patch 里的 `summaryAt` 等键会被忽略，不影响本插件。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时 Host 不调度、页面显示禁用 |
| `dataDir` | `$DSH_HOME/task-plan` | `plan.json` 根目录 |
| `defaultCwd` | `process.cwd()` | 任务未写 cwd 时的工作目录 |
| `agentPreset` | 部署默认 | 任务 Session 的 preset；默认不传 |
| `runAt` | `'18:00'` | 每日自动执行时刻（北京时间） |
| `offPeakOnly` | `true` | 峰时顺延到下一个谷值起点 |
| `autoRunEnabled` | `true` | 关闭后只允许手动执行 |
| `holidays` | `[]` | 全天谷值的 `YYYY-MM-DD` |
| `concurrency` | `2` | 1–8 |
| `maxTasksPerRun` | `20` | 单次 run 上限，其余留到下一次/手动 |
| `taskTimeoutMs` | `1800000` | 单任务超时（30 分钟） |
| `startTimeoutMs` | `15000` | 等待 Agent 进入 running 的上限 |
| `pollIntervalMs` | `500` | Agent 状态轮询 |
| `currency` | `'¥'` | 金额前缀 |

非法值会回落到默认值并记日志。

## 数据

```text
<dataDir>/
  plan.json           # 任务、最近 200 次执行、lastAutoRunDate
```

- `plan.json` 原子写（临时文件 + rename）；损坏时改名 `plan.json.corrupt-<ts>`，以空计划启动并告警。
- 所有 HTTP 写操作与调度器共用同一串行锁。
- 旧版同目录下的 `reports/` 不再使用；日报数据由 `dsh-task-digest` 管理。

## HTTP API

全部走浏览器信任栅栏（`connection.requestRejection`），body ≤ 64KB。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/task-plan/state` | 任务、运行状态、下次执行 |
| POST | `/api/task-plan/tasks` | 新建任务 |
| PATCH | `/api/task-plan/tasks` | 修改任务（运行中只允许改标题） |
| DELETE | `/api/task-plan/tasks?id=` | 删除任务（运行中需先取消） |
| POST | `/api/task-plan/run` | `{ids?}` 立即执行；已有 run 时 409 |
| POST | `/api/task-plan/cancel` | `{taskId}` 取消 |

日报相关路由已移除，见 [`dsh-task-digest`](../dsh-task-digest/README.md)。

## 运行机制

1. 每 30 秒 tick 一次。
2. 自动执行条件：有 `enabled && pending`、当前 ≥ 当天生效 `runAt`、当前谷值、`lastAutoRunDate !== 今天`、无进行中的 run。
3. 每个任务：`sessionController.create` → `rename` 为任务标题 → `prompt` → 轮询 `agent.status` 直到 `running → idle`；超时则 `sessionController.cancel`。
4. 完成后读一次完整会话日志：按 `(turn, step)` 去重折叠 `assistant/message` 用量，按事件时间判峰谷计价，取最后一条 assistant 文本作为结果；`subagents.listDescendants` 的子代理用量并入父任务。
5. 任务 Session 的标题与首条 prompt 带有 `[[dsh-task-plan]]` 标记，日报包据此把它识别为计划任务。

## 注意与限制

- **Host 必须常开**：本插件不用 OS 计划任务；停机则当天不执行，pending 留到下一次。
- **权限审批**：任务 Session 继承部署的 sandbox/approval 策略；需要人工审批的操作会挂起到超时。建议把自动任务写成无需审批的工作区操作。
- **一个任务 = 一个 Session**：已完成任务不会每天自动重复；需要重复的任务请手动重试或每天新增（暂不做 recurrence）。
- **标题即会话名**：Host 会 best-effort `rename`，失败时退回首条 prompt 自动标题。
- **不注册模型侧工具**：因此没有每请求 token 开销。
- 卸载本插件不会删除历史 Session 或 `plan.json`；日报不受影响。

## 开发与测试

```powershell
node scripts/build-client.mjs     # 改 src/client.js 后重新生成 lib/client.js
node scripts/verify.mjs           # 只读校验
npm test                          # 单进程单元/集成测试
```

源码结构：

```text
lib/tier.js       峰谷、价格、日期/时刻
lib/usage.js      会话日志 → 用量/费用/结果/工具统计
lib/plan.js       持久化与串行锁
lib/runner.js     Session 执行与完成检测
lib/scheduler.js  自动执行判定、恢复、并发
lib/routes.js     HTTP 路由
lib/index.js      Host 入口
src/client.js     浏览器任务页面
```
