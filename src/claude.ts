import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import type { ProjectConfig } from "./projects.js"

export interface QueryInput {
  prompt: string
  project: ProjectConfig
  sessionId: string | null
  canUseTool: CanUseTool
  attachments?: string[]
  abortController?: AbortController
  onToolActivity?: (text: string) => void
}

export interface QueryResult {
  text: string
  sessionId: string
  cost: number
  durationMs: number
  numTurns: number
  isError: boolean
  errors?: string[]
  inputTokens: number
  contextWindow: number
}

export async function runQuery(input: QueryInput): Promise<QueryResult> {
  const {
    prompt,
    project,
    sessionId,
    canUseTool,
    attachments,
    abortController,
    onToolActivity,
  } = input

  // Build prompt with attachments if any
  let fullPrompt = prompt
  if (attachments && attachments.length > 0) {
    const fileList = attachments.map(p => `  - ${p}`).join("\n")
    fullPrompt = `[User uploaded files:\n${fileList}\n]\n\n${prompt}`
  }

  const options: Parameters<typeof query>[0]["options"] = {
    // Core: Project scoping
    cwd: project.path,

    // Core: Load native Claude Code config
    settingSources: ["project", "user"],

    // Core: Use Claude Code's full system prompt
    systemPrompt: { type: "preset", preset: "claude_code" },

    // Core: Permission handling
    permissionMode: project.permissionMode,
    canUseTool: canUseTool,

    // Session: Resume or start fresh
    ...(sessionId && { resume: sessionId }),

    // Optional: Per-project overrides
    ...(project.model && { model: project.model }),
    ...(project.maxBudgetUsd && { maxBudgetUsd: project.maxBudgetUsd }),
    ...(project.allowedTools && { allowedTools: project.allowedTools }),
    ...(project.disallowedTools && {
      disallowedTools: project.disallowedTools,
    }),

    // Abort controller for cancellation
    ...(abortController && { abortController }),
  }

  let resultSessionId = sessionId ?? ""
  let resultText = ""
  let resultCost = 0
  let resultDurationMs = 0
  let resultNumTurns = 0
  let resultIsError = false
  let resultErrors: string[] = []
  let resultInputTokens = 0
  let resultContextWindow = 0

  const q = query({ prompt: fullPrompt, options })

  for await (const message of q) {
    // Capture session ID from init message
    if (message.type === "system" && message.subtype === "init") {
      resultSessionId = message.session_id
    }

    // Collect assistant text and tool invocations
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
    }

    // Forward tool use summaries
    if (message.type === "tool_use_summary" && onToolActivity) {
      onToolActivity(message.summary)
    }

    // Capture result and close — prevents spurious exit code 1
    // when Discord.js WebSocket is active in the parent process
    if (message.type === "result") {
      resultSessionId = message.session_id
      resultCost = message.total_cost_usd
      resultDurationMs = message.duration_ms
      resultNumTurns = message.num_turns
      resultIsError = message.is_error

      if (message.subtype !== "success" && "errors" in message) {
        resultErrors = message.errors
      }

      // Use result text if we didn't accumulate any
      if (!resultText && "result" in message) {
        resultText = message.result
      }

      // Capture token usage from the primary model
      const models = Object.values(message.modelUsage)
      if (models.length > 0) {
        resultInputTokens = models.reduce((sum, m) => sum + m.inputTokens, 0)
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
    inputTokens: resultInputTokens,
    contextWindow: resultContextWindow,
  }
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  // Show the most relevant argument as a brief hint
  const hint =
    (input.command as string) ??
    (input.file_path as string) ??
    (input.path as string) ??
    (input.pattern as string) ??
    ""
  const short = hint.length > 80 ? hint.slice(0, 77) + "..." : hint
  return short ? `⏵ ${name}: ${short}` : `⏵ ${name}`
}
