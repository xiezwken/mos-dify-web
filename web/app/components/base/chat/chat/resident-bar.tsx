import type { FC } from 'react'
import type { ChatItem } from '../types'
import { cn } from '@langgenius/dify-ui/cn'
import { useEffect, useState } from 'react'

// ===== 刀1 施工席心跳灯（一点一灯·三色版 v2.1）=====
// 数据源：fetch 8088 静态服务下的 /运行时/heartbeat.json（mos-static，与跳转目标同址）
const HB_URL = 'http://localhost:8088/运行时/heartbeat.json'
const HB_FRESH_MS = 3 * 60 * 1000   // <3 分钟 = 在跑（黄）
const HB_STALE_MS = 10 * 60 * 1000  // 3~10 分钟 = 出事（红）；>10 分钟 = 僵尸退场（灭）
const DONE_GRACE_MS = 10 * 60 * 1000 // done 后保留 10 分钟（绿点退场）
// OC 施工看板默认地址（A1 实测 HTTP 200，硬编码）
const DEFAULT_SEAT_URL = 'http://localhost:8088/台账/OC状态看板.html'

// ===== 刀2 对话轮标尺（挂账 P-01 定稿口径，本令零改动）=====
// 阈值只从规格取值：12／70%／15／2 次
const RED_LINE_TURN = 15 // 红线轮次
const YELLOW_LINE_TURN = 12 // 黄线轮次

type DotColor = 'yellow' | 'red' | 'green'

interface HbEntry {
  task_id: string
  heartbeat: number
  state: 'running' | 'done'
  done_at: number | null
}

interface HbView {
  kind: 'dots' | 'idle' | 'unavailable'
  dots: { taskId: string; color: DotColor }[]
}

/**
 * 灯语义（沐宸钦定，一点一单）：
 * - done 且 done_at 距今 ≤10 分钟 → 绿点（收口）
 * - running 且心跳 <3 分钟 → 黄点（在跑）
 * - running 且心跳 3~10 分钟 → 红点（出事）
 * - running 且心跳 >10 分钟 → 僵尸退场（灭，不显示）
 * - done 且 done_at >10 分钟 → 绿点退场（灭，不显示）
 * - 空数组 → 空闲
 * - 数据不可读 → 未接心跳源
 */
function computeHbView(entries: HbEntry[] | null): HbView {
  if (entries === null) return { kind: 'unavailable', dots: [] }
  if (!entries.length) return { kind: 'idle', dots: [] }
  const now = Date.now()
  const dots: { taskId: string; color: DotColor }[] = []
  for (const e of entries) {
    if (e.state === 'done') {
      if (e.done_at != null && now - e.done_at > DONE_GRACE_MS) continue
      dots.push({ taskId: e.task_id, color: 'green' })
    } else {
      const age = now - e.heartbeat
      if (age > HB_STALE_MS) continue
      dots.push({ taskId: e.task_id, color: age < HB_FRESH_MS ? 'yellow' : 'red' })
    }
  }
  return dots.length ? { kind: 'dots', dots } : { kind: 'idle', dots: [] }
}

/**
 * A1 常驻条：刀1 心跳灯（多点三色）＋刀2 对话轮标尺，共用同一常驻条区域。
 * 落点：总参席 webapp 会话界面，消息流末尾、输入框上方。
 * 高 ≤32px，不遮挡输入框，不影响发送/上传按钮点击区域。
 * 任一刀数据源失败：该刀降级，另一刀照常工作。
 */
export const ResidentBar: FC<{ chatList: ChatItem[] }> = ({ chatList }) => {
  const [hb, setHb] = useState<HbView>(() => ({ kind: 'unavailable', dots: [] }))

  // 每 30s 拉取心跳源，刷新灯态
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(HB_URL, { cache: 'no-store' })
        if (!res.ok) {
          if (!cancelled) setHb({ kind: 'unavailable', dots: [] })
          return
        }
        const data = await res.json()
        const arr: HbEntry[] = Array.isArray(data) ? data : []
        if (!cancelled) setHb(computeHbView(arr))
      } catch {
        if (!cancelled) setHb({ kind: 'unavailable', dots: [] })
      }
    }
    poll()
    const timer = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  // 刀2：N = 本会话已发生的用户回合数（chatList 中 isAnswer=false 的条目数，含本轮）
  const N = chatList.filter((item) => !item.isAnswer).length
  const X = RED_LINE_TURN - N
  // 余量取真实值：黄灯显示实际余量（3/2/1），红灯落 0，不虚增、不为负
  const displayX = Math.max(0, X)

  // 标尺颜色与提示（零改动，换血阈值口径）
  let rulerColor: 'normal' | 'yellow' | 'red' = 'normal'
  let rulerHint = ''
  if (N >= RED_LINE_TURN) {
    rulerColor = 'red'
    rulerHint = '换新会话，旧会话封存出断点件'
  } else if (N >= YELLOW_LINE_TURN) {
    rulerColor = 'yellow'
    rulerHint = '快该换会话了，把没说完的落到断点件'
  }

  // 点击任一点/灯 → 打开施工席界面（硬编码默认地址，A1 实测 HTTP 200）
  const handleLightClick = () => {
    window.open(DEFAULT_SEAT_URL, '_blank')
  }

  const dotCls: Record<DotColor, string> = {
    yellow: 'bg-amber-500',
    red: 'bg-red-500',
    green: 'bg-green-500',
  }

  const rulerCls = {
    normal: 'text-text-secondary',
    yellow: 'text-amber-500',
    red: 'text-red-500',
  }[rulerColor]

  return (
    <div
      data-testid="mos-resident-bar"
      className="pointer-events-auto flex h-8 select-none items-center justify-between gap-3 px-4 text-xs"
    >
      {/* 刀1：施工席心跳灯（一点一灯·三色版）*/}
      <button
        type="button"
        onClick={handleLightClick}
        className="flex items-center gap-1.5"
        title="点击打开施工席界面"
      >
        {hb.kind === 'dots' ? (
          hb.dots.map((d) => (
            <span key={d.taskId} className="flex items-center gap-1.5">
              <span className={cn('inline-block size-2 shrink-0 rounded-full', dotCls[d.color])} />
              <span className="text-text-secondary">{d.taskId}</span>
            </span>
          ))
        ) : (
          <span className="text-text-secondary">施工席：{hb.kind === 'idle' ? '空闲' : '未接心跳源'}</span>
        )}
      </button>

      {/* 刀2：对话轮标尺（零改动）*/}
      <div className="flex items-center gap-2" title={rulerHint || undefined}>
        <span className={cn('font-medium', rulerCls)}>
          轮次 {N} ｜ 余量 {displayX}
        </span>
        {rulerHint && <span className={rulerCls}>{rulerHint}</span>}
      </div>
    </div>
  )
}

export default ResidentBar
