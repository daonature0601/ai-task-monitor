# 更新日志

本项目的所有重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **任务状态改由运行时信号驱动**：新增 `state-inbox` 状态通道，hook / 桥接 / 文件写入 / 心跳 / 进程存在
  统一进入 `inbox.jsonl`，状态经 `applyState()` 落库；任务带上 `state_source` 标记来源
- **状态挂钩安装**：适配器页可一键为 Claude Code（`settings.json` hooks）与 Codex（`config.toml` notify，
  链式接管原命令）注入钩子脚本，写入前备份、可还原
- **自定义时间区间**：统计页与任务页的时间筛选新增「自定义」，支持起止日期
- 适配器页「数据维护 → 重建历史索引」：可按 7/30/90 天清空派生数据并重扫日志
- **任务名改为工具内的会话展示名**：Codex 读 `session_index.jsonl` 的 `thread_name`，
  Claude Code 读 `summary` 行，WorkBuddy 读 `ai-title`，DeepSeek 读 `session/title`；
  新增 `project` 字段（迁移 v5）单独记录所属项目
- **CodeBuddy IDE 用量采集**：读取 `CodeBuddyExtension/Data/**/history/<ws>/<convId>/index.json`
  的 `requests[].usage`（IDE 不写 JSONL），标题取工作区索引、项目取 `genie-history` 解码路径
- **DeepSeek Harness 用量采集**：改读 `~/.dsh/sessions` 的 zstd 会话文件，新增 `fzstd` 依赖；
  支持 `turn/start`、`turn/end`、`session/title`、`request/header` 与 `assistant/message.usage`
- **WorkBuddy 请求级用量**：改读 `~/.workbuddy/projects/**/*.jsonl` 的 `providerData.rawUsage`，
  子代理日志按路径归属父会话
- **价目表支持分时计价**（迁移 v6 的 `peak_json`）：DeepSeek 高峰为 UTC 01-04、06-10（周一至周五），
  价格为低谷 2 倍；事件写入、事件重算、任务重算都按各自时刻取价
- **价目表记录报价币种**（迁移 v7 的 `currency`）：国外厂商 USD、国内厂商（智谱 / 腾讯）CNY，
  入库保持厂商原币种，计价时按 7.1 折成 USD 存储；价目表界面按币种显示 `¥` / `$`
- 价目表补齐腾讯混元 Hy4 / Hy4 preview / Hy4 flash / Hy3 与 `gpt-5.3-codex` 官方单价

### 变更

- **时间口径改为「当次问答」**：新增 `turn_started_at` / `turn_ended_at`（迁移 v4），界面的
  「开始时间 / 时长」不再显示整段会话的起点，而是当前这一轮问题的开始与耗时
  - Codex 用 `task_started` / `task_complete` 事件
  - Claude Code 用 `type=user` 行（装挂钩后由 `UserPromptSubmit` 更早触发）
  - 无轮次事件的工具以「当前活跃段的起点」近似
- 任务页状态筛选精简为 全部 / 进行中 / 已结束，运行中与静默的区别由行内状态标签承担
- 图表 Tooltip 改为自绘：实色底色、三档文字对比度，柱状图悬停底色改为 4.5% 白
- **WorkBuddy token 口径由 `partial` 升为 `native`**：不再使用 `session_usage.used`（上下文占用量），
  改用请求级真实 usage，可按价目表计价
- **TaskMachine 新增 `keepSession`**：IDE 类数据源（一次对话一个任务）不按 10 分钟空档切分
- 任务表改为 `table-fixed` 布局，长标题单行省略，不再挤掉副标题
- 任务副标题统一为「项目 · 模型」，缺失时分别显示「项目未知 / 模型未知」
- **任务费用改为按事件累加**：每条用量事件按自身时刻的单价计入，不再用累计 token 乘单价重算
- **时间显示跟随系统时区**：此前写死 `Asia/Shanghai`，现按系统时区格式化，
  统计 SQL 分日与「今日」汇总同步回到本地时区
- 任务列表与概览卡片的副标题改为两段式：模型名优先展示（最多占行宽 3/4），
  项目名可收缩并在结尾省略；分隔符 `·` 左右各留 4px
- 任务详情新增「模型」指标，「当前费用」下移到网格末尾
- `-ioa` 后缀的模型按前缀计价（如 `glm-5.3-ioa` 按 `glm-5.3`）

### 修复

- CodeBuddy 对话已结束仍显示「运行中」：不再以扩展日志写入判定活跃，改用会话级 `edit-sessions` 的 `updatedAt`
- Codex 长回合中无 `token_count` 被误判「静默」：文件仍在追加即视为工作中（`io` 来源）
- 概览指标与任务页「运行中」口径不一致
- 今日费用远大于近 30 天：统计改为按用量事件时间归集
- 子代理被拆成独立任务、guardian 线程误建任务
- **心跳信号凭空建任务**：`<pid>.json` 只是进程存活信号（WorkBuddy 的 prewarm 池会一次生成多个），
  曾导致实时任务出现多张同名空卡片；现在心跳只维持已有任务的状态
- **CodeBuddy IDE 用量少算 29%**：`index.json` 中约 423 条请求没有 `startedAt`，此前被整条丢弃；
  现按顺序沿用上一条请求时间，整份缺失时退到文件 mtime（事件 1011 → 1421，输入 +45%）
- **CodeBuddy 切号副本重复计入**：按「时间戳 + 四类用量」的请求指纹跨文件去重
- **零时长空回合**：只有回合开始信号、没有推进的已结束任务在列表中隐藏（Codex 673 → 554）
- **缓存字段被 0 值掩盖**：`cache_read_input_tokens` 常为 0，改用「取正值」的优先级链；
  同时补上 `completion_thinking_tokens` 的思考 token
- **token 与费用长期漂移**：任务的累计 token 由内存整行覆盖写入，而事件表有唯一键去重，
  重复推送 / 重扫时任务累加、事件被忽略（实测 85 个任务偏差、差额 325M token）。
  现改为：事件插入成功后按增量累加任务列，任务 upsert 不再写 token / event_count 六列，
  两者统一由 `usage_events` 派生（不一致任务 85 → 0）
- **改了价目表但金额不变**：`recomputeEventCosts()` 原先只更新事件、不刷新任务，
  且执行时机在 `hydrate()` 之后会被内存旧值回写；现已前置并同时按事件重算任务
- **JSONL 采集静默停摆**：`JsonlTailer` 完全依赖 chokidar 事件，watcher 失效后不再读取
  （实测积压 533KB、8 分钟无新事件）；新增 60 秒兜底轮询，仅在「最近 60 秒无成功读取」时
  stat 文件并按需补读，watcher 正常时零开销
- **幽灵运行卡片**：兜底轮询重读旧 rollout 会重推 `session_meta`（只有标题、无用量），
  新建任务后被标成运行中；现要求「有 token 或轮次边界」才允许建任务
- **CodeBuddy 本轮耗时计算错误**：`index.json` 只有 `startedAt`、没有结束时间，此前起点恒定在
  首次导入时刻（出现 21h58m），加上每条请求重置起点后又变成 0s。现每条请求作为新一轮起点，
  本轮结束取「下一条请求的起点」，最后一条用文件 mtime 收口
- **同一会话被拆成多条任务**：状态信号与用量事件各自按 10 分钟空档切分，切出的 `~时间戳`
  分身拿不到用量（token 只记在基础 id 上），于是出现「0 token 且显示运行中」的重复卡片。
  现 `StateSignal` 与 `UsageDelta` 都支持 `keepSession`，CodeBuddy / WorkBuddy / DeepSeek
  一个会话即一个任务（Codex / Claude 仍按轮次切分）；重导后 WorkBuddy 301→188、DeepSeek 13→8
- **只有标题的会话不再进入列表**：已结束且无任何事件、无任何 token 的空会话在快照与查询层一并隐藏

## [1.0.0] - 2026-11-17

首个公开版本。

### 新增

- **七款工具的真实采集**：Codex、Claude Code、DeepSeek Harness、CodeBuddy、WorkBuddy、Cursor、元宝
  - Codex：`~/.codex/sessions/**/rollout-*.jsonl`，按 `last_token_usage` 取增量，守护线程自动过滤、子代理归并父线程
  - Claude Code：`~/.claude/projects/**/*.jsonl`，逐行累加 `message.usage`
  - WorkBuddy：`workbuddy.db` 只读轮询 + `sessions/<pid>.json` 存活心跳
  - CodeBuddy：`projects/*.jsonl` 会话解析 + 扩展日志活动检测
  - Cursor：`state.vscdb` 只读读取，无用量时明确标记不可用
  - DeepSeek Harness：Local Storage 快照解析 + 桥接
  - 元宝：本地无落盘，通过网页端桥接上报
- **任务状态机**：`运行中 / 静默 / 已结束` 三态互斥，按「连续活动段（burst）」切分任务，间隔超过 10 分钟自动开新任务
- **双币种计价**：USD / CNY 实时换算，价目表带 `已核实 / 待确认` 标记，未核实单价一律不参与计价
- **本地桥接**：`127.0.0.1` HTTP 服务 + 随机 token + Origin 白名单 + 限流，配套元宝与 DeepSeek 用户脚本
- **界面**：概览 / 任务 / 统计 / 适配器 / 设置 五页，任务详情抽屉、CSV 导出、菜单栏常驻
- **可扩展适配器**：新增工具只需实现 `ToolAdapter` 并在注册表注册一行

### 修复（开发期）

- 统计口径改为按**用量事件时间**归集，修复「今日费用 > 近 30 天」的错误
- 修复 Codex 会话元信息在进程重启后丢失，导致标题退化为「会话 xxxxxxx」
- 修复事件级费用在模型名缺失时被计为 0（已回填历史流水）
- 修复批量写库时 `usage_events` 与 `tasks` 的写入顺序导致外键约束失败
- 修复设置页目录栏随内容滚动、价目表首屏为空
- 修复侧边栏折叠引起的内容位移与交通灯重叠
- 修复 Codex 子代理被拆成独立任务：父子关系改为同步回读文件头，`guardian_review` 线程整体跳过
- 修复历史回填事件污染当日活动段：早于活动段起点的事件按天归入独立历史任务
- 修复回填历史文件时心跳误建「运行中」空任务
- 修复事件时间线缺少日期，跨天事件被误读为「未来的时间」

### 已知限制

- CodeBuddy / WorkBuddy 桌面端本地无 token 明细，仅能提供会话时长
- Codex 走订阅额度，官方 API 价目表无 token 单价，费用需手工补录
- 「输出缓存命中率」在 LLM 语义上不存在，界面固定显示 `—`
- 「统计」页数据来自本地流水表，升级到事件口径之前的旧任务可能缺少事件明细
