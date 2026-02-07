const MAX_MESSAGE_LENGTH = 1900

export function chunkResponse(
  text: string,
  maxLen = MAX_MESSAGE_LENGTH
): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Try to split at a code block boundary
    let splitIndex = findCodeBlockBoundary(remaining, maxLen)

    // Fallback: split at last newline before maxLen
    if (splitIndex === -1) {
      splitIndex = remaining.lastIndexOf("\n", maxLen)
    }

    // Fallback: hard split at maxLen
    if (splitIndex <= 0) {
      splitIndex = maxLen
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).trimStart()
  }

  // Fix code blocks that span multiple chunks
  return fixCodeBlockContinuity(chunks)
}

function findCodeBlockBoundary(text: string, maxLen: number): number {
  // Look for ``` before maxLen that ends a code block
  let lastClose = -1
  let pos = 0

  while (pos < maxLen) {
    const idx = text.indexOf("```", pos)
    if (idx === -1 || idx >= maxLen) break
    lastClose = idx + 3
    pos = idx + 3
  }

  // Only use this if it's a reasonable split point
  if (lastClose > maxLen * 0.5) {
    return lastClose
  }

  return -1
}

function fixCodeBlockContinuity(chunks: string[]): string[] {
  const result: string[] = []
  let inCodeBlock = false
  let currentLang = ""

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i]

    // If we're continuing a code block from previous chunk
    if (inCodeBlock && i > 0) {
      chunk = "```" + currentLang + "\n" + chunk
    }

    // Track if we end in a code block
    let tempInBlock: boolean = inCodeBlock
    let tempLang: string = currentLang
    let pos = 0

    while (pos < chunk.length) {
      const idx = chunk.indexOf("```", pos)
      if (idx === -1) break

      if (!tempInBlock) {
        // Opening a code block - capture language
        const afterMarker = chunk.slice(idx + 3)
        const langMatch = afterMarker.match(/^(\w*)/)
        tempLang = langMatch ? langMatch[1] : ""
        tempInBlock = true
      } else {
        // Closing a code block
        tempInBlock = false
        tempLang = ""
      }
      pos = idx + 3
    }

    // If chunk ends inside a code block, close it
    if (tempInBlock) {
      chunk = chunk + "\n```"
    }

    result.push(chunk)

    // Update state for next iteration
    inCodeBlock = tempInBlock
    currentLang = tempLang
  }

  return result
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(0)}k`
  return `${tokens}`
}

export function formatCost(
  cost: number,
  durationMs: number,
  numTurns: number,
  inputTokens?: number,
  contextWindow?: number
): string {
  const costStr = cost < 0.01 ? "<$0.01" : `$${cost.toFixed(3)}`
  const durationStr = (durationMs / 1000).toFixed(1)
  const turnsStr = `${numTurns} turn${numTurns !== 1 ? "s" : ""}`

  const parts = [costStr, `${durationStr}s`, turnsStr]

  if (inputTokens && contextWindow) {
    parts.push(
      `${formatTokens(inputTokens)}/${formatTokens(contextWindow)} context`
    )
  }

  return `-# ${parts.join(" · ")}`
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen - 3) + "..."
}
