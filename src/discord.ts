import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from "discord.js"
import fs from "node:fs/promises"
import path from "node:path"
import { runQuery } from "./claude.js"
import {
  handleCommand,
  getModelOverride,
  getPermissionModeOverride,
  type CommandContext,
} from "./commands.js"
import { chunkResponse, formatCost } from "./formatter.js"
import { createPermissionHandler } from "./permissions.js"
import type { ProjectConfig, ProjectRegistry } from "./projects.js"
import type { SessionStore } from "./sessions.js"

interface DiscordClientOptions {
  projects: ProjectRegistry
  sessions: SessionStore
}

// Store last cost per channel for /cost command
export const lastCosts = new Map<
  string,
  { cost: number; durationMs: number; numTurns: number }
>()

// Track active queries for /abort (stores objects with interrupt method)
export const activeQueries = new Map<
  string,
  { interrupt: () => Promise<void> }
>()

// Message queue per channel
const messageQueues = new Map<string, Message[]>()

const EDIT_THROTTLE_MS = 1000

function applyOverrides(project: ProjectConfig): ProjectConfig {
  const modelOverride = getModelOverride(project.channelId)
  const permissionOverride = getPermissionModeOverride(project.channelId)
  return {
    ...project,
    ...(modelOverride && { model: modelOverride }),
    ...(permissionOverride && {
      permissionMode: permissionOverride as ProjectConfig["permissionMode"],
    }),
  }
}

export function createDiscordClient(opts: DiscordClientOptions): Client {
  const { projects, sessions } = opts

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.on("clientReady", () => {
    console.log(`Logged in as ${client.user?.tag}`)
  })

  // Handle Claude Code commands sent via slash commands
  const sendAsPrompt = (channelId: string, prompt: string) => {
    const channel = client.channels.cache.get(channelId) as
      | TextChannel
      | undefined
    if (!channel) return

    const project = projects.getByChannelId(channelId)
    if (!project) return

    processQuery(channel, project, prompt, projects, sessions)
  }

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return
    if (!message.content && message.attachments.size === 0) return

    const project = projects.getByChannelId(message.channelId)
    if (!project) return

    // Queue message if a query is already running
    if (activeQueries.has(message.channelId)) {
      const queue = messageQueues.get(message.channelId) ?? []
      queue.push(message)
      messageQueues.set(message.channelId, queue)
      await message.react("🕐").catch(() => {})
      return
    }

    // Handle attachments
    const attachmentPaths = await downloadAttachments(message, project.path)

    // Build prompt
    let prompt = message.content || ""
    if (attachmentPaths.length > 0) {
      const fileList = attachmentPaths.map(p => `  - ${p}`).join("\n")
      prompt = `[User uploaded files:\n${fileList}\n]\n\n${prompt}`
    }
    if (!prompt.trim()) {
      prompt = "Analyze the uploaded file(s)."
    }

    await processQuery(
      message.channel as TextChannel,
      applyOverrides(project),
      prompt,
      projects,
      sessions
    )
  })

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return

    try {
      const ctx: CommandContext = {
        projects,
        sessions,
        lastCosts,
        activeQueries,
        sendAsPrompt,
      }
      await handleCommand(interaction, ctx)
    } catch (err) {
      console.error("Command error:", err)
    }
  })

  return client
}

async function processQuery(
  channel: TextChannel,
  project: ProjectConfig,
  prompt: string,
  projects: ProjectRegistry,
  sessions: SessionStore
): Promise<void> {
  const channelId = channel.id

  // Show typing + send streaming placeholder
  await channel.sendTyping()
  const streamMsg = await channel.send("-# ⏳").catch(() => null)
  if (!streamMsg) return

  const typingInterval = setInterval(() => {
    channel.sendTyping().catch(() => {})
  }, 8000)

  const canUseTool = createPermissionHandler(channel)
  const sessionId = sessions.get(channelId)

  // Progress message for tool activity (single editable message)
  let progressMsg: Message | null = null
  let lastEditTime = 0

  console.log(
    `Query [${project.name}] session=${
      sessionId?.slice(0, 8) ?? "new"
    } prompt="${prompt.slice(0, 60)}"`
  )

  try {
    const result = await runQuery({
      prompt,
      project,
      sessionId,
      canUseTool,
      onQueryCreated: q => {
        activeQueries.set(channelId, { interrupt: () => q.interrupt() })
      },
      onStreamText: text => {
        const now = Date.now()
        if (now - lastEditTime < EDIT_THROTTLE_MS) return
        lastEditTime = now

        // Show text from the start, truncated to fit Discord's limit
        const display = text.length > 1900 ? text.slice(0, 1897) + "..." : text
        streamMsg.edit(display).catch(() => {})
      },
      onToolActivity: text => {
        const formatted = `-# ⏵ ${text}`
        if (!progressMsg) {
          channel
            .send(formatted)
            .then(msg => {
              progressMsg = msg
            })
            .catch(() => {})
        } else {
          progressMsg.edit(formatted).catch(() => {})
        }
      },
    })

    // Save session
    sessions.set(channelId, result.sessionId, project.name)

    // Store cost
    lastCosts.set(channelId, {
      cost: result.cost,
      durationMs: result.durationMs,
      numTurns: result.numTurns,
    })

    // Handle errors
    if (result.isError && result.errors?.length) {
      const errorText = result.errors.join("\n")
      if (sessionId && isSessionError(new Error(errorText))) {
        sessions.clear(channelId)
        await streamMsg.edit(
          "Session expired or corrupted. Starting fresh — please resend your message."
        )
      } else {
        await streamMsg.edit(`Error: ${errorText}`)
      }
      return
    }

    // Format and send final response
    const chunks = chunkResponse(result.text)
    const costFooter = formatCost(
      result.cost,
      result.durationMs,
      result.numTurns,
      result.contextUsed,
      result.contextWindow
    )

    // Edit streaming message to be the first chunk
    const firstContent =
      chunks.length === 1 ? `${chunks[0]}\n\n${costFooter}` : chunks[0]
    await streamMsg.edit(firstContent)

    // Send remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1
      const content = isLast ? `${chunks[i]}\n\n${costFooter}` : chunks[i]
      await channel.send(content)
    }
  } catch (error) {
    const err = error as Error
    console.error(
      `Query error [${project.name}] session=${sessionId ?? "none"}:`,
      err.message
    )
    if (err.stack) console.error(err.stack)

    if (sessionId && isSessionError(err)) {
      sessions.clear(channelId)
      await streamMsg.edit(
        "Session expired or corrupted. Starting fresh — please resend your message."
      )
    } else {
      await streamMsg.edit(`Error: ${err.message}`)
    }
  } finally {
    activeQueries.delete(channelId)
    clearInterval(typingInterval)

    // Process next queued message
    const queue = messageQueues.get(channelId)
    if (queue && queue.length > 0) {
      const next = queue.shift()!
      if (queue.length === 0) messageQueues.delete(channelId)

      const nextProject = projects.getByChannelId(channelId)
      if (nextProject && next.content) {
        processQuery(
          channel,
          applyOverrides(nextProject),
          next.content,
          projects,
          sessions
        )
      }
    }
  }
}

async function downloadAttachments(
  message: Message,
  projectPath: string
): Promise<string[]> {
  const paths: string[] = []

  for (const [, attachment] of message.attachments) {
    try {
      const uploadsDir = path.join(projectPath, ".discord-uploads")
      await fs.mkdir(uploadsDir, { recursive: true })

      const dest = path.join(uploadsDir, attachment.name)
      const response = await fetch(attachment.url)
      const buffer = Buffer.from(await response.arrayBuffer())
      await fs.writeFile(dest, buffer)

      paths.push(dest)
    } catch (err) {
      console.error(`Failed to download attachment ${attachment.name}:`, err)
    }
  }

  return paths
}

function isSessionError(error: Error): boolean {
  const msg = error.message.toLowerCase()
  return (
    msg.includes("session") ||
    msg.includes("resume") ||
    msg.includes("not found") ||
    msg.includes("expired") ||
    msg.includes("exited with code")
  )
}
