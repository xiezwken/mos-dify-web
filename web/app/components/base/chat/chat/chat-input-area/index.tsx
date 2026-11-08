import type { ReactNode } from 'react'
import type { Theme } from '../../embedded-chatbot/theme/theme'
import type { EnableType, OnSend } from '../../types'
import type { InputForm } from '../type'
import type { FileUpload } from '@/app/components/base/features/types'
import type { SpeechToTextTarget } from '@/app/components/base/voice-input/types'
import { cn } from '@langgenius/dify-ui/cn'
import { toast } from '@langgenius/dify-ui/toast'
import { noop } from 'es-toolkit/function'
import { decode } from 'html-entities'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Textarea from 'react-textarea-autosize'
import FeatureBar from '@/app/components/base/features/new-feature-panel/feature-bar'
import { FileListInChatInput } from '@/app/components/base/file-uploader'
import { useFile } from '@/app/components/base/file-uploader/hooks'
import { FileContextProvider, useFileStore } from '@/app/components/base/file-uploader/store'
import { Infotip } from '@/app/components/base/infotip'
import VoiceInput from '@/app/components/base/voice-input'
import { TransferMethod } from '@/types/app'
import { useCheckInputsForms } from '../check-input-forms-hooks'
import {
  clearSendQueueForConversation,
  deserializeFiles,
  enqueueSend,
  MOS_SEND_QUEUE_EVENT,
  readSendQueueForConversation,
  removeSendQueueItemForConversation,
  serializeFiles,
  type SendQueueEntry,
} from '../mos-send-queue'
import { useTextAreaHeight } from './hooks'
import Operation from './operation'

type SendAcceptance = void | boolean | Promise<void | boolean>

// 刀5c：队列摘要渲染——URL 开头显示为「链接×N：/<路径尾段>…」，普通文本维持前 20 字
function summarizeQueueContent(content: string) {
  const text = (content || '').trim()
  if (/^https?:\/\//i.test(text)) {
    const urls = text.match(/https?:\/\/[^\s]+/gi) || []
    const count = Math.max(urls.length, 1)
    let tail = ''
    try {
      const parsed = new URL(urls[0])
      tail = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : `/${parsed.hostname}`
    }
    catch {
      tail = ''
    }
    if (tail.length > 60) tail = `${tail.slice(0, 60)}…`
    return { label: `链接×${count}：${tail}…`, isLink: true }
  }
  return { label: text.length > 20 ? `${text.slice(0, 20)}…` : text, isLink: false }
}

function isMicrophonePermissionDenied(error: unknown) {
  return error instanceof DOMException && error.name === 'NotAllowedError'
}

type ChatInputAreaProps = {
  readonly?: boolean
  botName?: string
  customPlaceholder?: string
  showFeatureBar?: boolean
  showFileUpload?: boolean
  featureBarReadonly?: boolean
  featureBarDisabled?: boolean
  onFeatureBarClick?: (state: boolean) => void
  visionConfig?: FileUpload
  speechToTextConfig?: EnableType
  speechToTextTarget?: SpeechToTextTarget
  onBeforeSpeechToText?: () => Promise<unknown>
  onSend?: OnSend
  inputs?: Record<string, unknown>
  inputsForm?: InputForm[]
  theme?: Theme | null
  isResponding?: boolean
  conversationId?: string
  disabled?: boolean
  sendButtonLabel?: string
  sendButtonLoading?: boolean
  footerNotice?: ReactNode
  footerNoticeTooltip?: ReactNode
  autoFocus?: boolean
  /**
   * Controls whether pressing Enter sends the message.
   * - true (default): Enter sends, Shift+Enter inserts newline
   * - false: Enter inserts newline, Shift+Enter sends
   * Useful for CJK (Japanese/Korean/Chinese) IME users who expect Enter to insert newlines.
   */
  sendOnEnter?: boolean
}
const ChatInputArea = ({
  readonly,
  botName,
  customPlaceholder,
  showFeatureBar,
  showFileUpload,
  featureBarReadonly = readonly,
  featureBarDisabled,
  onFeatureBarClick,
  visionConfig,
  speechToTextConfig = { enabled: true },
  speechToTextTarget,
  onBeforeSpeechToText,
  onSend,
  inputs = {},
  inputsForm = [],
  theme,
  isResponding,
  conversationId,
  disabled,
  sendButtonLabel,
  sendButtonLoading,
  footerNotice,
  footerNoticeTooltip,
  autoFocus = true,
  sendOnEnter = true,
}: ChatInputAreaProps) => {
  const { t } = useTranslation()
  const {
    wrapperRef,
    textareaRef,
    textValueRef,
    holdSpaceRef,
    handleTextareaResize,
    isMultipleLine,
  } = useTextAreaHeight()
  const [query, setQuery] = useState('')
  const canSend = !!query.trim()
  const [showVoiceInput, setShowVoiceInput] = useState(false)
  const filesStore = useFileStore()
  const {
    handleDragFileEnter,
    handleDragFileLeave,
    handleDragFileOver,
    handleDropFile,
    handleClipboardPasteFile,
    isDragActive,
  } = useFile(visionConfig!, false)
  const { checkInputsForm } = useCheckInputsForms()
  const historyRef = useRef([''])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const isComposingRef = useRef(false)
  const queryRef = useRef('')
  const voiceInputRef = useRef<HTMLDivElement>(null)
  const voiceInputReturnFocusRef = useRef<HTMLElement | null>(null)
  // 刀5b：当前会话排队条目（仅用于输入框上方队列条展示）
  const [queuedItems, setQueuedItems] = useState<SendQueueEntry[]>([])
  // 刀5c：点击摘要就地展开全文；键用条目内容，删除其它条目不影响展开态
  const [expandedQueueItem, setExpandedQueueItem] = useState<string | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setExpandedQueueItem(null)
    const syncQueue = () => setQueuedItems(readSendQueueForConversation(conversationId || ''))
    syncQueue()
    window.addEventListener(MOS_SEND_QUEUE_EVENT, syncQueue)
    window.addEventListener('storage', syncQueue)
    return () => {
      window.removeEventListener(MOS_SEND_QUEUE_EVENT, syncQueue)
      window.removeEventListener('storage', syncQueue)
    }
  }, [conversationId])
  const handleRemoveQueuedItem = (index: number) => {
    setQueuedItems(removeSendQueueItemForConversation(conversationId || '', index))
  }
  const handleClearQueuedItems = () => {
    clearSendQueueForConversation(conversationId || '')
    setQueuedItems(readSendQueueForConversation(conversationId || ''))
  }
  const voiceInputCompletedRef = useRef(false)
  // 刀4：未发送草稿按会话持久化（新会话未注册前用 mos_draft_new）
  const draftKey = `mos_draft_${conversationId || 'new'}`
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const persistDraft = useCallback(() => {
    if (typeof window === 'undefined') return
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    const text = queryRef.current
    const files = filesStore.getState().files
    if (!text.trim() && files.length === 0) {
      window.localStorage.removeItem(draftKey)
      return
    }
    try {
      window.localStorage.setItem(
        draftKey,
        JSON.stringify({ text, files: serializeFiles(files), savedAt: Date.now() }),
      )
    }
    catch {
      // 存储不可用时静默降级
    }
  }, [draftKey, filesStore])
  const schedulePersistDraft = useCallback(() => {
    if (typeof window === 'undefined') return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(persistDraft, 500)
  }, [persistDraft])
  const clearDraft = useCallback(() => {
    if (typeof window === 'undefined') return
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    window.localStorage.removeItem(draftKey)
  }, [draftKey])
  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.localStorage.getItem(draftKey)
    if (raw) {
      try {
        const draft = JSON.parse(raw)
        if (!queryRef.current && filesStore.getState().files.length === 0) {
          if (typeof draft?.text === 'string' && draft.text) {
            queryRef.current = draft.text
            setQuery(draft.text)
            setTimeout(handleTextareaResize, 0)
          }
          if (Array.isArray(draft?.files) && draft.files.length)
            filesStore.getState().setFiles(deserializeFiles(draft.files))
        }
      }
      catch {
        // 草稿损坏时直接忽略
      }
    }
    // 切换会话/卸载前落盘（刀4 写入点二）
    return persistDraft
  }, [draftKey, filesStore, handleTextareaResize, persistDraft])
  useEffect(() => {
    const unsubscribe = filesStore.subscribe(schedulePersistDraft)
    return unsubscribe
  }, [filesStore, schedulePersistDraft])
  useEffect(() => {
    const handleBeforeUnload = () => persistDraft()
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [persistDraft])
  const handleQueryChange = useCallback(
    (value: string) => {
      queryRef.current = value
      setQuery(value)
      setTimeout(handleTextareaResize, 0)
      schedulePersistDraft()
    },
    [handleTextareaResize, schedulePersistDraft],
  )
  const resetAcceptedMessage = useCallback(
    (acceptedQuery: string, acceptedFiles: ReturnType<typeof filesStore.getState>['files']) => {
      const { files, setFiles } = filesStore.getState()
      if (queryRef.current === acceptedQuery) handleQueryChange('')
      if (files === acceptedFiles) setFiles([])
      // 刀4：消息发出后清除该会话草稿
      clearDraft()
    },
    [filesStore, handleQueryChange, clearDraft],
  )
  const handleSend = () => {
    if (!canSend) return

    if (onSend) {
      const { files } = filesStore.getState()
      if (
        files.some((item) => item.transferMethod === TransferMethod.local_file && !item.uploadedId)
      ) {
        toast.info(t(($) => $['errorMessage.waitForFileUpload'], { ns: 'appDebug' }))
        return
      }
      if (!checkInputsForm(inputs, inputsForm)) return
      // 刀5：在飞时点发送改为入队，不再拦截
      if (isResponding) {
        enqueueSend({
          content: query,
          files: serializeFiles(files),
          conversationId: conversationId || '',
        })
        toast.info('已排队，回复完成后自动发送')
        handleQueryChange('')
        filesStore.getState().setFiles([])
        clearDraft()
        return
      }
      const sendResult = onSend(query, files) as SendAcceptance
      if (sendResult instanceof Promise) {
        sendResult
          .then((accepted) => {
            if (accepted !== false) resetAcceptedMessage(query, files)
          })
          .catch(noop)
        return
      }

      if (sendResult !== false) resetAcceptedMessage(query, files)
    }
  }
  const handleCompositionStart = () => {
    // e: React.CompositionEvent<HTMLTextAreaElement>
    isComposingRef.current = true
  }
  const handleCompositionEnd = () => {
    // safari or some browsers will trigger compositionend before keydown.
    // delay 50ms for safari.
    setTimeout(() => {
      isComposingRef.current = false
    }, 50)
  }
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Determine if this key combo should trigger send:
    // sendOnEnter=true (default): Enter sends, Shift+Enter inserts newline
    // sendOnEnter=false: Shift+Enter sends, Enter inserts newline
    const isSendCombo = sendOnEnter
      ? e.key === 'Enter' && !e.shiftKey
      : e.key === 'Enter' && e.shiftKey
    if (isSendCombo && !e.nativeEvent.isComposing) {
      // if isComposing, exit
      if (isComposingRef.current) return
      e.preventDefault()
      setQuery(query.replace(/\n$/, ''))
      historyRef.current.push(query)
      setCurrentIndex(historyRef.current.length)
      handleSend()
    } else if (e.key === 'ArrowUp' && !e.shiftKey && !e.nativeEvent.isComposing && e.metaKey) {
      // When the cmd + up key is pressed, output the previous element
      if (currentIndex > 0) {
        setCurrentIndex(currentIndex - 1)
        handleQueryChange(historyRef.current[currentIndex - 1]!)
      }
    } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.nativeEvent.isComposing && e.metaKey) {
      // When the cmd + down key is pressed, output the next element
      if (currentIndex < historyRef.current.length - 1) {
        setCurrentIndex(currentIndex + 1)
        handleQueryChange(historyRef.current[currentIndex + 1]!)
      } else if (currentIndex === historyRef.current.length - 1) {
        // If it is the last element, clear the input box
        setCurrentIndex(historyRef.current.length)
        handleQueryChange('')
      }
    }
  }
  const handleShowVoiceInput = useCallback(() => {
    const textareaElement = textareaRef.current
    if (textareaElement) {
      const activeElement = textareaElement.ownerDocument.activeElement
      voiceInputReturnFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== textareaElement.ownerDocument.body
          ? activeElement
          : textareaElement
    }
    voiceInputCompletedRef.current = false
    setShowVoiceInput(true)
  }, [textareaRef])
  const handleVoiceInputStartError = useCallback(
    (error: unknown) => {
      toast.error(
        t(
          ($) =>
            $[isMicrophonePermissionDenied(error) ? 'voiceInput.notAllow' : 'api.actionFailed'],
          { ns: 'common' },
        ),
      )
    },
    [t],
  )
  const handleVoiceInputError = useCallback(() => {
    toast.error(t(($) => $['api.actionFailed'], { ns: 'common' }))
  }, [t])
  const handleHideVoiceInput = useCallback(() => {
    const textareaElement = textareaRef.current
    const documentElement = textareaElement?.ownerDocument
    const activeElement = documentElement?.activeElement
    const shouldRestoreFocus =
      !!documentElement &&
      (activeElement === documentElement.body ||
        !!(activeElement && voiceInputRef.current?.contains(activeElement)))
    const returnFocusElement = voiceInputReturnFocusRef.current
    const voiceInputCompleted = voiceInputCompletedRef.current
    voiceInputReturnFocusRef.current = null
    voiceInputCompletedRef.current = false
    setShowVoiceInput(false)
    if (voiceInputCompleted || !shouldRestoreFocus || !documentElement) return

    queueMicrotask(() => {
      const currentActiveElement = documentElement.activeElement
      if (currentActiveElement !== documentElement.body && currentActiveElement !== activeElement)
        return

      const elementToFocus = returnFocusElement?.isConnected ? returnFocusElement : textareaElement
      elementToFocus?.focus({ preventScroll: true })
    })
  }, [textareaRef])
  const handleVoiceInputConverted = (text: string) => {
    voiceInputCompletedRef.current = true
    handleQueryChange(text)
    queueMicrotask(() => {
      const textareaElement = textareaRef.current
      if (!textareaElement) return

      const activeElement = textareaElement.ownerDocument.activeElement
      if (
        activeElement &&
        activeElement !== textareaElement.ownerDocument.body &&
        activeElement !== textareaElement &&
        !voiceInputRef.current?.contains(activeElement)
      ) {
        return
      }

      textareaElement.focus({ preventScroll: true })
      const caretPosition = textareaElement.value.length
      textareaElement.setSelectionRange(caretPosition, caretPosition)
    })
  }
  const operation = (
    <Operation
      ref={holdSpaceRef}
      readonly={readonly}
      fileConfig={visionConfig}
      speechToTextConfig={speechToTextConfig}
      onShowVoiceInput={speechToTextTarget ? handleShowVoiceInput : undefined}
      onSend={handleSend}
      sendButtonLabel={sendButtonLabel}
      sendButtonLoading={sendButtonLoading}
      disabled={!canSend}
      theme={theme}
    />
  )
  const shouldShowFooterNotice = footerNotice !== undefined && footerNotice !== null
  const shouldShowFooterNoticeTooltip =
    footerNoticeTooltip !== undefined && footerNoticeTooltip !== null
  const footerNoticeText = typeof footerNotice === 'string' ? footerNotice.trim() : ''
  const footerNoticeAriaLabel = footerNoticeText
    ? `${t(($) => $['operation.learnMore'], { ns: 'common' })}: ${footerNoticeText}`
    : t(($) => $['operation.learnMore'], { ns: 'common' })
  return (
    <>
      <div
        className={cn(
          'pointer-events-auto relative z-10 overflow-hidden rounded-xl border border-components-chat-input-border bg-components-panel-bg-blur pb-2.25 shadow-md',
          isDragActive &&
            'border border-dashed border-components-option-card-option-selected-border',
          disabled && 'pointer-events-none border-components-panel-border opacity-50 shadow-none',
        )}
      >
        {queuedItems.length > 0 && (
          <div className="mx-2.25 mt-2.25 rounded-lg border border-components-panel-border-subtle bg-util-colors-indigo-indigo-50 px-2.5 py-2">
            <div className="flex items-center justify-between body-xs-medium text-text-secondary">
              <span>{`排队 ${queuedItems.length} 条`}</span>
              <button
                type="button"
                className="cursor-pointer body-xs-medium text-text-accent hover:underline"
                onClick={handleClearQueuedItems}
              >
                一键清空
              </button>
            </div>
            <ul className="mt-1 space-y-1">
              {queuedItems.map((item, index) => {
                const summary = summarizeQueueContent(item.content)
                const isExpanded = expandedQueueItem === item.content
                return (
                  <li key={`${index}-${item.content.slice(0, 8)}`} className="flex items-start gap-2">
                    <div
                      className="min-w-0 flex-1 cursor-pointer"
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedQueueItem(isExpanded ? null : item.content)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpandedQueueItem(isExpanded ? null : item.content)
                        }
                      }}
                    >
                      <span className={cn('break-all body-xs-regular', summary.isLink ? 'text-text-accent' : 'text-text-secondary')}>
                        {summary.label}
                      </span>
                      {isExpanded && (
                        <div className="mt-1 rounded-md bg-components-panel-bg px-2 py-1 break-all whitespace-pre-wrap body-xs-regular text-text-primary">
                          {item.content}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="删除排队消息"
                      className="shrink-0 cursor-pointer body-xs-medium text-text-accent hover:underline"
                      onClick={() => handleRemoveQueuedItem(index)}
                    >
                      删除
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        <div className="px-2.25 pt-2.25">
          <FileListInChatInput fileConfig={visionConfig!} />
        </div>
        <div className="relative max-h-39.5 overflow-x-hidden overflow-y-auto px-2.25">
          <div ref={wrapperRef} className="flex items-center justify-between">
            <div className="relative flex w-full grow items-center">
              <div
                ref={textValueRef}
                className="pointer-events-none invisible absolute size-auto p-1 body-lg-regular leading-6 whitespace-pre"
              >
                {query}
              </div>
              <Textarea
                ref={(ref) => {
                  textareaRef.current = ref ?? undefined
                }}
                className={cn(
                  'w-full resize-none bg-transparent p-1 body-lg-regular leading-6 text-text-primary outline-hidden',
                )}
                placeholder={
                  !readonly && customPlaceholder?.trim()
                    ? customPlaceholder
                    : decode(
                        t(
                          ($) =>
                            $[readonly ? 'chat.inputDisabledPlaceholder' : 'chat.inputPlaceholder'],
                          { ns: 'common', botName },
                        ) || '',
                      )
                }
                // Existing chat behavior focuses the composer as soon as it opens.
                // oxlint-disable-next-line jsx-a11y/no-autofocus
                autoFocus={autoFocus}
                minRows={1}
                value={query}
                onChange={(e) => handleQueryChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={handleClipboardPasteFile}
                onDragEnter={handleDragFileEnter}
                onDragLeave={handleDragFileLeave}
                onDragOver={handleDragFileOver}
                onDrop={handleDropFile}
                readOnly={readonly}
              />
            </div>
            {!isMultipleLine && operation}
          </div>
        </div>
        {showVoiceInput && speechToTextTarget && (
          <div className="px-2.25">
            <VoiceInput
              ref={voiceInputRef}
              target={speechToTextTarget}
              onCancel={handleHideVoiceInput}
              onBeforeTranscribe={onBeforeSpeechToText}
              onConverted={handleVoiceInputConverted}
              onError={handleVoiceInputError}
              onStartError={handleVoiceInputStartError}
            />
          </div>
        )}
        {isMultipleLine && <div className="px-2.25">{operation}</div>}
      </div>
      {shouldShowFooterNotice && (
        <div className="m-1 mt-0 -translate-y-2 rounded-b-[10px] border-r border-b border-l border-components-panel-border-subtle bg-util-colors-indigo-indigo-50 px-2.5 py-2 pt-4">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1 body-xs-medium text-text-accent">{footerNotice}</div>
            {shouldShowFooterNoticeTooltip && (
              <Infotip
                aria-label={footerNoticeAriaLabel}
                className="ml-auto size-5 rounded-md text-text-accent hover:bg-state-base-hover hover:text-text-accent"
                iconVariant="information"
                popupClassName="max-w-80 border-0 text-start wrap-break-word"
              >
                {footerNoticeTooltip}
              </Infotip>
            )}
          </div>
        </div>
      )}
      {showFeatureBar && (
        <div className="pointer-events-auto">
          <FeatureBar
            showFileUpload={showFileUpload}
            disabled={featureBarDisabled}
            onFeatureBarClick={featureBarReadonly ? noop : onFeatureBarClick}
            hideEditEntrance={featureBarReadonly}
          />
        </div>
      )}
    </>
  )
}
const ChatInputAreaWrapper = (props: ChatInputAreaProps) => {
  return (
    <FileContextProvider>
      <ChatInputArea {...props} />
    </FileContextProvider>
  )
}
export default ChatInputAreaWrapper
