import type { FileEntity } from '../../file-uploader/types'
import { TransferMethod } from '@/types/app'

const QUEUE_KEY = 'mos_send_queue'
export const MOS_SEND_QUEUE_EVENT = 'mos-send-queue-change'

export type SerializedFile = {
  fileId: string
  id: string
  name: string
  size: number
  type: string
  supportFileType: string
}

export type SendQueueEntry = {
  /** 队列条目唯一 id：发送确认成功后才按 id 删除，失败保留重试（D6） */
  id?: string
  content: string
  files: SerializedFile[]
  conversationId: string
  /** 发送尝试次数（D6：仅用于失败退避与观测） */
  attempts?: number
  /** 失败退避截止时刻（ms）；未到期不参与补扫，等下一次触发重试（D6） */
  retryAfter?: number
}

export const serializeFiles = (files: FileEntity[]): SerializedFile[] =>
  files.map(file => ({
    fileId: file.uploadedId || file.id,
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    supportFileType: file.supportFileType || '',
  }))

export const deserializeFiles = (files: SerializedFile[]): FileEntity[] =>
  files.map(file => ({
    id: file.id || file.fileId,
    name: file.name,
    size: file.size,
    type: file.type,
    progress: 100,
    transferMethod: TransferMethod.local_file,
    supportFileType: file.supportFileType || '',
    uploadedId: file.fileId,
  }))

export const readSendQueue = (): SendQueueEntry[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      item => item && typeof item.content === 'string' && Array.isArray(item.files),
    ) as SendQueueEntry[]
  }
  catch {
    return []
  }
}

const writeSendQueue = (queue: SendQueueEntry[]) => {
  if (typeof window === 'undefined') return
  try {
    if (queue.length === 0) window.localStorage.removeItem(QUEUE_KEY)
    else window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  }
  catch {
    // 本地存储不可用时静默降级，不阻断发送
  }
  window.dispatchEvent(new CustomEvent(MOS_SEND_QUEUE_EVENT))
}

const matchesConversation = (entry: SendQueueEntry, conversationId: string) =>
  entry.conversationId === (conversationId || '') || entry.conversationId === ''

export const readSendQueueForConversation = (conversationId: string): SendQueueEntry[] =>
  readSendQueue().filter(entry => matchesConversation(entry, conversationId))

// 刀5b：按当前会话过滤后的局部序号删除单条（其余会话条目不动）
export const removeSendQueueItemForConversation = (
  conversationId: string,
  localIndex: number,
): SendQueueEntry[] => {
  const queue = readSendQueue()
  const current = conversationId || ''
  const globalIndexes: number[] = []
  queue.forEach((entry, index) => {
    if (matchesConversation(entry, current)) globalIndexes.push(index)
  })
  const globalIndex = globalIndexes[localIndex]
  if (globalIndex !== undefined && globalIndex >= 0) {
    queue.splice(globalIndex, 1)
    writeSendQueue(queue)
  }
  return queue.filter(entry => matchesConversation(entry, current))
}

export const clearSendQueueForConversation = (conversationId: string): number => {
  const current = conversationId || ''
  const queue = readSendQueue()
  const remaining = queue.filter(entry => !matchesConversation(entry, current))
  const cleared = queue.length - remaining.length
  if (cleared > 0) writeSendQueue(remaining)
  return cleared
}

const createSendQueueEntryId = () =>
  `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const enqueueSend = (entry: SendQueueEntry): SendQueueEntry[] => {
  const queue = readSendQueue()
  queue.push({ ...entry, id: entry.id || createSendQueueEntryId() })
  writeSendQueue(queue)
  return queue
}

/**
 * D6：只读取不删除——发送确认成功后才由 removeSendQueueEntry 删除。
 * 失败退避期（retryAfter 未到）内的条目跳过，等下一次触发重试。
 */
export const peekSendQueueForConversation = (conversationId: string): SendQueueEntry | null => {
  const queue = readSendQueue()
  if (!queue.length) return null
  const current = conversationId || ''
  const now = Date.now()
  const index = queue.findIndex(
    item =>
      (item.conversationId === current || item.conversationId === '')
      && (!item.retryAfter || item.retryAfter <= now),
  )
  if (index < 0) return null
  const entry = queue[index]
  // 兼容刀5旧条目（无 id）：首次取用时补写 id，后续才能安全按 id 删除
  if (!entry) return null
  if (!entry.id) {
    entry.id = createSendQueueEntryId()
    writeSendQueue(queue)
  }
  return entry
}

/** D6：发送确认成功后按 id 移除队列项 */
export const removeSendQueueEntry = (entryId: string): boolean => {
  if (!entryId) return false
  const queue = readSendQueue()
  const remaining = queue.filter(entry => entry.id !== entryId)
  if (remaining.length === queue.length) return false
  writeSendQueue(remaining)
  return true
}

/**
 * D6：发送失败时保留条目并写入退避时间，避免失败即丢、也避免立刻重试成环。
 * 条目已被移除（发送中途异常）时按原内容补回队首。
 */
export const markSendQueueEntryFailed = (
  entry: SendQueueEntry,
  retryDelayMs = 5000,
): void => {
  const queue = readSendQueue()
  const retryAfter = Date.now() + retryDelayMs
  const index = entry.id ? queue.findIndex(item => item.id === entry.id) : -1
  if (index >= 0) {
    const current = queue[index]
    if (current) {
      queue[index] = {
        ...current,
        attempts: (current.attempts || 0) + 1,
        retryAfter,
      }
    }
  }
  else {
    queue.unshift({
      ...entry,
      id: entry.id || createSendQueueEntryId(),
      attempts: (entry.attempts || 0) + 1,
      retryAfter,
    })
  }
  writeSendQueue(queue)
}

export const dequeueForConversation = (conversationId: string): SendQueueEntry | null => {
  const entry = peekSendQueueForConversation(conversationId)
  if (!entry) return null
  removeSendQueueEntry(entry.id || '')
  return entry
}

export const clearSendQueue = (): number => {
  const count = readSendQueue().length
  writeSendQueue([])
  return count
}
