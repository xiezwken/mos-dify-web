import type { FC } from 'react'
import { cn } from '@langgenius/dify-ui/cn'
import { useEffect, useState } from 'react'

// ===== 席位心跳灯（忙闲四态常驻条 v1.1 · LAMP-BUSY-20261118-B）=====
// 语义升版：由「心跳健康」改为「忙闲」——绿=在跑、灰=空闲（沐宸 2026-11-18 裁定，苏沐 v1.1 规格）
// 数据源：GET http://localhost:28895/api/seat_heartbeat（seat_heartbeat_server.py v1.1）
// 响应约定：{ seat, last_heartbeat(ISO), status, busy(boolean), current_task?, busy_since? }
// 四态：
//   绿 = busy=true 且距最新打点 ≤30 分钟 → 「在跑·<当前任务名>」
//   灰 = busy=false（且未休眠）        → 「空闲」
//   黄 = 最新心跳距今 >30 分钟          → 「休眠」
//   红 = busy=true 且距最新打点 >30 分钟 → 「在跑超时」
//   接口 404／超时／结构不符            → 灰点 +「数据源未接通」
// 点击：跳 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）——4096 网页版已退役（OC-RETIRED-20261118-C）
// 挂载：chat 输入区，与 resident-bar.tsx 的 ResidentBar 同层相邻（输入框上方）
const SEAT_HEARTBEAT_URL = 'http://localhost:28895/api/seat_heartbeat'
const OC_BOARD_URL = 'http://localhost:8088/台账/OC状态看板.html'
const POLL_INTERVAL_MS = 60 * 1000
const STALE_MAX_MS = 30 * 60 * 1000 // 最新打点距今 >30 分钟 = 休眠／在跑超时

type LampColor = 'green' | 'yellow' | 'red' | 'gray'

interface SeatHeartbeatPayload {
  seat: string
  last_heartbeat: string
  status: string
  busy: boolean
  current_task?: string
  busy_since?: string | null
}

interface LampView {
  color: LampColor
  label: string
  detail: string
}

// 灰态降级：接口 404／超时／响应结构不符／时间戳不可解析，一律「数据源未接通」
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
    && typeof record.busy === 'boolean'
  )
}

function computeLampView(payload: SeatHeartbeatPayload, now: number): LampView {
  const heartbeatAt = Date.parse(payload.last_heartbeat)
  if (Number.isNaN(heartbeatAt))
    return GRAY_VIEW

  const ageMinutes = Math.round(Math.max(0, now - heartbeatAt) / 60000)
  const stale = now - heartbeatAt > STALE_MAX_MS
  const task = (payload.current_task || '').trim()
  const taskLabel = task || payload.seat.trim() || '未署名任务'

  // 红：忙着但打点已超 30 分钟（疑卡死）
  if (payload.busy && stale)
    return { color: 'red', label: '在跑超时', detail: `在跑但最新打点距今 ${ageMinutes} 分钟（阈值 30）·任务 ${taskLabel}` }

  // 黄：空闲且打点超 30 分钟（休眠）
  if (!payload.busy && stale)
    return { color: 'yellow', label: '休眠', detail: `无作业且最新打点距今 ${ageMinutes} 分钟（阈值 30）·最近状态 ${payload.status || '未标注'}` }

  // 绿：在跑且打点新鲜
  if (payload.busy)
    return { color: 'green', label: `在跑·${taskLabel}`, detail: `在跑（打点距今 ${ageMinutes} 分钟）·起于 ${payload.busy_since || '未标注'}·最近状态 ${payload.status || '未标注'}` }

  // 灰：空闲
  return { color: 'gray', label: '空闲', detail: `空闲（最近打点距今 ${ageMinutes} 分钟）·最近状态 ${payload.status || '未标注'}` }
}

/**
 * 席位心跳灯（忙闲版 v1.1）：细条常驻输入框上方，高 24px（h-6），内容＝状态圆点＋状态文字。
 * 点击整条＝新开窗口打开 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）。
 * 四态：绿（在跑）／灰（空闲）／黄（休眠，>30min 无打点）／红（在跑超时，busy 且 >30min）。
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
    window.open(encodeURI(OC_BOARD_URL), '_blank')
  }

  return (
    <button
      type="button"
      data-testid="mos-seat-heartbeat-lamp"
      onClick={handleLampClick}
      title={view.detail}
      aria-label={`${view.label}（点击打开 OC 状态看板）`}
      className="pointer-events-auto flex h-6 w-full select-none items-center gap-1.5 px-4 text-xs text-text-secondary"
    >
      <span className={cn('inline-block size-2 shrink-0 rounded-full', dotCls[view.color])} />
      <span className="truncate">{view.label}</span>
    </button>
  )
}

export default SeatHeartbeatLamp
