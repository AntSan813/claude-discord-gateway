import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  REST,
  Routes,
} from "discord.js"
import type { SlashCommand, ModelInfo } from "@anthropic-ai/claude-agent-sdk"
import type { ProjectRegistry } from "./projects.js"
import type { SessionStore } from "./sessions.js"
import { truncate } from "./formatter.js"

// Runtime overrides (ephemeral — reset on restart, by design)
const modelOverrides = new Map<string, string>()
const permissionModeOverrides = new Map<string, string>()

export function getModelOverride(channelId: string): string | undefined {
  return modelOverrides.get(channelId)
}

export function getPermissionModeOverride(
  channelId: string
): string | undefined {
  return permissionModeOverrides.get(channelId)
}

// Gateway-owned command names (take precedence over Claude Code commands)
const GATEWAY_COMMAND_NAMES = new Set([
  "new",
  "resume",
  "status",
  "cost",
  "config",
  "projects",
  "rescan",
  "model",
  "permission-mode",
  "abort",
  "help",
])

// Discovered Claude Code commands (populated on startup)
let discoveredCommands: SlashCommand[] = []
let discoveredModels: ModelInfo[] = []

export function setDiscoveredCapabilities(
  commands: SlashCommand[],
  models: ModelInfo[]
): void {
  discoveredCommands = commands
  discoveredModels = models
}

function buildGatewayCommands() {
  // Build model choices from discovered models, falling back to defaults
  const modelChoices =
    discoveredModels.length > 0
      ? discoveredModels
          .slice(0, 25) // Discord limit
          .map(m => ({ name: m.displayName, value: m.value }))
      : [
          { name: "Sonnet", value: "claude-sonnet-4-5-20250929" },
          { name: "Opus", value: "claude-opus-4-6" },
          { name: "Haiku", value: "claude-haiku-4-5-20251001" },
        ]

  return [
    new SlashCommandBuilder()
      .setName("new")
      .setDescription("Start a fresh conversation (optionally save current)")
      .addStringOption(opt =>
        opt
          .setName("save_as")
          .setDescription(
            "Save current session with this label before clearing"
          )
      ),

    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("List saved sessions or resume one by label")
      .addStringOption(opt =>
        opt.setName("label").setDescription("Label of the session to resume")
      ),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show project and session info"),

    new SlashCommandBuilder()
      .setName("cost")
      .setDescription("Show session cost (from last response)"),

    new SlashCommandBuilder()
      .setName("config")
      .setDescription("Show full project configuration and active overrides"),

    new SlashCommandBuilder()
      .setName("projects")
      .setDescription("List all registered projects"),

    new SlashCommandBuilder()
      .setName("rescan")
      .setDescription("Re-scan project folders"),

    new SlashCommandBuilder()
      .setName("model")
      .setDescription("Switch Claude model for this channel")
      .addStringOption(opt =>
        opt
          .setName("name")
          .setDescription("Model to use")
          .setRequired(true)
          .addChoices(...modelChoices)
      ),

    new SlashCommandBuilder()
      .setName("permission-mode")
      .setDescription("Switch permission mode for this channel")
      .addStringOption(opt =>
        opt
          .setName("mode")
          .setDescription("Permission mode")
          .setRequired(true)
          .addChoices(
            { name: "Default", value: "default" },
            { name: "Accept Edits", value: "acceptEdits" },
            { name: "Bypass Permissions", value: "bypassPermissions" },
            { name: "Plan Only", value: "plan" }
          )
      ),

    new SlashCommandBuilder()
      .setName("abort")
      .setDescription("Cancel the currently running query"),

    new SlashCommandBuilder()
      .setName("help")
      .setDescription("List all available commands"),
  ]
}

function buildClaudeCodeCommands() {
  return discoveredCommands
    .filter(cmd => !GATEWAY_COMMAND_NAMES.has(cmd.name))
    .map(cmd => {
      const builder = new SlashCommandBuilder()
        .setName(cmd.name)
        .setDescription(
          truncate(cmd.description || `Claude Code: /${cmd.name}`, 100)
        )

      if (cmd.argumentHint) {
        builder.addStringOption(opt =>
          opt.setName("args").setDescription(cmd.argumentHint)
        )
      }

      return builder
    })
}

export async function registerCommands(
  token: string,
  applicationId: string
): Promise<void> {
  const rest = new REST().setToken(token)

  const gatewayCommands = buildGatewayCommands()
  const ccCommands = buildClaudeCodeCommands()
  const allCommands = [...gatewayCommands, ...ccCommands]

  console.log(
    `Registering ${gatewayCommands.length} gateway + ${ccCommands.length} Claude Code commands...`
  )

  await rest.put(Routes.applicationCommands(applicationId), {
    body: allCommands.map(c => c.toJSON()),
  })

  console.log("Slash commands registered.")
}

export interface CommandContext {
  projects: ProjectRegistry
  sessions: SessionStore
  lastCosts: Map<string, { cost: number; durationMs: number; numTurns: number }>
  activeQueries: Map<string, { interrupt: () => Promise<void> }>
  sendAsPrompt: (channelId: string, prompt: string) => void
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext
): Promise<void> {
  const { commandName } = interaction

  // Check if this is a Claude Code command (passthrough)
  const isCCCommand =
    !GATEWAY_COMMAND_NAMES.has(commandName) &&
    discoveredCommands.some(c => c.name === commandName)

  if (isCCCommand) {
    const args = interaction.options.getString("args") ?? ""
    const prompt = args ? `/${commandName} ${args}` : `/${commandName}`
    await interaction.reply(`Running \`${prompt}\`...`)
    ctx.sendAsPrompt(interaction.channelId, prompt)
    return
  }

  switch (commandName) {
    case "new": {
      const controller = ctx.activeQueries.get(interaction.channelId)
      if (controller) {
        await controller.interrupt()
        ctx.activeQueries.delete(interaction.channelId)
      }

      const label = interaction.options.getString("save_as")

      if (label) {
        const saved = ctx.sessions.save(interaction.channelId, label)
        ctx.sessions.clear(interaction.channelId)
        await interaction.reply(
          saved
            ? `Session saved as **${label}**. Starting fresh.`
            : "No active session to save. Starting fresh."
        )
      } else {
        ctx.sessions.clear(interaction.channelId)
        await interaction.reply("Session cleared. Next message starts fresh.")
      }
      break
    }

    case "resume": {
      const label = interaction.options.getString("label")

      if (!label) {
        const saved = ctx.sessions.listSaved(interaction.channelId)
        if (saved.length === 0) {
          await interaction.reply(
            "No saved sessions. Use `/new save_as:<label>` to save before clearing."
          )
          return
        }
        const lines = saved.map(s => `**${s.label}** — saved ${s.savedAt}`)
        await interaction.reply(lines.join("\n"))
      } else {
        const restored = ctx.sessions.restore(interaction.channelId, label)
        await interaction.reply(
          restored
            ? `Resumed session **${label}**.`
            : `No saved session named "${label}".`
        )
      }
      break
    }

    case "status": {
      const project = ctx.projects.getByChannelId(interaction.channelId)
      if (!project) {
        await interaction.reply("This channel is not linked to a project.")
        return
      }

      const session = ctx.sessions.get(interaction.channelId)
      const model =
        modelOverrides.get(interaction.channelId) ?? project.model ?? "default"
      const permMode =
        permissionModeOverrides.get(interaction.channelId) ??
        project.permissionMode

      const lines = [
        `**Project:** ${project.name}`,
        `**Path:** \`${project.path}\``,
        `**Model:** ${model}`,
        `**Permission Mode:** ${permMode}`,
        `**Session:** ${session ? `\`${session.slice(0, 8)}...\`` : "none"}`,
      ]

      await interaction.reply(lines.join("\n"))
      break
    }

    case "cost": {
      const lastCost = ctx.lastCosts.get(interaction.channelId)
      if (!lastCost) {
        await interaction.reply("No cost data available. Send a message first.")
        return
      }

      const costStr =
        lastCost.cost < 0.01 ? "<$0.01" : `$${lastCost.cost.toFixed(3)}`
      await interaction.reply(
        `Last query: ${costStr} · ${(lastCost.durationMs / 1000).toFixed(
          1
        )}s · ${lastCost.numTurns} turns`
      )
      break
    }

    case "config": {
      const project = ctx.projects.getByChannelId(interaction.channelId)
      if (!project) {
        await interaction.reply("This channel is not linked to a project.")
        return
      }

      const model = modelOverrides.get(interaction.channelId)
      const permMode = permissionModeOverrides.get(interaction.channelId)

      const lines = [
        `**Project:** ${project.name}`,
        `**Path:** \`${project.path}\``,
        `**Model:** ${model ?? project.model ?? "default"}${
          model ? " *(override)*" : ""
        }`,
        `**Permission Mode:** ${permMode ?? project.permissionMode}${
          permMode ? " *(override)*" : ""
        }`,
        ...(project.maxBudgetUsd
          ? [`**Budget:** $${project.maxBudgetUsd}`]
          : []),
        ...(project.allowedTools
          ? [`**Allowed Tools:** ${project.allowedTools.join(", ")}`]
          : []),
        ...(project.disallowedTools
          ? [`**Disallowed Tools:** ${project.disallowedTools.join(", ")}`]
          : []),
      ]

      await interaction.reply(lines.join("\n"))
      break
    }

    case "projects": {
      const all = ctx.projects.getAll()
      if (all.length === 0) {
        await interaction.reply("No projects registered.")
        return
      }

      const lines = all.map(p => `**${p.name}** → <#${p.channelId}>`)
      await interaction.reply(lines.join("\n"))
      break
    }

    case "rescan": {
      ctx.projects.discover()
      await interaction.reply(
        `Rescanned. ${ctx.projects.count()} projects found.`
      )
      break
    }

    case "model": {
      const model = interaction.options.getString("name", true)
      modelOverrides.set(interaction.channelId, model)

      // Find display name from discovered models
      const displayName =
        discoveredModels.find(m => m.value === model)?.displayName ?? model

      await interaction.reply(
        `Model switched to **${displayName}** for this channel.`
      )
      break
    }

    case "permission-mode": {
      const mode = interaction.options.getString("mode", true)
      permissionModeOverrides.set(interaction.channelId, mode)
      await interaction.reply(
        `Permission mode set to **${mode}** for this channel.`
      )
      break
    }

    case "abort": {
      const activeQuery = ctx.activeQueries.get(interaction.channelId)
      if (!activeQuery) {
        await interaction.reply("No query is running in this channel.")
        return
      }
      await activeQuery.interrupt()
      ctx.activeQueries.delete(interaction.channelId)
      await interaction.reply("Query interrupted.")
      break
    }

    case "help": {
      const gatewayHelp = [
        "**Gateway Commands**",
        "`/new [save_as]` — Start fresh. Optionally save current session.",
        "`/resume [label]` — List saved sessions, or resume one by label.",
        "`/status` — Show project and session info.",
        "`/cost` — Show cost of last query.",
        "`/config` — Show full project config and active overrides.",
        "`/model <name>` — Switch model.",
        "`/permission-mode <mode>` — Switch permission mode.",
        "`/abort` — Interrupt the running query.",
        "`/projects` — List all registered projects.",
        "`/rescan` — Re-scan for new projects.",
      ]

      const ccHelp = discoveredCommands
        .filter(c => !GATEWAY_COMMAND_NAMES.has(c.name))
        .map(c => `\`/${c.name}\` — ${c.description}`)

      const sections = [...gatewayHelp]
      if (ccHelp.length > 0) {
        sections.push("", "**Claude Code Commands**", ...ccHelp)
      }

      await interaction.reply(sections.join("\n"))
      break
    }

    default:
      await interaction.reply("Unknown command.")
  }
}
