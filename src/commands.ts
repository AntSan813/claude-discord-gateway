import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  REST,
  Routes,
} from 'discord.js'
import type { ProjectRegistry } from './projects.js'
import type { SessionStore } from './sessions.js'

// Runtime model overrides (not persisted)
const modelOverrides = new Map<string, string>()

export function getModelOverride(channelId: string): string | undefined {
  return modelOverrides.get(channelId)
}

const commands = [
  new SlashCommandBuilder()
    .setName('new')
    .setDescription('Start a fresh Claude conversation'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show project and session info'),

  new SlashCommandBuilder()
    .setName('cost')
    .setDescription('Show session cost (from last response)'),

  new SlashCommandBuilder()
    .setName('projects')
    .setDescription('List all registered projects'),

  new SlashCommandBuilder()
    .setName('rescan')
    .setDescription('Re-scan project folders'),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch Claude model for this channel')
    .addStringOption((opt) =>
      opt
        .setName('name')
        .setDescription('Model to use')
        .setRequired(true)
        .addChoices(
          { name: 'Sonnet', value: 'claude-sonnet-4-5-20250929' },
          { name: 'Opus', value: 'claude-opus-4-6' },
          { name: 'Haiku', value: 'claude-haiku-4-5-20251001' }
        )
    ),
]

export async function registerCommands(
  token: string,
  applicationId: string
): Promise<void> {
  const rest = new REST().setToken(token)

  console.log('Registering slash commands...')

  await rest.put(Routes.applicationCommands(applicationId), {
    body: commands.map((c) => c.toJSON()),
  })

  console.log('Slash commands registered.')
}

interface CommandContext {
  projects: ProjectRegistry
  sessions: SessionStore
  lastCosts: Map<string, { cost: number; durationMs: number; numTurns: number }>
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext
): Promise<void> {
  const { commandName } = interaction

  switch (commandName) {
    case 'new': {
      ctx.sessions.clear(interaction.channelId)
      await interaction.reply('Session cleared. Next message starts fresh.')
      break
    }

    case 'status': {
      const project = ctx.projects.getByChannelId(interaction.channelId)
      if (!project) {
        await interaction.reply('This channel is not linked to a project.')
        return
      }

      const session = ctx.sessions.get(interaction.channelId)
      const modelOverride = modelOverrides.get(interaction.channelId)

      const lines = [
        `**Project:** ${project.name}`,
        `**Path:** \`${project.path}\``,
        `**Model:** ${modelOverride ?? project.model ?? 'default'}`,
        `**Permission Mode:** ${project.permissionMode}`,
        `**Session:** ${session ? `\`${session.slice(0, 8)}...\`` : 'none'}`,
      ]

      await interaction.reply(lines.join('\n'))
      break
    }

    case 'cost': {
      const lastCost = ctx.lastCosts.get(interaction.channelId)
      if (!lastCost) {
        await interaction.reply('No cost data available. Send a message first.')
        return
      }

      const costStr =
        lastCost.cost < 0.01 ? '<$0.01' : `$${lastCost.cost.toFixed(3)}`
      await interaction.reply(
        `Last query: ${costStr} · ${(lastCost.durationMs / 1000).toFixed(1)}s · ${lastCost.numTurns} turns`
      )
      break
    }

    case 'projects': {
      const all = ctx.projects.getAll()
      if (all.length === 0) {
        await interaction.reply('No projects registered.')
        return
      }

      const lines = all.map(
        (p) => `**${p.name}** → <#${p.channelId}>`
      )
      await interaction.reply(lines.join('\n'))
      break
    }

    case 'rescan': {
      ctx.projects.discover()
      await interaction.reply(`Rescanned. ${ctx.projects.count()} projects found.`)
      break
    }

    case 'model': {
      const model = interaction.options.getString('name', true)
      modelOverrides.set(interaction.channelId, model)

      const displayName = model.includes('sonnet')
        ? 'Sonnet'
        : model.includes('opus')
          ? 'Opus'
          : 'Haiku'

      await interaction.reply(`Model switched to **${displayName}** for this channel.`)
      break
    }

    default:
      await interaction.reply('Unknown command.')
  }
}
