import {
  query,
  type CanUseTool,
  type Query,
} from "@anthropic-ai/claude-agent-sdk"
import type { ProjectConfig } from "./projects.js"

export type { Query }

export interface QueryInput {
  prompt: string
  project: ProjectConfig
  sessionId: string | null
  canUseTool: CanUseTool
  attachments?: string[]
  onStreamText?: (text: string) => void
  onToolActivity?: (text: string) => void
  onQueryCreated?: (q: Query) => void
}

export interface QueryResult {
  text: string
  sessionId: string
  cost: number
  durationMs: number
  numTurns: number
  isError: boolean
  errors?: string[]
  contextUsed: number
  contextWindow: number
}

export async function runQuery(input: QueryInput): Promise<QueryResult> {
  const {
    prompt,
    project,
    sessionId,
    canUseTool,
    attachments,
    onStreamText,
    onToolActivity,
    onQueryCreated,
  } = input

  // Build prompt with attachments if any
  let fullPrompt = prompt
  if (attachments && attachments.length > 0) {
    const fileList = attachments.map(p => `  - ${p}`).join("\n")
    fullPrompt = `[User uploaded files:\n${fileList}\n]\n\n${prompt}`
  }

  const options: Parameters<typeof query>[0]["options"] = {
    cwd: project.path,
    settingSources: ["project", "user"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: project.permissionMode,
    canUseTool: canUseTool,
    includePartialMessages: true,

    ...(sessionId && { resume: sessionId }),
    ...(project.model && { model: project.model }),
    ...(project.maxBudgetUsd && { maxBudgetUsd: project.maxBudgetUsd }),
    ...(project.allowedTools && { allowedTools: project.allowedTools }),
    ...(project.disallowedTools && {
      disallowedTools: project.disallowedTools,
    }),
  }

  let resultSessionId = sessionId ?? ""
  let resultText = ""
  let resultCost = 0
  let resultDurationMs = 0
  let resultNumTurns = 0
  let resultIsError = false
  let resultErrors: string[] = []
  let resultContextUsed = 0
  let resultContextWindow = 0

  // Track streaming text separately from final result text
  let streamText = ""

  const q = query({ prompt: fullPrompt, options })
  onQueryCreated?.(q)

  for await (const message of q) {
    // Capture session ID from init
    if (message.type === "system" && message.subtype === "init") {
      resultSessionId = message.session_id
    }

    // Stream text deltas to caller
    if (message.type === "stream_event") {
      const event = message.event as Record<string, unknown>
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          streamText += delta.text
          onStreamText?.(streamText)
        }
      }
    }

    // Collect final text and track per-turn usage from assistant messages
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") {
          resultText += block.text
        }
        if (block.type === "tool_use" && onToolActivity) {
          onToolActivity(
            formatToolUse(block.name, block.input as Record<string, unknown>)
          )
        }
      }

      // Capture per-turn usage for accurate context fill
      const usage = message.message.usage as Record<string, unknown> | undefined
      if (usage) {
        const inputTokens = (usage.input_tokens as number) ?? 0
        const cacheRead = (usage.cache_read_input_tokens as number) ?? 0
        const cacheCreation = (usage.cache_creation_input_tokens as number) ?? 0
        resultContextUsed = inputTokens + cacheRead + cacheCreation
      }
    }

    // Forward tool use summaries
    if (message.type === "tool_use_summary" && onToolActivity) {
      onToolActivity(message.summary)
    }

    // Forward status messages (compacting, etc.)
    if (message.type === "system" && message.subtype === "status") {
      const status = (message as Record<string, unknown>).status
      if (status === "compacting")
        onToolActivity?.("Compacting conversation...")
    }

    // Capture result and close
    if (message.type === "result") {
      resultSessionId = message.session_id
      resultCost = message.total_cost_usd
      resultDurationMs = message.duration_ms
      resultNumTurns = message.num_turns
      resultIsError = message.is_error

      if (message.subtype !== "success" && "errors" in message) {
        resultErrors = message.errors
      }

      if (!resultText && "result" in message) {
        resultText = message.result
      }

      // Get context window from model usage
      const models = Object.values(message.modelUsage)
      if (models.length > 0) {
        resultContextWindow = models[0].contextWindow
      }

      q.close()
      break
    }
  }

  return {
    text: resultText || "(No response)",
    sessionId: resultSessionId,
    cost: resultCost,
    durationMs: resultDurationMs,
    numTurns: resultNumTurns,
    isError: resultIsError,
    errors: resultErrors.length > 0 ? resultErrors : undefined,
    contextUsed: resultContextUsed,
    contextWindow: resultContextWindow,
  }
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const hint =
    (input.command as string) ??
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    ""
  const short = hint.length > 80 ? hint.slice(0, 77) + "..." : hint
  return short ? `${name}: ${short}` : name
}
