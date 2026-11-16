import type { FC } from 'react'
import type { ChatItem } from '../../types'
import { cn } from '@langgenius/dify-ui/cn'
import { memo } from 'react'
import { Markdown } from '@/app/components/base/markdown'

// Strip deepseek thinking markers from content so they are not rendered
function stripDeepSeekReasoning(text: string): string {
  if (typeof text !== 'string') return text
  const marker = '<!--dify-deepseek-reasoning-->'
  const idx = text.indexOf(marker)
  if (idx >= 0) text = text.replace(marker, '')
  text = text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '')
  return text
}

type BasicContentProps = {
  item: ChatItem
}
const BasicContent: FC<BasicContentProps> = ({ item }) => {
  const { annotation, content } = item

  if (annotation?.logAnnotation) {
    return (
      <Markdown
      content={stripDeepSeekReasoning(annotation?.logAnnotation.content || '')}
        data-testid="basic-content-markdown"
      />
    )
  }

  // Preserve Windows UNC paths and similar backslash-heavy strings by
  // wrapping them in inline code so Markdown renders backslashes verbatim.
  let displayContent = content
  if (typeof content === 'string' && /^\\\\\S.*/.test(content) && !/^`.*`$/.test(content)) {
    displayContent = `\`${content}\``
  }

  return (
    <Markdown
      className={cn(item.isError && 'text-[#F04438]!')}
      content={stripDeepSeekReasoning(displayContent)}
      data-testid="basic-content-markdown"
    />
  )
}

export default memo(BasicContent)
