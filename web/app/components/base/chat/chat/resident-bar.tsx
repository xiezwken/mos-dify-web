import type { FC } from 'react'
import type { ChatItem } from '../types'
import { cn } from '@langgenius/dify-ui/cn'

// ===== 刀2 对话轮标尺（挂账 P-01 定稿口径，本令零改动）=====
// 阈值只从规格取值：12／70%／15／2 次
const RED_LINE_TURN = 15 // 红线轮次
const YELLOW_LINE_TURN = 12 // 黄线轮次

/**
 * 常驻条（刀2 对话轮标尺）。
 * LAMP-V13-20261118-F：原「刀1 施工席心跳灯」旧条已摘除（接线行删除，改由 seat-heartbeat-lamp.tsx 单一灯条承担）；
 * 旧条组件逻辑（8088 /运行时/heartbeat.json 轮询、一点一灯三色）随渲染一并移除，避免重复行与双数据源。
 * 落点：总参席 webapp 会话界面，消息流末尾、输入框上方；高 ≤32px，不遮挡输入框与发送/上传按钮。
 */
export const ResidentBar: FC<{ chatList: ChatItem[] }> = ({ chatList }) => {
  // 刀2：N = 本会话已发生的用户回合数（chatList 中 isAnswer=false 的条目数，含本轮）
  const N = chatList.filter((item) => !item.isAnswer).length
  const X = RED_LINE_TURN - N // 余量取真实值：黄灯显示实际余量（3/2/1），红灯落 0

  const displayX = Math.max(0, X)

  // 标尺颜色与提示（零改动，换血阈值口径）
  let rulerColor: 'normal' | 'yellow' | 'red' = 'normal'
  let rulerHint = ''
  if (N >= RED_LINE_TURN) {
    rulerColor = 'red'
    rulerHint = '换新会话，旧会话封存出断点件'
  }
  else if (N >= YELLOW_LINE_TURN) {
    rulerColor = 'yellow'
    rulerHint = '快该换会话了，把没说完的落到断点件'
  }

  const rulerCls = {
    normal: 'text-text-secondary',
    yellow: 'text-amber-500',
    red: 'text-red-500',
  }[rulerColor]

  return (
    <div
      data-testid="mos-resident-bar"
      className="pointer-events-auto flex h-8 select-none items-center justify-end gap-3 px-4 text-xs"
    >
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
