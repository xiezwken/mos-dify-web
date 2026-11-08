import type { FileEntity } from '../../file-uploader/types'
import { TransferMethod } from '@/types/app'

const QUEUE_KEY = 'mos_send_queue'

export type SerializedFile = {
  fileId: string
  id: string
  name: string
  size: number
  type: string
  supportFileType: string
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
  }))

export const deserializeFiles = (files: SerializedFile[]): FileEntity[] =>
  files.map(file => ({
    id: file.id || file.fileId,
    name: file.name,
    size: file.size,
    type: file.type,
    progress: 100,
    transferMethod: TransferMethod.remote_file,
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
  return entry
}

export const clearSendQueue = (): number => {
  const count = readSendQueue().length
  writeSendQueue([])
  return count
}
