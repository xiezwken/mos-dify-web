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
  /** 刀5d：随队列落盘的传输方式；旧条目缺省按本地文件处理 */
  transferMethod?: TransferMethod
  /** 刀5d：远程文件地址，仅 remote_url 需要 */
  url?: string
}

export type SendQueueEntry = {
  content: string
  files: SerializedFile[]
  conversationId: string
}

export const serializeFiles = (files: FileEntity[]): SerializedFile[] =>
  files.map(file => ({
    fileId: file.uploadedId || file.id,
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type,
    supportFileType: file.supportFileType || '',
    transferMethod: file.transferMethod,
    url: file.url || '',
  }))

// 刀5d：附件随行。此前误用不存在的 TransferMethod.remote_file，
// 序列化后 transfer_method 变为 undefined，后端拒绝接收附件。
export const deserializeFiles = (files: SerializedFile[]): FileEntity[] =>
  files.map((file) => {
    const transferMethod = file.transferMethod === TransferMethod.remote_url
      ? TransferMethod.remote_url
      : TransferMethod.local_file
    return {
      id: file.id || file.fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      progress: 100,
      transferMethod,
      supportFileType: file.supportFileType || '',
      uploadedId: transferMethod === TransferMethod.local_file ? file.fileId : undefined,
      url: transferMethod === TransferMethod.remote_url ? (file.url || '') : '',
    }
  })

/** 刀5d：出队重发前确认附件仍可发送（本地文件需 fileId，远程文件需 url） */
export const isSerializedFileSendable = (file: SerializedFile): boolean =>
  file.transferMethod === TransferMethod.remote_url ? !!file.url : !!file.fileId

export const getUnsendableFiles = (files: SerializedFile[]): SerializedFile[] =>
  files.filter(file => !isSerializedFileSendable(file))

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

export const enqueueSend = (entry: SendQueueEntry): SendQueueEntry[] => {
  const queue = readSendQueue()
  queue.push(entry)
  writeSendQueue(queue)
  return queue
}

export const dequeueForConversation = (conversationId: string): SendQueueEntry | null => {
  const queue = readSendQueue()
  if (!queue.length) return null
  const current = conversationId || ''
  const index = queue.findIndex(item => item.conversationId === current || item.conversationId === '')
  if (index < 0) return null
  const [entry] = queue.splice(index, 1)
  writeSendQueue(queue)
  return entry ?? null
}

export const clearSendQueue = (): number => {
  const count = readSendQueue().length
  writeSendQueue([])
  return count
}
