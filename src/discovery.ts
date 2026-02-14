import {
  query,
  type SlashCommand,
  type ModelInfo,
} from "@anthropic-ai/claude-agent-sdk"

export interface Capabilities {
  commands: SlashCommand[]
  models: ModelInfo[]
}

/**
 * Discovers available Claude Code commands and models by running
 * a minimal query and querying the SDK's control methods.
 */
export async function discoverCapabilities(
  projectPath: string
): Promise<Capabilities> {
  const q = query({
    prompt: "/help",
    options: {
      cwd: projectPath,
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "plan",
      maxTurns: 1,
    },
  })

  // Wait for init, then query capabilities and close
  for await (const message of q) {
    if (message.type === "system" && message.subtype === "init") {
      const [commands, models] = await Promise.all([
        q.supportedCommands(),
        q.supportedModels(),
      ])
      q.close()
      return { commands, models }
    }

    // Don't wait for the full result if we already have what we need
    if (message.type === "result") {
      break
    }
  }

  return { commands: [], models: [] }
}
