import type { FC } from 'react'
import type { ChatItem } from '../types'
import { cn } from '@langgenius/dify-ui/cn'
import { toast } from '@langgenius/dify-ui/toast'
import { useEffect, useState } from 'react'

// ===== 刀1 施工席心跳灯（挂账 N-03 定稿口径）=====
// 心跳阈值：规格钉死 15 分钟
const HEARTBEAT_THRESHOLD_MIN = 15
// 心跳数据源：localStorage（施工席报活节拍写入；本规格不预设路径，由施工方回执写明）
const HB_KEY = 'mos_construction_heartbeat' // 心跳时间戳 epoch ms
const HB_TASK_KEY = 'mos_construction_task' // 'active' 干活中 / 'idle' 无任务
const SEAT_URL_KEY = 'mos_construction_seat_url' // 施工席界面地址（localStorage 覆盖项，空值走默认）
// OC 施工看板默认地址（与心跳源同址）：mos-static 静态服务 8088 下的 台账/OC状态看板.html
const DEFAULT_SEAT_URL = 'http://localhost:8088/%E5%8F%B0%E8%B4%A6/OC%E7%8A%B6%E6%80%81%E7%9C%8B%E6%9D%BF.html'

// ===== 刀2 对话轮标尺（挂账 P-01 定稿口径）=====
// 阈值只从规格取值：12／70%／15／2 次
const RED_LINE_TURN = 15 // 红线轮次
const YELLOW_LINE_TURN = 12 // 黄线轮次
const SLOWDOWN_RED_THRESHOLD = 2 // 变慢累计 2 次触发红线
const SLOWDOWN_KEY = 'mos_slowdown_count' // 变慢计数 localStorage 键

type HbState = 'green' | 'orange' | 'gray'

/**
 * 刀1 判活口径（钉死）：
 * - 无心跳数据源 → 灰灯＋「未接心跳源」
 * - 有心跳＋干活中：15 分钟内 → 绿灯「干活中 N 分钟前」；超 15 分钟 → 橙灯「疑中断 N 分钟」
 * - 无任务 → 灰灯「空闲」
 */
function computeHeartbeat(): { state: HbState; text: string } {
  const raw = localStorage.getItem(HB_KEY)
  if (!raw) return { state: 'gray', text: '未接心跳源' }
  const ts = Number(raw)
  if (!ts || ts <= 0) return { state: 'gray', text: '未接心跳源' }
  const minutesAgo = Math.floor((Date.now() - ts) / 60000)
  const task = localStorage.getItem(HB_TASK_KEY)
  if (task === 'active') {
    if (minutesAgo < HEARTBEAT_THRESHOLD_MIN) {
      return { state: 'green', text: `干活中 ${minutesAgo} 分钟前` }
    }
    return { state: 'orange', text: `疑中断 ${minutesAgo} 分钟` }
  }
  return { state: 'gray', text: '空闲' }
}

/**
 * A1 常驻条：刀1 心跳灯 ＋ 刀2 对话轮标尺，共用同一常驻条区域。
 * 落点：总参席 webapp 会话界面，消息流末尾、输入框上方。
 * 高 ≤32px，不遮挡输入框，不影响发送/上传按钮点击区域。
 * 任一刀数据源失败：该刀降级，另一刀照常工作。
 */
export const ResidentBar: FC<{ chatList: ChatItem[] }> = ({ chatList }) => {
  const [hb, setHb] = useState(() => computeHeartbeat())
  const [slowCount, setSlowCount] = useState(() => {
    const c = Number(localStorage.getItem(SLOWDOWN_KEY) || '0')
    return c > 0 ? c : 0
  })

  // 每 30s 轮询心跳，刷新灯态（localStorage 不触发 React 重渲染）
  useEffect(() => {
    const timer = setInterval(() => setHb(computeHeartbeat()), 30000)
    return () => clearInterval(timer)
  }, [])

  // 刀2：N = 本会话已发生的用户回合数（chatList 中 isAnswer=false 的条目数，含本轮）
  const N = chatList.filter((item) => !item.isAnswer).length
  const X = RED_LINE_TURN - N
  // X ≤ 3 时显示为「余量 3」
  const displayX = X <= 3 ? 3 : X

  // 标尺颜色与提示（颜色仅按轮次判：<12正常、≥12橙、≥15红；变慢计数不再影响颜色，仅影响提示文字）
  let rulerColor: 'normal' | 'yellow' | 'red' = 'normal'
  let rulerHint = ''
  if (N >= RED_LINE_TURN) {
    rulerColor = 'red'
    rulerHint = '换新会话，旧会话封存出断点件'
  } else if (N >= YELLOW_LINE_TURN) {
    rulerColor = 'yellow'
    rulerHint = '快该换会话了，把没说完的落到断点件'
  }

  const handleSlowdown = () => {
    const next = slowCount + 1
    setSlowCount(next)
    localStorage.setItem(SLOWDOWN_KEY, String(next))
  }

  // 刀1 交互：点击灯 → 打开施工席界面（新标签页；localStorage 有值则覆盖，空值走默认 OC 看板）
  const handleLightClick = () => {
    const override = localStorage.getItem(SEAT_URL_KEY)?.trim()
    const url = override || DEFAULT_SEAT_URL
    const win = window.open(url, '_blank')
    if (!win) {
      toast.info('施工席界面打开被浏览器拦截，请允许本站弹窗')
    }
  }

  const lightCls = {
    green: 'bg-green-500',
    orange: 'bg-orange-500',
    gray: 'bg-gray-400',
  }[hb.state]

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
      {/* 刀1：施工席心跳灯 */}
      <button
        type="button"
        onClick={handleLightClick}
        className="flex items-center gap-1.5"
        title="点击打开施工席界面"
      >
        <span className={cn('inline-block size-2 shrink-0 rounded-full', lightCls)} />
        <span className="text-text-secondary">施工席：{hb.text}</span>
      </button>

      {/* 刀2：对话轮标尺 */}
      <div className="flex items-center gap-2" title={rulerHint || undefined}>
        <span className={cn('font-medium', rulerCls)}>
          轮次 {N} ｜ 余量 {displayX}
        </span>
        {rulerHint && <span className={rulerCls}>{rulerHint}</span>}
        <button
          type="button"
          onClick={handleSlowdown}
          className="text-text-tertiary underline-offset-2 hover:underline hover:text-text-secondary"
        >
          记一次变慢
        </button>
      </div>
    </div>
  )
}

export default ResidentBar
