import { existsSync } from 'node:fs'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, type DetectResult } from '../base'
import { TOOL_PATHS } from '../../collectors/paths'
import { PROCESS_MATCHERS } from '../../collectors/process-probe'

/**
 * 元宝（腾讯）适配器。
 * 实测：~/Library/Application Support/com.tencent.yuanbao 仅含 .qimei 与 Documents，
 * 本地不存在任何会话/token 落盘，因此真实采集只能依赖网页桥接上报。
 * 桥接缺失时降级为"进程存活 + 会话时长"，token 标记 unavailable，不做任何估算。
 */
export class YuanbaoAdapter extends BaseAdapter {
  readonly id: ToolId = 'yuanbao'
  readonly displayName = '元宝'
  readonly channel = 'bridge' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: true
  }

  private timer: NodeJS.Timeout | null = null

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.yuanbao()
    const path = spec.primary && existsSync(spec.primary) ? spec.primary : null
    return {
      installed: true,
      dataPath: path,
      message: '元宝无本地 token 落盘，需在浏览器安装上报脚本才能获取用量'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    this.installed = true
    this.timer = setInterval(() => {
      void this.aliveFallback(PROCESS_MATCHERS.yuanbao, '元宝')
    }, 60_000)
    console.log('[adapter:yuanbao] bridge-first adapter started')
  }

  protected async onStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
