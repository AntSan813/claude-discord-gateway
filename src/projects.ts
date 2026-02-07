import fs from 'node:fs'
import path from 'node:path'

export interface ProjectConfig {
  name: string
  path: string
  channelId: string
  model?: string
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  maxBudgetUsd?: number
  allowedTools?: string[]
  disallowedTools?: string[]
}

interface DiscordJson {
  channelId: string
  model?: string
  permissionMode?: string
  maxBudgetUsd?: number
  allowedTools?: string[] | null
  disallowedTools?: string[] | null
}

export class ProjectRegistry {
  private channelMap = new Map<string, ProjectConfig>()
  private projectsRoot: string

  constructor(projectsRoot: string) {
    this.projectsRoot = projectsRoot
  }

  discover(): Map<string, ProjectConfig> {
    this.channelMap.clear()

    if (!fs.existsSync(this.projectsRoot)) {
      console.error(`Projects root does not exist: ${this.projectsRoot}`)
      process.exit(1)
    }

    const entries = fs.readdirSync(this.projectsRoot, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const projectPath = path.join(this.projectsRoot, entry.name)
      const discordJsonPath = path.join(projectPath, 'discord.json')

      if (!fs.existsSync(discordJsonPath)) continue

      try {
        const raw = fs.readFileSync(discordJsonPath, 'utf-8')
        const config: DiscordJson = JSON.parse(raw)

        if (!config.channelId) {
          console.error(`Missing channelId in ${discordJsonPath}`)
          continue
        }

        if (this.channelMap.has(config.channelId)) {
          console.error(`Duplicate channelId ${config.channelId} in ${entry.name}, skipping`)
          continue
        }

        const project: ProjectConfig = {
          name: entry.name,
          path: projectPath,
          channelId: config.channelId,
          model: config.model,
          permissionMode: (config.permissionMode as ProjectConfig['permissionMode']) || 'default',
          maxBudgetUsd: config.maxBudgetUsd,
          allowedTools: config.allowedTools ?? undefined,
          disallowedTools: config.disallowedTools ?? undefined,
        }

        this.channelMap.set(config.channelId, project)
        console.log(`Registered project: ${entry.name} → channel ${config.channelId}`)
      } catch (err) {
        console.error(`Failed to parse ${discordJsonPath}:`, err)
      }
    }

    return this.channelMap
  }

  getByChannelId(channelId: string): ProjectConfig | undefined {
    return this.channelMap.get(channelId)
  }

  getAll(): ProjectConfig[] {
    return Array.from(this.channelMap.values())
  }

  count(): number {
    return this.channelMap.size
  }
}
