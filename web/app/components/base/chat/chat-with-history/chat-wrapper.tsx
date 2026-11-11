import type { FileEntity } from '../../file-uploader/types'
import type { SpeechToTextTarget } from '../../voice-input/types'
import type { ChatConfig, ChatItem, ChatItemInTree } from '../types'
import { Avatar } from '@langgenius/dify-ui/avatar'
import { cn } from '@langgenius/dify-ui/cn'
import { RiArrowDownSLine, RiArrowUpSLine } from '@remixicon/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { trackEvent } from '@/app/components/base/amplitude'
import AnswerIcon from '@/app/components/base/answer-icon'
import AppIcon from '@/app/components/base/app-icon'
import InputsForm from '@/app/components/base/chat/chat-with-history/inputs-form'
import SuggestedQuestions from '@/app/components/base/chat/chat/answer/suggested-questions'
import { Markdown } from '@/app/components/base/markdown'
import { InputVarType } from '@/app/components/workflow/types'
import {
  AppSourceType,
  fetchChatList,
  fetchSuggestedQuestions,
  getUrl,
  stopChatMessageResponding,
  submitHumanInputForm,
} from '@/service/share'
import { submitHumanInputForm as submitHumanInputFormService } from '@/service/workflow'
import { TransferMethod } from '@/types/app'
import { formatBooleanInputs } from '@/utils/model-config'
import Chat from '../chat'
import { useChat } from '../chat/hooks'
import { getInFlightByServerId } from '../chat/in-flight-store'
import {
  adoptSendQueueEntries,
  deserializeFiles,
  markSendQueueEntryFailed,
  peekSendQueueForConversation,
  removeSendQueueEntry,
} from '../chat/mos-send-queue'
import { getLastAnswer, isValidGeneratedAnswer } from '../utils'
import { useChatWithHistoryContext } from './context'

// D6：整页加载后的首次挂载只做一次“空会话 id 条目归位”，此后会话切换不再抢他会话的空 id 条目
let d6BootQueueScanned = false
// D6：整页加载时刻——仅首屏 15s 内允许把刷新前遗留的空 id 条目发到“新会话空白页”
const d6BootAt = Date.now()

const ChatWrapper = () => {
  const { t } = useTranslation()
  const {
    appParams,
    appPrevChatTree,
    currentConversationId,
    currentConversationItem,
    currentConversationInputs,
    inputsForms,
    newConversationInputs,
    newConversationInputsRef,
    handleNewConversationCompleted,
    handleConversationStarted,
    isMobile,
    isInstalledApp,
    appId,
    appMeta,
    handleFeedback,
    currentChatInstanceRef,
    appData,
    theme,
    sidebarCollapseState,
    clearChatList,
    setClearChatList,
    setIsResponding,
    allInputsHidden,
    initUserVariables,
    isNewAgent,
    renderAgentContent,
  } = useChatWithHistoryContext()

  const appSourceType = isInstalledApp ? AppSourceType.installedApp : AppSourceType.webApp
  const timezone =
    appSourceType === AppSourceType.webApp
      ? new Intl.DateTimeFormat().resolvedOptions().timeZone
      : undefined

  // Semantic variable for better code readability
  const isHistoryConversation = !!currentConversationId

  const appConfig = useMemo(() => {
    const config = appParams || {}

    return {
      ...config,
      file_upload: {
        ...(config as any).file_upload,
        fileUploadConfig: (config as any).system_parameters,
      },
      supportFeedback: true,
      opening_statement: currentConversationItem?.introduction || (config as any).opening_statement,
    } as ChatConfig
  }, [appParams, currentConversationItem?.introduction])
  const {
    chatList,
    handleSend,
    handleStop,
    handleDetach,
    handleSwitchSibling,
    prepareHumanInputSubmission,
    isResponding: respondingState,
    suggestedQuestions,
  } = useChat(
    appConfig,
    {
      inputs: (currentConversationId ? currentConversationInputs : newConversationInputs) as any,
      inputsForm: inputsForms,
    },
    appPrevChatTree,
    (taskId) => stopChatMessageResponding('', taskId, appSourceType, appId),
    clearChatList,
    setClearChatList,
    // P-1：传入当前会话 id，使切回托管中的在飞会话时可从全局存储 hydrate
    currentConversationId || undefined,
    { isNewAgent, timezone },
  )
  const inputsFormValue = currentConversationId
    ? currentConversationInputs
    : newConversationInputsRef?.current
  const inputDisabled = useMemo(() => {
    if (allInputsHidden) return false

    let hasEmptyInput = ''
    let fileIsUploading = false
    const requiredVars = inputsForms.filter(
      ({ required, type }) => required && type !== InputVarType.checkbox,
    )
    if (requiredVars.length) {
      requiredVars.forEach(({ variable, label, type }) => {
        if (hasEmptyInput) return

        if (fileIsUploading) return

        if (!inputsFormValue?.[variable]) hasEmptyInput = label as string

        if (
          (type === InputVarType.singleFile || type === InputVarType.multiFiles) &&
          inputsFormValue?.[variable]
        ) {
          const files = inputsFormValue[variable]
          if (Array.isArray(files))
            fileIsUploading = files.find(
              (item) => item.transferMethod === TransferMethod.local_file && !item.uploadedId,
            )
          else
            fileIsUploading =
              files.transferMethod === TransferMethod.local_file && !files.uploadedId
        }
      })
    }
    if (hasEmptyInput) return true

    if (fileIsUploading) return true

    if (
      chatList.some(
        (item) =>
          item.isAnswer && item.humanInputFormDataList && item.humanInputFormDataList.length > 0,
      )
    )
      return true
    return false
  }, [allInputsHidden, inputsForms, chatList, inputsFormValue])

  useEffect(() => {
    if (currentChatInstanceRef.current) {
      currentChatInstanceRef.current.handleStop = handleStop
      // P-1：会话切换时优先 detach（在飞流托管不中断），无在飞流时回退为 stop
      currentChatInstanceRef.current.detach = handleDetach
    }
  }, [])

  useEffect(() => {
    setIsResponding(respondingState)
  }, [respondingState, setIsResponding])

  // Resume paused workflows when chat history is loaded
  useEffect(() => {
    if (!appPrevChatTree || appPrevChatTree.length === 0) return

    // P-1：该会话仍在被旧实例托管（events 订阅由旧实例持有）时，不重复发起 resume 订阅
    if (currentConversationId && getInFlightByServerId(currentConversationId))
      return

    // Find the last answer item with workflow_run_id that needs resumption (DFS - find deepest first)
    let lastPausedNode: ChatItemInTree | undefined
    const findLastPausedWorkflow = (nodes: ChatItemInTree[]) => {
      nodes.forEach((node) => {
        // DFS: recurse to children first
        if (node.children && node.children.length > 0) findLastPausedWorkflow(node.children)

        // Track the last node with humanInputFormDataList
        if (
          node.isAnswer &&
          node.workflow_run_id &&
          node.humanInputFormDataList &&
          node.humanInputFormDataList.length > 0
        )
          lastPausedNode = node
      })
    }

    findLastPausedWorkflow(appPrevChatTree)

    // Only resume the last paused workflow
    if (lastPausedNode) {
      handleSwitchSibling(lastPausedNode.id, {
        onGetSuggestedQuestions: (responseItemId) =>
          fetchSuggestedQuestions(responseItemId, appSourceType, appId),
        onConversationComplete: currentConversationId ? undefined : handleNewConversationCompleted,
        isPublicAPI: appSourceType === AppSourceType.webApp,
      })
    }
  }, [])

  const [hasSent, setHasSent] = useState(false)
  const [prevConversationId, setPrevConversationId] = useState(currentConversationId)
  if (prevConversationId !== currentConversationId) {
    setPrevConversationId(currentConversationId)
    if (!currentConversationId) setHasSent(false)
  }

  // D6：保留 OnSend 调用签名，但把 handleSend 的受理结果（true/false）透出给队列消费
  type QueueSendResult = Promise<boolean> | void
  type QueueSend = (
    message: string,
    files?: FileEntity[],
    isRegenerate?: boolean,
    parentAnswer?: ChatItem | null,
  ) => QueueSendResult
  const doSend: QueueSend = useCallback(
    (message, files, isRegenerate = false, parentAnswer: ChatItem | null = null) => {
      if (!currentConversationId) setHasSent(true)
      const data: any = {
        query: message,
        files,
        inputs: formatBooleanInputs(
          inputsForms,
          currentConversationId ? currentConversationInputs : newConversationInputs,
        ),
        conversation_id: currentConversationId,
        parent_message_id: (isRegenerate ? parentAnswer?.id : getLastAnswer(chatList)?.id) || null,
      }

      const sendResult = handleSend(getUrl('chat-messages', appSourceType, appId || ''), data, {
        onGetConversationMessages: isNewAgent
          ? (conversationId) => fetchChatList(conversationId, appSourceType, appId)
          : undefined,
        onGetSuggestedQuestions: (responseItemId) =>
          fetchSuggestedQuestions(responseItemId, appSourceType, appId),
        onConversationComplete: isHistoryConversation ? undefined : handleNewConversationCompleted,
        // P-1：新会话首条消息拿到 id 时立即登记侧边栏条目
        // D6：同时把本会话“空 conversationId”的排队条目回填为真实 id，避免被其它会话补扫误发
        onConversationStarted: isHistoryConversation
          ? undefined
          : (cid: string) => {
              adoptSendQueueEntries(cid)
              handleConversationStarted(cid)
            },
        isPublicAPI: appSourceType === AppSourceType.webApp,
      })
      const appMode = isNewAgent ? 'agent-v2' : appData?.mode
      if (appSourceType === AppSourceType.webApp && appMode)
        trackEvent('webapp_run', { app_mode: appMode })
      // D6：把 handleSend 的受理结果透出（false＝运行态硬守卫拦截），队列消费据此决定删/留
      return sendResult
    },
    [
      inputsForms,
      currentConversationId,
      currentConversationInputs,
      newConversationInputs,
      chatList,
      handleSend,
      appSourceType,
      appId,
      isHistoryConversation,
      handleNewConversationCompleted,
      handleConversationStarted,
      isNewAgent,
      appData?.mode,
    ],
  )

  // D6：发送队列消费——双触发（响应下降沿 + 可见性恢复/挂载补扫），先确认后删除
  const doSendRef = useRef(doSend)
  const conversationIdRef = useRef(currentConversationId)
  const respondingRef = useRef(respondingState)
  const drainingRef = useRef(false)
  useEffect(() => {
    doSendRef.current = doSend
  }, [doSend])
  useEffect(() => {
    conversationIdRef.current = currentConversationId
  }, [currentConversationId])
  useEffect(() => {
    respondingRef.current = respondingState
  }, [respondingState])
  const drainSendQueue = useCallback((trigger: 'edge' | 'mount' = 'edge') => {
    if (typeof window === 'undefined') return
    const currentId = conversationIdRef.current || ''
    // D6：刷新后 app 尚未恢复会话（空白新会话页）时，允许把刷新前遗留的空 id 条目直接发到新会话（C2），
    // 但不允许把空 id 条目发进其它既有会话（B1 跨会话串发防线）
    const bootFreshSend = trigger === 'mount' && !currentId && Date.now() - d6BootAt < 15000
    // 非首屏且无会话 id：不发——否则会新建一个错误会话
    if (!currentId && !bootFreshSend) return
    // 防重入：运行中（responding）不补发；同一时刻只允许一个 drain 在途
    if (respondingRef.current || drainingRef.current) return
    // P-1 在飞托管：该会话仍有流在跑（含切走后台续跑）时不补发
    if (currentId && getInFlightByServerId(currentId)?.isResponding) return
    const entry = peekSendQueueForConversation(currentId)
    if (!entry) return
    // 挂载/回页补扫只认已回填会话 id 的条目；空 id 条目只由本实例的响应下降沿或首屏空白页消费
    if (!entry.conversationId && trigger === 'mount' && !bootFreshSend) return
    drainingRef.current = true
    // 先占位：doSend 内部 handleSend 会同步置 responding=true，避免同 tick 多触发器重复消费
    respondingRef.current = true
    let result: QueueSendResult
    try {
      result = doSendRef.current(entry.content, deserializeFiles(entry.files))
    }
    catch {
      respondingRef.current = false
      drainingRef.current = false
      markSendQueueEntryFailed(entry)
      return
    }
    // 发送确认成功（handleSend 未被硬守卫拦截）后才移除；失败保留并退避，等下次触发重试
    Promise.resolve(result)
      .then((accepted) => {
        if (accepted === false) {
          respondingRef.current = false
          markSendQueueEntryFailed(entry)
        }
        else {
          removeSendQueueEntry(entry.id || '')
        }
        drainingRef.current = false
      })
      .catch(() => {
        respondingRef.current = false
        drainingRef.current = false
        markSendQueueEntryFailed(entry)
      })
  }, [])

  // 触发一：当前流完成后 1s 按序自动发出排队消息（保留刀5原语义）
  const prevRespondingRef = useRef(respondingState)
  useEffect(() => {
    const wasResponding = prevRespondingRef.current
    prevRespondingRef.current = respondingState
    respondingRef.current = respondingState
    if (!wasResponding || respondingState) return
    const timer = setTimeout(() => {
      drainSendQueue()
    }, 1000)
    return () => clearTimeout(timer)
  }, [respondingState, drainSendQueue])

  // 触发二：挂载补扫（刷新/remount 后无下降沿）+ 可见性恢复补扫；responding 中由 drain 内部拦截
  useEffect(() => {
    const boot = !d6BootQueueScanned
    d6BootQueueScanned = true
    const currentId = conversationIdRef.current || ''
    // 刷新/首次加载：把“新会话首包前入队”的空 id 条目归到当前恢复的会话（C2 场景）
    if (boot && currentId) adoptSendQueueEntries(currentId)
    const mountTimer = setTimeout(() => {
      drainSendQueue('mount')
    }, 800)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') drainSendQueue('mount')
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      clearTimeout(mountTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [drainSendQueue])

  const doRegenerate = useCallback(
    (chatItem: ChatItem, editedQuestion?: { message: string; files?: FileEntity[] }) => {
      const question = editedQuestion
        ? chatItem
        : chatList.find((item) => item.id === chatItem.parentMessageId)!
      const parentAnswer = chatList.find((item) => item.id === question.parentMessageId)
      doSend(
        editedQuestion ? editedQuestion.message : question.content,
        editedQuestion ? editedQuestion.files : question.message_files,
        true,
        isValidGeneratedAnswer(parentAnswer) ? parentAnswer : null,
      )
    },
    [chatList, doSend],
  )

  const doSwitchSibling = useCallback(
    (siblingMessageId: string) => {
      handleSwitchSibling(siblingMessageId, {
        onGetSuggestedQuestions: (responseItemId) =>
          fetchSuggestedQuestions(responseItemId, appSourceType, appId),
        onConversationComplete: currentConversationId ? undefined : handleNewConversationCompleted,
        isPublicAPI: appSourceType === AppSourceType.webApp,
      })
    },
    [
      handleSwitchSibling,
      currentConversationId,
      handleNewConversationCompleted,
      appSourceType,
      appId,
    ],
  )

  const messageList = useMemo(() => {
    if (currentConversationId || chatList.length > 1) return chatList
    // Without messages we are in the welcome screen, so hide the opening statement from chatlist
    return chatList.filter((item) => !item.isOpeningStatement)
  }, [chatList, currentConversationId])

  const handleSubmitHumanInputForm = useCallback(
    async (formToken: string, formData: any) => {
      if (!(await prepareHumanInputSubmission())) return

      if (isInstalledApp) await submitHumanInputFormService(formToken, formData)
      else await submitHumanInputForm(formToken, formData)
    },
    [isInstalledApp, prepareHumanInputSubmission],
  )

  const [collapsed, setCollapsed] = useState(!!currentConversationId)
  const [descExpanded, setDescExpanded] = useState(false)

  const description = appData?.site.description
  const [showDescToggle, setShowDescToggle] = useState(false)
  const handleDescRef = useCallback((node: HTMLDivElement | null) => {
    setShowDescToggle(!!node && node.scrollHeight > node.clientHeight)
  }, [])

  const descriptionNode = useMemo(() => {
    if (!description || currentConversationId || hasSent) return null
    return (
      <div className={cn('flex flex-col items-center px-4 pt-6', isMobile && 'pt-4')}>
        <div className="w-full max-w-2xl rounded-2xl border-[0.5px] border-components-panel-border bg-components-panel-bg shadow-md">
          <div className={cn('p-6', isMobile && 'p-4')}>
            <div
              ref={handleDescRef}
              className={cn(
                'relative system-xs-regular wrap-break-word whitespace-pre-wrap text-text-tertiary',
                !descExpanded && 'line-clamp-3',
                descExpanded && 'max-h-32 overflow-y-auto',
              )}
            >
              {description}
              {!descExpanded && showDescToggle && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-b from-components-panel-bg-transparent to-components-panel-bg" />
              )}
            </div>
            {showDescToggle && (
              <button
                type="button"
                className="mt-0.5 flex items-center gap-0.5 system-xs-regular text-text-accent hover:opacity-80"
                onClick={() => setDescExpanded((v) => !v)}
              >
                {descExpanded ? (
                  <>
                    <RiArrowUpSLine className="size-3" />
                    {t(($) => $['chat.collapse'], { ns: 'share' })}
                  </>
                ) : (
                  <>
                    <RiArrowDownSLine className="size-3" />
                    {t(($) => $['chat.expand'], { ns: 'share' })}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }, [description, isMobile, currentConversationId, hasSent, descExpanded, showDescToggle, t])

  const chatNode = useMemo(() => {
    if (allInputsHidden || !inputsForms.length) return null
    if (isMobile) {
      if (!currentConversationId)
        return <InputsForm collapsed={collapsed} setCollapsed={setCollapsed} />
      return null
    } else {
      return <InputsForm collapsed={collapsed} setCollapsed={setCollapsed} />
    }
  }, [inputsForms.length, isMobile, currentConversationId, collapsed, allInputsHidden])

  const welcome = useMemo(() => {
    const welcomeMessage = chatList.find((item) => item.isOpeningStatement)
    if (respondingState) return null
    if (currentConversationId) return null
    if (!welcomeMessage) return null
    if (!collapsed && inputsForms.length > 0 && !allInputsHidden) return null
    if (welcomeMessage.suggestedQuestions && welcomeMessage.suggestedQuestions?.length > 0) {
      return (
        <div className="flex min-h-[50vh] items-center justify-center px-4 py-12">
          <div className="flex max-w-180 grow gap-4">
            <AppIcon
              size="xl"
              iconType={appData?.site.icon_type}
              icon={appData?.site.icon}
              background={appData?.site.icon_background}
              imageUrl={appData?.site.icon_url}
            />
            <div className="w-0 grow">
              <div className="grow rounded-2xl bg-chat-bubble-bg px-4 py-3 body-lg-regular text-text-primary">
                <Markdown content={welcomeMessage.content} />
                <SuggestedQuestions item={welcomeMessage} />
              </div>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className={cn('flex min-h-[50vh] flex-col items-center justify-center gap-3 py-12')}>
        <AppIcon
          size="xl"
          iconType={appData?.site.icon_type}
          icon={appData?.site.icon}
          background={appData?.site.icon_background}
          imageUrl={appData?.site.icon_url}
        />
        <div className="max-w-3xl px-4">
          <Markdown
            className="body-2xl-regular! text-text-tertiary!"
            content={welcomeMessage.content}
          />
        </div>
      </div>
    )
  }, [
    appData?.site.icon,
    appData?.site.icon_background,
    appData?.site.icon_type,
    appData?.site.icon_url,
    chatList,
    collapsed,
    currentConversationId,
    inputsForms.length,
    respondingState,
    allInputsHidden,
  ])

  const answerIcon =
    appData?.site && appData.site.use_icon_as_answer_icon ? (
      <AnswerIcon
        iconType={appData.site.icon_type}
        icon={appData.site.icon}
        background={appData.site.icon_background}
        imageUrl={appData.site.icon_url}
      />
    ) : null
  const speechToTextTarget: SpeechToTextTarget | undefined =
    appSourceType === AppSourceType.webApp
      ? { type: 'app' as const, appSourceType: AppSourceType.webApp }
      : appId
        ? { type: 'app' as const, appId, appSourceType }
        : undefined

  return (
    <div className="h-full overflow-hidden bg-chatbot-bg">
      <Chat
        appData={appData ?? undefined}
        config={appConfig}
        speechToTextTarget={speechToTextTarget}
        chatList={messageList}
        isResponding={respondingState}
        chatContainerInnerClassName={`mx-auto pt-6 w-full max-w-[768px] ${isMobile ? 'px-4' : ''}`}
        chatFooterClassName="pb-4"
        chatFooterInnerClassName={`mx-auto w-full max-w-[768px] ${isMobile ? 'px-2' : 'px-4'}`}
        onSend={doSend}
        inputs={currentConversationId ? (currentConversationInputs as any) : newConversationInputs}
        inputsForm={inputsForms}
        onRegenerate={doRegenerate}
        onStopResponding={handleStop}
        onHumanInputFormSubmit={handleSubmitHumanInputForm}
        chatNode={
          <>
            {descriptionNode}
            {chatNode}
            {welcome}
          </>
        }
        allToolIcons={appMeta?.tool_icons || {}}
        onFeedback={handleFeedback}
        suggestedQuestions={suggestedQuestions}
        answerIcon={answerIcon}
        hideProcessDetail
        theme={theme}
        switchSibling={doSwitchSibling}
        inputDisabled={inputDisabled}
        sidebarCollapseState={sidebarCollapseState}
        showScrollToBottomButton
        renderAgentContent={renderAgentContent}
        questionIcon={
          initUserVariables?.avatar_url ? (
            <Avatar
              avatar={initUserVariables.avatar_url}
              name={initUserVariables.name || 'user'}
              size="xl"
            />
          ) : undefined
        }
      />
    </div>
  )
}

export default ChatWrapper
