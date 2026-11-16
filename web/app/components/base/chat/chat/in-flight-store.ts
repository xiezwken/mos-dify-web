/**
 * In-flight chat store (MOS web patch P-1, batch 20261016)
 *
 * 当用户在流式响应进行中切走会话时，ChatWrapper 会按 key 整体卸载，useChat 实例
 * 随之销毁。历史实现会在切换瞬间调用 handleStop()：中止全部 SSE 连接并通知后端
 * 停止任务，导致切走会话的思考/回答全部丢失。
 *
 * 本模块是一个与 React 生命周期解耦的模块级单例：被切走的在飞会话以
 * conversationId 为键托管在这里，旧 useChat 实例中的 SSE 回调（闭包仍存活）
 * 持续把最新消息树写入本存储；切回该会话时，新 useChat 实例从这里 hydrate
 * 并订阅后续更新，直至流完成。
 *
 * 存储仅在内存中保留，页面刷新后自然失效（后端历史消息会重新拉取）。
 */
import type { ChatItemInTree } from '../types'

export type InFlightChat = {
  /** 本地发送键，新会话首包前尚无 serverConversationId 时使用，如 send:questionId / resume:workflowRunId */
  localKey: string
  /** 后端会话 id，首包返回后回填；历史会话内发起的请求创建时即已知 */
  serverConversationId: string
  /** 实时消息树（与 useChat 内部 chatTree 同构） */
  chatTree: ChatItemInTree[]
  /** 流是否仍在进行 */
  isResponding: boolean
  /** 完成后拉到的推荐问题（切回时一并回放） */
  suggestedQuestions?: string[]
  startedAt: number
  completedAt?: number
  /** 旧实例注册的停止句柄：切回后点停止按钮可中止被托管的流 */
  stop?: () => void
}

const inflight = new Map<string, InFlightChat>()
const serverIdIndex = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()
const gcTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 完成后保留时长（ms），超时回收；期间切回仍可看到最终消息树 */
const GC_DELAY = 10 * 60 * 1000

function notify(localKey: string) {
  listeners.get(localKey)?.forEach((listener) => {
    try {
      listener()
    }
    catch {
      // 订阅方异常不影响写流
    }
  })
}

function clearGcTimer(localKey: string) {
  const timer = gcTimers.get(localKey)
  if (timer) {
    clearTimeout(timer)
    gcTimers.delete(localKey)
  }
}

function scheduleGc(localKey: string) {
  clearGcTimer(localKey)
  const timer = setTimeout(() => {
    removeInFlight(localKey)
  }, GC_DELAY)
  gcTimers.set(localKey, timer)
}

export function createInFlight(
  localKey: string,
  serverConversationId: string,
  chatTree: ChatItemInTree[],
): InFlightChat {
  const chat: InFlightChat = {
    localKey,
    serverConversationId,
    chatTree,
    isResponding: true,
    startedAt: Date.now(),
  }
  inflight.set(localKey, chat)
  if (serverConversationId)
    serverIdIndex.set(serverConversationId, localKey)
  notify(localKey)
  return chat
}

export function bindInFlightServerId(localKey: string, serverConversationId: string) {
  const chat = inflight.get(localKey)
  if (!chat || !serverConversationId)
    return
  chat.serverConversationId = serverConversationId
  serverIdIndex.set(serverConversationId, localKey)
  notify(localKey)
}

export function saveInFlightTree(localKey: string, chatTree: ChatItemInTree[]) {
  const chat = inflight.get(localKey)
  if (!chat)
    return
  chat.chatTree = chatTree
  notify(localKey)
}

export function setInFlightResponding(localKey: string, isResponding: boolean) {
  const chat = inflight.get(localKey)
  if (!chat)
    return
  chat.isResponding = isResponding
  if (isResponding) {
    // 暂停工作流恢复时取消待回收
    chat.completedAt = undefined
    clearGcTimer(localKey)
  } else {
    chat.completedAt = Date.now()
    scheduleGc(localKey)
  }
  notify(localKey)
}

export function setInFlightStop(localKey: string, stop: () => void) {
  const chat = inflight.get(localKey)
  if (!chat)
    return
  chat.stop = stop
}

export function setInFlightSuggestedQuestions(localKey: string, suggestedQuestions: string[]) {
  const chat = inflight.get(localKey)
  if (!chat)
    return
  chat.suggestedQuestions = suggestedQuestions
  notify(localKey)
}

export function getInFlightByLocalKey(localKey: string): InFlightChat | undefined {
  return inflight.get(localKey)
}

export function getInFlightByServerId(serverConversationId: string): InFlightChat | undefined {
  if (!serverConversationId)
    return undefined
  const localKey = serverIdIndex.get(serverConversationId)
  return localKey ? inflight.get(localKey) : undefined
}

/** 订阅指定会话的更新，返回取消订阅函数；按 serverConversationId 定位 */
export function subscribeInFlightByServerId(
  serverConversationId: string,
  listener: () => void,
): () => void {
  const localKey = serverIdIndex.get(serverConversationId)
  if (!localKey)
    return () => {}
  let set = listeners.get(localKey)
  if (!set) {
    set = new Set()
    listeners.set(localKey, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
  }
}

export function removeInFlight(localKey: string) {
  const chat = inflight.get(localKey)
  clearGcTimer(localKey)
  if (chat?.serverConversationId && serverIdIndex.get(chat.serverConversationId) === localKey)
    serverIdIndex.delete(chat.serverConversationId)
  inflight.delete(localKey)
  listeners.delete(localKey)
}
