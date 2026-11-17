# 更新日志

本项目的所有重要变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

### 已知限制

- CodeBuddy / WorkBuddy 桌面端本地无 token 明细，仅能提供会话时长
- Codex 走订阅额度，官方 API 价目表无 token 单价，费用需手工补录
- 「输出缓存命中率」在 LLM 语义上不存在，界面固定显示 `—`
- 「统计」页数据来自本地流水表，升级到事件口径之前的旧任务可能缺少事件明细
