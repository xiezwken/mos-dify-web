import type { FC } from 'react'
import { cn } from '@langgenius/dify-ui/cn'
import { useEffect, useState } from 'react'

// ===== 席位心跳灯（四态常驻条·LAMP-3STATE-20261118-A）=====
// 数据源：GET http://localhost:28894/api/seat_heartbeat
// 响应约定：{ seat: string; last_heartbeat: string(ISO); status: string }
// 挂载：chat 输入区，与 resident-bar.tsx 的 ResidentBar 同层相邻（输入框上方）
const SEAT_HEARTBEAT_URL = 'http://localhost:28894/api/seat_heartbeat'
const OC_CONSOLE_URL = 'http://localhost:4096'
const POLL_INTERVAL_MS = 60 * 1000
const GREEN_MAX_MS = 15 * 60 * 1000 // 心跳距今 <15 分钟 = 绿
const YELLOW_MAX_MS = 30 * 60 * 1000 // 15~30 分钟 = 黄；>30 分钟 = 红
const INTERRUPTED_KEYWORD = '中断' // status 含「中断」（干活中中断）= 红

type LampColor = 'green' | 'yellow' | 'red' | 'gray'

interface SeatHeartbeatPayload {
  seat: string
  last_heartbeat: string
  status: string
}

interface LampView {
  color: LampColor
  label: string
  detail: string
}

// 灰态：接口 404／超时／响应结构不符／时间戳不可解析，一律降级为「数据源未接通」
const GRAY_VIEW: LampView = {
  color: 'gray',
  label: '数据源未接通',
  detail: '心跳接口不可达（404／超时／数据不可解析）',
}

function isSeatHeartbeatPayload(value: unknown): value is SeatHeartbeatPayload {
  if (typeof value !== 'object' || value === null)
    return false
  const record = value as Record<string, unknown>
  return (
    typeof record.seat === 'string'
    && typeof record.last_heartbeat === 'string'
    && typeof record.status === 'string'
  )
}

function computeLampView(payload: SeatHeartbeatPayload, now: number): LampView {
  const heartbeatAt = Date.parse(payload.last_heartbeat)
  if (Number.isNaN(heartbeatAt))
    return GRAY_VIEW

  const seat = payload.seat.trim() || '席位未署名'
  const ageMinutes = Math.round(Math.max(0, now - heartbeatAt) / 60000)
  const status = payload.status.trim()

  if (status.includes(INTERRUPTED_KEYWORD))
    return { color: 'red', label: seat, detail: `状态「${status || '干活中中断'}」·最近心跳 ${payload.last_heartbeat}` }

  if (now - heartbeatAt < GREEN_MAX_MS)
    return { color: 'green', label: seat, detail: `心跳正常（距今 ${ageMinutes} 分钟）·状态 ${status || '未标注'}·最近心跳 ${payload.last_heartbeat}` }

  if (now - heartbeatAt <= YELLOW_MAX_MS)
    return { color: 'yellow', label: seat, detail: `心跳滞后（距今 ${ageMinutes} 分钟）·状态 ${status || '未标注'}·最近心跳 ${payload.last_heartbeat}` }

  return { color: 'red', label: seat, detail: `心跳超时（距今 ${ageMinutes} 分钟）·状态 ${status || '未标注'}·最近心跳 ${payload.last_heartbeat}` }
}

/**
 * 席位心跳灯：细条常驻输入框上方，高 24px（h-6），内容＝状态圆点＋席位名。
 * 点击整条＝新开窗口打开 OC 施工界面（http://localhost:4096）。
 * 四态：绿（<15min）／黄（15~30min）／红（>30min 或 status 含「中断」）／灰（数据源未接通）。
 */
export const SeatHeartbeatLamp: FC = () => {
  const [view, setView] = useState<LampView>(GRAY_VIEW)

  // 60 秒轮询一次；组件卸载时置 cancelled 并清理定时器
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      try {
        const res = await fetch(SEAT_HEARTBEAT_URL, { cache: 'no-store' })
        if (cancelled)
          return
        if (!res.ok) {
          setView(GRAY_VIEW)
          return
        }
        const data: unknown = await res.json()
        if (cancelled)
          return
        setView(isSeatHeartbeatPayload(data) ? computeLampView(data, Date.now()) : GRAY_VIEW)
      }
      catch {
        if (!cancelled)
          setView(GRAY_VIEW)
      }
    }

    poll()
    timer = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timer !== null)
        clearInterval(timer)
    }
  }, [])

  const dotCls: Record<LampColor, string> = {
    green: 'bg-green-500',
    yellow: 'bg-amber-500',
    red: 'bg-red-500',
    gray: 'bg-gray-400',
  }

  const handleLampClick = () => {
    window.open(OC_CONSOLE_URL, '_blank')
  }

  return (
    <button
      type="button"
      data-testid="mos-seat-heartbeat-lamp"
      onClick={handleLampClick}
      title={view.detail}
      aria-label={`${view.label}（点击打开施工界面）`}
      className="pointer-events-auto flex h-6 w-full select-none items-center gap-1.5 px-4 text-xs text-text-secondary"
    >
      <span className={cn('inline-block size-2 shrink-0 rounded-full', dotCls[view.color])} />
      <span className="truncate">{view.label}</span>
    </button>
  )
}

export default SeatHeartbeatLamp
