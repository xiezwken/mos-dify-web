import type { FC } from 'react'
import { cn } from '@langgenius/dify-ui/cn'
import { useEffect, useState } from 'react'

// ===== 席位灯条（合一版 v1.3 · LAMP-V13-20261118-F）=====
// 沐宸钦定：对话页只保留一行灯条（旧「施工席：空闲」条已从 resident-bar 摘除）。
// 行格式：`施工席：` ＋ 灯点 ＋ 终端显示名（seat 值经前端映射表显示，OC → OpenCode）。
// 显示口径（灯色即状态，空闲不缀状态词）：
//   空闲（busy=false）        → 灰点 ＋ OpenCode
//   在跑（busy=true，≤30min）  → 绿点 ＋ OpenCode ＋ 当前任务名
//   在跑超时（busy，>30min）   → 红点 ＋ OpenCode ＋ 超时
//   接口 404／超时／结构不符    → 灰点 ＋ OpenCode ＋ 数据源未接通
// 数据源：GET http://localhost:28895/api/seat_heartbeat（seat_heartbeat_server.py v1.1，本令未改）
// 点击：跳 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）
// 多席并排：行内容器为 flex 横排，items 现为 1 席（seats 数组），后续增席仅需扩充数组，后端接口不动。
const SEAT_HEARTBEAT_URL = 'http://localhost:28895/api/seat_heartbeat'
const OC_BOARD_URL = 'http://localhost:8088/台账/OC状态看板.html'
const POLL_INTERVAL_MS = 60 * 1000
const STALE_MAX_MS = 30 * 60 * 1000 // 在跑且打点距今 >30 分钟 = 超时
const ROW_PREFIX = '施工席：'
const GAP_CLASS = 'gap-2' // 8px：前缀↔灯点、多席条目之间统一加宽
const DOT_NAME_GAP = 'gap-1' // 4px：灯点↔席名（LAMP-V13F-20261118-G 收紧）

// 终端显示名映射（前端写死；新增席位在此登记，未知 key 回落原值）
const SEAT_DISPLAY: Record<string, string> = {
  OC: 'OpenCode',
}
const FALLBACK_SEAT_KEY = 'OC'
const FALLBACK_SEAT_NAME = 'OpenCode'

type LampColor = 'green' | 'red' | 'gray'

interface SeatHeartbeatPayload {
  seat: string
  last_heartbeat: string
  status: string
  busy: boolean
  current_task?: string
  busy_since?: string | null
}

interface SeatView {
  key: string
  color: LampColor
  name: string
  suffix: string // '' 表示不缀任何状态词（空闲）
  detail: string
}

// 降级态：接口 404／超时／结构不符／时间戳不可解析
const OFFLINE_VIEW: SeatView = {
  key: FALLBACK_SEAT_KEY,
  color: 'gray',
  name: FALLBACK_SEAT_NAME,
  suffix: '数据源未接通',
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

function computeSeatView(payload: SeatHeartbeatPayload, now: number): SeatView {
  const heartbeatAt = Date.parse(payload.last_heartbeat)
  if (Number.isNaN(heartbeatAt))
    return OFFLINE_VIEW

  const seatKey = (payload.seat || '').trim() || FALLBACK_SEAT_KEY
  const name = SEAT_DISPLAY[seatKey] || seatKey
  const ageMinutes = Math.round(Math.max(0, now - heartbeatAt) / 60000)
  const stale = now - heartbeatAt > STALE_MAX_MS
  const task = (payload.current_task || '').trim()

  // 红：在跑且打点超 30 分钟 → 名字后缀「超时」
  if (payload.busy && stale)
    return { key: seatKey, color: 'red', name, suffix: '超时', detail: `在跑但最新打点距今 ${ageMinutes} 分钟（阈值 30）·任务 ${task || '未署名任务'}` }

  // 绿：在跑且打点新鲜 → 名字后接当前任务名
  if (payload.busy)
    return { key: seatKey, color: 'green', name, suffix: task || '未署名任务', detail: `在跑（打点距今 ${ageMinutes} 分钟）·起于 ${payload.busy_since || '未标注'}·最近状态 ${payload.status || '未标注'}` }

  // 灰：空闲（不缀任何状态词）
  return { key: seatKey, color: 'gray', name, suffix: '', detail: `空闲（最近打点距今 ${ageMinutes} 分钟）·最近状态 ${payload.status || '未标注'}` }
}

/**
 * 席位灯条（合一版 v1.3）：`施工席：● OpenCode[ 状态]`，常驻输入框上方，高 24px（h-6）。
 * 点击整条＝新开窗口打开 OC 状态看板（http://localhost:8088/台账/OC状态看板.html）。
 */
export const SeatHeartbeatLamp: FC = () => {
  const [view, setView] = useState<SeatView>(OFFLINE_VIEW)

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
          setView(OFFLINE_VIEW)
          return
        }
        const data: unknown = await res.json()
        if (cancelled)
          return
        setView(isSeatHeartbeatPayload(data) ? computeSeatView(data, Date.now()) : OFFLINE_VIEW)
      }
      catch {
        if (!cancelled)
          setView(OFFLINE_VIEW)
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

  // 多席并排预留：当前仅 1 席；后续 `[...views]` 横排即可，后端接口不动
  const seats: SeatView[] = [view]

  const handleLampClick = () => {
    window.open(encodeURI(OC_BOARD_URL), '_blank')
  }

  return (
    <button
      type="button"
      data-testid="mos-seat-heartbeat-lamp"
      onClick={handleLampClick}
      title={seats.map(s => s.detail).join(' / ')}
      aria-label={`${ROW_PREFIX}${seats.map(s => `${s.name}${s.suffix ? ` ${s.suffix}` : ''}`).join('，')}（点击打开 OC 状态看板）`}
      className={cn(
        'pointer-events-auto flex h-6 w-full select-none items-center px-4 text-xs text-text-secondary',
        GAP_CLASS,
      )}
    >
      <span className="shrink-0">{ROW_PREFIX}</span>
      <span className={cn('flex min-w-0 items-center', GAP_CLASS)}>
        {seats.map(seat => (
          <span key={seat.key} className={cn('flex min-w-0 items-center', DOT_NAME_GAP)}>
            <span className={cn('inline-block size-2 shrink-0 rounded-full', dotCls[seat.color])} />
            <span className="shrink-0 font-medium text-text-primary">{seat.name}</span>
            {seat.suffix && <span className="truncate">{seat.suffix}</span>}
          </span>
        ))}
      </span>
    </button>
  )
}

export default SeatHeartbeatLamp
