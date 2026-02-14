import "dotenv/config"
import os from "node:os"
import path from "node:path"
import { createDiscordClient } from "./discord.js"
import { ProjectRegistry } from "./projects.js"
import { SessionStore } from "./sessions.js"
import { registerCommands, setDiscoveredCapabilities } from "./commands.js"
import { discoverCapabilities } from "./discovery.js"

// Validate environment
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing ${name} in environment`)
    process.exit(1)
  }
  return value
}

const DISCORD_TOKEN = requireEnv("DISCORD_TOKEN")
const DISCORD_APPLICATION_ID = requireEnv("DISCORD_APPLICATION_ID")
requireEnv("ANTHROPIC_API_KEY") // Just validate it exists, SDK reads it directly

async function main(): Promise<void> {
  console.log("Starting Discord Claude Bridge...")

  // Discover projects
  const projectsRoot =
    process.env.PROJECTS_DIR || path.join(os.homedir(), "projects")
  const projects = new ProjectRegistry(projectsRoot)
  projects.discover()

  if (projects.count() === 0) {
    console.warn(
      "No projects found. Use 'make add-project CHANNEL_ID=xxx' to add one."
    )
  }

  // Initialize session store
  const sessions = new SessionStore("./data/sessions.db")

  // Discover Claude Code capabilities (commands, models)
  const firstProject = projects.getAll()[0]
  if (firstProject) {
    try {
      const capabilities = await discoverCapabilities(firstProject.path)
      setDiscoveredCapabilities(capabilities.commands, capabilities.models)
      console.log(
        `Discovered ${capabilities.commands.length} commands, ${capabilities.models.length} models`
      )
    } catch (err) {
      console.warn("Could not discover Claude Code capabilities:", err)
    }
  }

  // Register slash commands
  await registerCommands(DISCORD_TOKEN, DISCORD_APPLICATION_ID)

  // Create and start Discord client
  const client = createDiscordClient({ projects, sessions })

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...")
    sessions.close()
    client.destroy()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // Handle unhandled rejections (don't crash)
  process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error)
  })

  await client.login(DISCORD_TOKEN)
  console.log(`Connected. Watching ${projects.count()} project(s).`)
}

main().catch(error => {
  console.error("Fatal error:", error)
  process.exit(1)
})
