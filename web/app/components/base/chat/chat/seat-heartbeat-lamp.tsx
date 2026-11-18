import type { FC } from 'react'
import { cn } from '@langgenius/dify-ui/cn'
import { useEffect, useState } from 'react'

// ===== 席位心跳灯（忙闲三态常驻条 v1.2 · LAMP-V12-20261118-DE）=====
// v1.2 裁撤黄态：OC 空闲不打心跳，干完活 30 分钟后会误亮黄点——
//   黄态无法区分「活着但闲」与「半死」，故删除；席位存活以接口可达性为准（404/超时即「数据源未接通」）。
// v1.2 文案：圆点＋「施工席·<seat>」，四态文字缀于席名之后（为后续多施工席并入预留）。
// 数据源：GET http://localhost:28895/api/seat_heartbeat（seat_heartbeat_server.py v1.1，未改动）
// 响应约定：{ seat, last_heartbeat(ISO), status, busy(boolean), current_task?, busy_since? }
// 四态：
//   红 = busy=true 且距最新打点 >30 分钟 → 「施工席·<seat>·在跑超时」
//   绿 = busy=true 且距最新打点 ≤30 分钟 → 「施工席·<seat>·在跑·<当前任务名>」
//   灰 = busy=false（不论打点多久）        → 「施工席·<seat>·空闲」
//   灰 = 接口 404／超时／结构不符           → 「数据源未接通」
// 点击：跳 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）
// 挂载：chat 输入区，与 resident-bar.tsx 的 ResidentBar 同层相邻（输入框上方）
const SEAT_HEARTBEAT_URL = 'http://localhost:28895/api/seat_heartbeat'
const OC_BOARD_URL = 'http://localhost:8088/台账/OC状态看板.html'
const POLL_INTERVAL_MS = 60 * 1000
const STALE_MAX_MS = 30 * 60 * 1000 // 在跑且打点距今 >30 分钟 = 在跑超时
const SEAT_PREFIX = '施工席·'

type LampColor = 'green' | 'red' | 'gray'

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
  const seatLabel = `${SEAT_PREFIX}${payload.seat.trim() || '未署名'}`
  const task = (payload.current_task || '').trim()
  const taskLabel = task || '未署名任务'

  // 红：在跑且打点超 30 分钟（疑卡死）
  if (payload.busy && stale)
    return { color: 'red', label: `${seatLabel}·在跑超时`, detail: `在跑但最新打点距今 ${ageMinutes} 分钟（阈值 30）·任务 ${taskLabel}` }

  // 绿：在跑且打点新鲜
  if (payload.busy)
    return { color: 'green', label: `${seatLabel}·在跑·${taskLabel}`, detail: `在跑（打点距今 ${ageMinutes} 分钟）·起于 ${payload.busy_since || '未标注'}·最近状态 ${payload.status || '未标注'}` }

  // 灰：空闲（不论打点距今多久——空闲不打心跳属正常，不再判黄态）
  return { color: 'gray', label: `${seatLabel}·空闲`, detail: `空闲（最近打点距今 ${ageMinutes} 分钟）·最近状态 ${payload.status || '未标注'}` }
}

/**
 * 席位心跳灯（忙闲三态 v1.2）：细条常驻输入框上方，高 24px（h-6），内容＝状态圆点＋「施工席·<seat>」＋状态文字。
 * 点击整条＝新开窗口打开 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）。
 * 三态：绿（在跑）／红（在跑超时）／灰（空闲或数据源未接通）。
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
