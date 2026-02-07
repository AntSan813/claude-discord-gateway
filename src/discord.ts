import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runQuery } from './claude.js'
import { handleCommand, getModelOverride } from './commands.js'
import { chunkResponse, formatCost } from './formatter.js'
import { createPermissionHandler } from './permissions.js'
import type { ProjectRegistry } from './projects.js'
import type { SessionStore } from './sessions.js'

interface DiscordClientOptions {
  projects: ProjectRegistry
  sessions: SessionStore
}

// Store last cost per channel for /cost command
export const lastCosts = new Map<
  string,
  { cost: number; durationMs: number; numTurns: number }
>()

export function createDiscordClient(opts: DiscordClientOptions): Client {
  const { projects, sessions } = opts

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.on('clientReady', () => {
    console.log(`Logged in as ${client.user?.tag}`)
  })

  client.on('messageCreate', async (message: Message) => {
    // Guards
    if (message.author.bot) return
    if (!message.content && message.attachments.size === 0) return

    // Project lookup
    const project = projects.getByChannelId(message.channelId)
    if (!project) return

    // Apply runtime model override if set
    const modelOverride = getModelOverride(message.channelId)
    const effectiveProject = modelOverride
      ? { ...project, model: modelOverride }
      : project

    // Handle attachments
    const attachmentPaths: string[] = []
    for (const [, attachment] of message.attachments) {
      try {
        const uploadsDir = path.join(project.path, '.discord-uploads')
        await fs.mkdir(uploadsDir, { recursive: true })

        const dest = path.join(uploadsDir, attachment.name)
        const response = await fetch(attachment.url)
        const buffer = Buffer.from(await response.arrayBuffer())
        await fs.writeFile(dest, buffer)

        attachmentPaths.push(dest)
      } catch (err) {
        console.error(`Failed to download attachment ${attachment.name}:`, err)
      }
    }

    // Build prompt
    let prompt = message.content || ''
    if (attachmentPaths.length > 0) {
      const fileList = attachmentPaths.map((p) => `  - ${p}`).join('\n')
      prompt = `[User uploaded files:\n${fileList}\n]\n\n${prompt}`
    }

    if (!prompt.trim()) {
      prompt = 'Analyze the uploaded file(s).'
    }

    // Show typing indicator
    const channel = message.channel as TextChannel
    await channel.sendTyping()
    const typingInterval = setInterval(() => {
      channel.sendTyping().catch(() => {})
    }, 8000)

    // Create permission handler
    const canUseTool = createPermissionHandler(channel)

    try {
      const sessionId = sessions.get(message.channelId)

      const result = await runQuery({
        prompt,
        project: effectiveProject,
        sessionId,
        canUseTool,
        attachments: attachmentPaths,
      })

      // Save session
      sessions.set(message.channelId, result.sessionId, project.name)

      // Store cost for /cost command
      lastCosts.set(message.channelId, {
        cost: result.cost,
        durationMs: result.durationMs,
        numTurns: result.numTurns,
      })

      // Format and send response
      if (result.isError && result.errors?.length) {
        const errorText = `Error: ${result.errors.join('\n')}`
        await channel.send(errorText)
        return
      }

      const chunks = chunkResponse(result.text)
      const costFooter = formatCost(result.cost, result.durationMs, result.numTurns)

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1
        const content = isLast ? `${chunks[i]}\n\n${costFooter}` : chunks[i]
        await channel.send(content)
      }
    } catch (error) {
      const err = error as Error

      // Handle session resume failure
      if (isSessionError(err, sessionId !== null)) {
        sessions.clear(message.channelId)
        await message.reply(
          'Session expired or corrupted. Starting fresh — please resend your message.'
        )
      } else {
        console.error('Query error:', err)
        await message.reply(`Error: ${err.message}`)
      }
    } finally {
      clearInterval(typingInterval)
    }
  })

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return

    await handleCommand(interaction, {
      projects,
      sessions,
      lastCosts,
    })
  })

  return client
}

function isSessionError(error: Error, hadSession: boolean): boolean {
  const msg = error.message.toLowerCase()

  // Explicit session-related errors
  if (
    msg.includes('session') ||
    msg.includes('resume') ||
    msg.includes('not found') ||
    msg.includes('expired')
  ) {
    return true
  }

  // Process crash while resuming a session — likely a stale/corrupt session
  if (hadSession && msg.includes('exited with code')) {
    return true
  }

  return false
}
