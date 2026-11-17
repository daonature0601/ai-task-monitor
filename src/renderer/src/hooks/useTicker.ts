import { useEffect, useState } from 'react'

/**
 * 本地秒级计时器：仅在存在运行中任务时开启，
 * 让"已执行时长"平滑跳动而不产生任何 IPC 往返。
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) {
      setNow(Date.now())
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs])

  return now
}

/** 倒计时式提醒：返回当前时间戳，每分钟刷新一次，用于"x 分钟前"文案 */
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}
