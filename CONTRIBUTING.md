# 贡献指南

感谢你愿意参与 AI Task Monitor。本文档说明本地开发、代码约定，以及最常见的贡献场景 —— **接入一个新的 AI 工具**。

---

## 1. 环境准备

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 20 |
| npm | ≥ 10 |
| 系统 | macOS 12+ / Windows 10+ |

```bash
git clone https://github.com/<your-account>/ai-task-monitor.git
cd ai-task-monitor

npm install --ignore-scripts   # 跳过 better-sqlite3 针对 Node 的编译
npm run setup                  # 下载 Electron 运行时 + better-sqlite3 的 Electron ABI 产物
npm run dev                    # 启动开发模式
```

> 必须使用 `--ignore-scripts` + `npm run setup` 两步安装：better-sqlite3 需要匹配 Electron ABI 的二进制，
> 直接 `npm install` 会针对 Node 编译，导致运行时报 `NODE_MODULE_VERSION` 不匹配。

常用命令：

```bash
npm run typecheck   # 主进程 + 渲染进程两套 tsconfig
npm test            # 纯函数与状态机单测（vitest）
npm run build       # 编译到 out/
npm run smoke       # 无界面自检，打印适配器状态与汇总后退出
npm run dist:mac    # 打包 dmg
```

---

## 2. 代码约定

- **TypeScript 严格模式**，不使用 `any`（确有必要用 `unknown` + 收窄）
- 单个文件尽量不超过 300 行，超出请拆分
- 主进程不引入渲染层依赖；渲染层通过 `window.monitor`（见 `src/shared/ipc-contract.ts`）与主进程通信
- 纯函数（格式化、计价、状态迁移）放在可单测的位置，新增逻辑请补 `tests/`
- 注释写「为什么」，不写「做了什么」
- 提交前必须通过 `npm run typecheck && npm test`

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(adapters): 接入 Windsurf 会话日志
fix(stats): 按事件时间归集费用，避免跨天任务归属错误
docs(readme): 补充桥接安装步骤
```

---

## 3. 接入一个新的 AI 工具

这是最有价值的贡献。整体只需要两步：**写一个适配器** + **在注册表加一行**。

### 3.1 找到真实数据源

先用 `ls` / `sqlite3` 确认工具把数据写在哪，**不要凭猜测写路径**：

```bash
# 常见落盘位置
ls -la ~/.<tool>                     # CLI 会话
ls -la ~/Library/Application\ Support/<Tool>   # 桌面端（macOS）
```

需要确认三件事：

1. 会话/任务是如何标识的（session id、文件路径、数据库主键）
2. Token 字段的语义：是**累计值**还是**每轮增量**；`input_tokens` 是否**包含缓存命中**
3. 时间字段是秒还是毫秒、是 UTC 还是本地时间

### 3.2 实现适配器

新建 `src/main/adapters/<tool>/index.ts`：

```ts
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, emptyUsage, type DetectResult } from '../base'

export class WindsurfAdapter extends BaseAdapter {
  readonly id: ToolId = 'windsurf'
  readonly displayName = 'Windsurf'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,      // 能否拿到 token
    liveStream: true,  // 是否有实时事件（否则是轮询）
    bridgeRequired: false
  }

  async detect(): Promise<DetectResult> {
    const path = homePath('.windsurf', 'sessions')
    return { installed: existsSync(path), dataPath: path, message: existsSync(path) ? undefined : '未找到会话目录' }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    // 有 JSONL 的直接复用 JsonlTailer（自动增量续读、去重、断点恢复）
    this.tailer = new JsonlTailer({
      roots: [this.dataPath!],
      glob: '**/*.jsonl',
      depth: 3,
      debounceMs: ctx.settings().fileDebounceMs,
      backfillDays: 7,
      maxBytesPerRead: 4 * 1024 * 1024,
      cursors: ctx.cursors,
      onLine: (line, meta) => this.handleLine(line, meta),
      onError: (error) => this.fail(error)
    })
    await this.tailer.start()
  }

  private handleLine(line: string, meta: LineContext): void {
    const obj = JSON.parse(line)
    this.push({
      tool: this.id,
      externalSessionId: obj.sessionId,   // 会话标识
      ts: obj.timestamp,                  // 事件时间（毫秒）
      title: obj.title,
      model: obj.model,
      inputTokens: obj.usage.input - obj.usage.cached, // 归一化为「非缓存输入」
      outputTokens: obj.usage.output,
      cacheReadTokens: obj.usage.cached,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      tokensSource: 'native',             // 取不到就写 'unavailable'
      dedupeKey: `msg:${obj.id}`          // 幂等键，重复解析不会重复计费
    })
  }
}
```

**关键约束**：

- `UsageDelta` 的四个 token 字段必须是**真实值或 0**，禁止估算；拿不到就整体标 `tokensSource: 'unavailable'`
- `dedupeKey` 必须在同一事件上稳定（用 message id 或 `文件:字节偏移`），否则重启会重复计费
- 若数据源只有「进程心跳」而没有用量，请参考 `codebuddy` 适配器：**心跳只证明进程活着，不能当作任务活动**

### 3.3 注册

`src/main/adapters/registry.ts` 加一行：

```ts
export function createAdapters(): ToolAdapter[] {
  return [
    new CodexAdapter(),
    // ...
    new WindsurfAdapter()
  ]
}
```

同时在 `src/shared/types.ts` 的 `ToolId`、`TOOL_IDS`、`TOOL_META` 中补充工具信息（名称、品牌色、数据源提示）。

### 3.4 补充测试

至少覆盖：

- token 归一化（累计值差分、缓存命中扣减）
- 去重键稳定性（同一行解析两次只产生一条事件）
- 时间戳解析（秒/毫秒、字符串格式）

`tests/task-machine.test.ts` 里有现成的构造 `UsageDelta` 的写法可参考。

---

## 4. 提交 PR 前

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 通过（新增逻辑附带测试）
- [ ] 本地 `npm run dev` 实际跑过，界面无报错
- [ ] 适配器类改动附上「实测数据样本」（脱敏后），说明字段语义
- [ ] 不提交 `node_modules/`、`out/`、`release/`、本地 `.db` 与日志

PR 描述请说明：**动机 → 改动点 → 验证方式**，必要时附截图。

---

## 5. 许可与行为准则

本项目以 [MIT License](LICENSE) 授权。提交 PR 即表示你同意将自己的贡献
以同一许可（MIT）授权给本项目，并确认你有权这样做。

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，
安全问题请按 [SECURITY.md](SECURITY.md) 私下反馈。
