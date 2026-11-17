import type { ToolAdapter } from './base'
import { CodexAdapter } from './codex'
import { ClaudeCodeAdapter } from './claude-code'
import { WorkBuddyAdapter } from './workbuddy'
import { CodeBuddyAdapter } from './codebuddy'
import { CursorAdapter } from './cursor'
import { DeepSeekHarnessAdapter } from './deepseek-harness'
import { YuanbaoAdapter } from './yuanbao'

export type AdapterFactory = () => ToolAdapter

/**
 * 适配器注册表 —— 接入新工具只需：
 * 1) 实现 ToolAdapter；2) 在此 push 一个工厂函数。
 * 采集引擎、数据库、界面均无需改动。
 */
const factories: AdapterFactory[] = [
  () => new CodexAdapter(),
  () => new ClaudeCodeAdapter(),
  () => new WorkBuddyAdapter(),
  () => new CodeBuddyAdapter(),
  () => new CursorAdapter(),
  () => new DeepSeekHarnessAdapter(),
  () => new YuanbaoAdapter()
]

export function registerAdapter(factory: AdapterFactory): void {
  factories.push(factory)
  console.log(`[registry] adapter registered, total=${factories.length}`)
}

export function createAdapters(): ToolAdapter[] {
  return factories.map((factory) => factory())
}

export function adapterCount(): number {
  return factories.length
}
