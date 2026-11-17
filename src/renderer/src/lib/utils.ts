import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import type { AlertKind, ToolId } from '@shared/types'
import { TOOL_META } from '@shared/types'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function toolColor(tool: ToolId): string {
  return TOOL_META[tool]?.color ?? '#8A99AD'
}

export function toolName(tool: ToolId): string {
  return TOOL_META[tool]?.displayName ?? tool
}

export function toolMonogram(tool: ToolId): string {
  switch (tool) {
    case 'codex':
      return 'Cx'
    case 'claude-code':
      return 'Cl'
    case 'deepseek-harness':
      return 'DS'
    case 'codebuddy':
      return 'CB'
    case 'workbuddy':
      return 'WB'
    case 'cursor':
      return 'Cu'
    case 'yuanbao':
      return '元'
    default:
      return 'AI'
  }
}

export const ALERT_TONE: Record<AlertKind, 'warn' | 'danger' | 'info'> = {
  cost_warn: 'warn',
  cost_danger: 'danger',
  duration_warn: 'warn',
  duration_danger: 'danger',
  cache_low: 'info',
  adapter_error: 'danger'
}

export function statusTone(status: string): 'ok' | 'warn' | 'off' | 'info' {
  if (status === 'running') return 'ok'
  if (status === 'idle') return 'warn'
  if (status === 'ended') return 'off'
  return 'info'
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`
}
