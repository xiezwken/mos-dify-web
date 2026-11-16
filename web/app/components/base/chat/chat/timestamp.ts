/**
 * Local message timestamp helpers (MOS web patch P-3, batch 20261016).
 *
 * 每条消息头部渲染固定格式的本地时间：YYYY-MM-DD HH:MM。
 * 不使用带时区后缀（+08:00 / GMT）的格式，因为消息按浏览器本地时区渲染。
 */

const pad = (value: number) => String(value).padStart(2, '0')

/** 毫秒时间戳 -> 本地时区 YYYY-MM-DD HH:MM */
export const formatLocalDateTime = (ms: number): string => {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime()))
    return ''

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

/** 后端秒级 Unix 时间戳 -> 毫秒 */
export const serverCreatedAtToMs = (createdAt?: number): number | undefined => {
  if (typeof createdAt !== 'number' || !createdAt)
    return undefined
  return createdAt * 1000
}
