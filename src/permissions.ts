import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextChannel,
} from "discord.js"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { truncate } from "./formatter.js"

export type { CanUseTool }

export function createPermissionHandler(channel: TextChannel): CanUseTool {
  return async (toolName, input, options) => {
    // AskUserQuestion needs special handling — render options as buttons
    if (toolName === "AskUserQuestion") {
      return handleAskUserQuestion(channel, input)
    }

    const description = formatToolDescription(toolName, input)

    const embed = new EmbedBuilder()
      .setTitle(`Permission Request: ${toolName}`)
      .setDescription(description)
      .setColor(0xffa500) // Orange for pending

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("approve")
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("deny")
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
    )

    const msg = await channel.send({ embeds: [embed], components: [row] })

    try {
      const interaction = await msg.awaitMessageComponent({
        filter: i => ["approve", "deny"].includes(i.customId),
        time: 600_000, // 10 minute timeout
      })

      const approved = interaction.customId === "approve"

      await interaction.update({
        embeds: [
          embed
            .setColor(approved ? 0x00ff00 : 0xff0000)
            .setTitle(`${approved ? "Approved" : "Denied"}: ${toolName}`),
        ],
        components: [],
      })

      if (approved) {
        return { behavior: "allow" as const, updatedInput: input }
      } else {
        return { behavior: "deny" as const, message: "User denied via Discord" }
      }
    } catch {
      // Timeout or abort
      await msg
        .edit({
          embeds: [embed.setColor(0x808080).setTitle(`Timed Out: ${toolName}`)],
          components: [],
        })
        .catch(() => {})

      return {
        behavior: "deny" as const,
        message: "Permission request timed out",
      }
    }
  }
}

async function handleAskUserQuestion(
  channel: TextChannel,
  input: Record<string, unknown>
): Promise<ReturnType<CanUseTool>> {
  const questions = input.questions as Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiSelect: boolean
  }>

  if (!questions?.length) {
    return { behavior: "allow" as const, updatedInput: input }
  }

  const answers: Record<string, string> = {}

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]

    const optionLines = q.options
      .map(o => `**${o.label}** — ${o.description}`)
      .join("\n")

    const embed = new EmbedBuilder()
      .setTitle(q.header)
      .setDescription(`${q.question}\n\n${optionLines}`)
      .setColor(0x5865f2) // Discord blurple

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...q.options.map((o, i) =>
        new ButtonBuilder()
          .setCustomId(`opt_${i}`)
          .setLabel(truncate(o.label, 80))
          .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      )
    )

    const msg = await channel.send({ embeds: [embed], components: [row] })

    try {
      const interaction = await msg.awaitMessageComponent({
        filter: i => i.customId.startsWith("opt_"),
        time: 120_000,
      })

      const selectedIdx = parseInt(interaction.customId.replace("opt_", ""), 10)
      const selected = q.options[selectedIdx]

      await interaction.update({
        embeds: [
          embed
            .setColor(0x00ff00)
            .setDescription(`${q.question}\n\nSelected: **${selected.label}**`),
        ],
        components: [],
      })

      answers[qi.toString()] = selected.label
    } catch {
      await msg
        .edit({
          embeds: [embed.setColor(0x808080).setTitle(`Timed Out: ${q.header}`)],
          components: [],
        })
        .catch(() => {})

      return { behavior: "deny" as const, message: "Question timed out" }
    }
  }

  return {
    behavior: "allow" as const,
    updatedInput: { ...input, answers },
  }
}

function formatToolDescription(
  toolName: string,
  input: Record<string, unknown>
): string {
  switch (toolName) {
    case "Bash": {
      const cmd = String(input.command ?? "")
      return `Run command:\n\`\`\`bash\n${truncate(cmd, 500)}\n\`\`\``
    }
    case "Write": {
      const filePath = String(input.file_path ?? "")
      const content = String(input.content ?? "")
      return `Create file: \`${filePath}\`\n${content.length} characters`
    }
    case "Edit": {
      const filePath = String(input.file_path ?? "")
      const oldStr = String(input.old_string ?? "")
      const newStr = String(input.new_string ?? "")
      return `Edit file: \`${filePath}\`\nReplace: \`${truncate(
        oldStr,
        100
      )}\`\nWith: \`${truncate(newStr, 100)}\``
    }
    case "Task": {
      const desc = String(input.description ?? "")
      const agentType = String(input.subagent_type ?? "")
      return `Launch subagent: ${agentType}\nTask: ${truncate(desc, 200)}`
    }
    default: {
      const json = JSON.stringify(input, null, 2)
      return `Tool: ${toolName}\n\`\`\`json\n${truncate(json, 500)}\n\`\`\``
    }
  }
}
