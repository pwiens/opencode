import path from "path"
import { Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect } from "effect"

export const Resolved = Schema.Struct({
  enabled: Schema.Boolean,
  instructions: Schema.Boolean,
  skills: Schema.Boolean,
  mcp: Schema.Boolean,
  agents: Schema.Boolean,
  prompts: Schema.Boolean,
})
export type Resolved = Schema.Schema.Type<typeof Resolved>

export const Info = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    enabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("auto")])).annotate({
      description:
        "Master switch for Copilot CLI integration. true=on, false=off, 'auto' (default)=enable when .github/copilot-instructions.md is found.",
    }),
    instructions: Schema.optional(Schema.Boolean).annotate({
      description:
        "Load ~/.copilot/copilot-instructions.md, .github/copilot-instructions.md, and .github/instructions/*.instructions.md.",
    }),
    skills: Schema.optional(Schema.Boolean).annotate({
      description: "Load ~/.copilot/skills/<name>/SKILL.md and .github/skills/<name>/SKILL.md.",
    }),
    mcp: Schema.optional(Schema.Boolean).annotate({
      description: "Load MCP servers from ~/.copilot/mcp-config.json, .github/mcp.json, and .vscode/mcp.json.",
    }),
    agents: Schema.optional(Schema.Boolean).annotate({
      description: "Load .github/agents/*.agent.md.",
    }),
    prompts: Schema.optional(Schema.Boolean).annotate({
      description: "Load .github/prompts/*.prompt.md as commands.",
    }),
  }),
]).annotate({
  description:
    "GitHub Copilot CLI compatibility. Loads instructions, skills, MCP servers, agents, and prompts from ~/.copilot/ and .github/. Defaults to auto-detect when .github/copilot-instructions.md is present.",
  identifier: "CopilotConfig",
})
export type Info = Schema.Schema.Type<typeof Info>

const PROJECT_SENTINEL = path.join(".github", "copilot-instructions.md")

// Walk from `start` toward `stop` looking for the auto-detect signal.
export const detect = Effect.fn("ConfigCopilot.detect")(function* (start: string, stop: string) {
  const afs = yield* AppFileSystem.Service
  const matches = yield* afs.up({ targets: [PROJECT_SENTINEL], start, stop }).pipe(
    Effect.catch(() => Effect.succeed([] as string[])),
  )
  return matches.length > 0
})

// Collapse the raw user config plus the auto-detect result into per-subsystem booleans.
// Resolution: cfg.<subsystem> wins if set; otherwise inherits from master switch.
// Master switch resolution: explicit boolean wins; "auto" or undefined uses detected.
export function resolve(cfg: Info | undefined, detected: boolean): Resolved {
  const off: Resolved = {
    enabled: false,
    instructions: false,
    skills: false,
    mcp: false,
    agents: false,
    prompts: false,
  }
  if (cfg === undefined) {
    return detected ? { ...off, enabled: true, instructions: true, skills: true, mcp: true, agents: true, prompts: true } : off
  }
  if (cfg === true) {
    return { enabled: true, instructions: true, skills: true, mcp: true, agents: true, prompts: true }
  }
  if (cfg === false) return off

  const master = cfg.enabled === undefined || cfg.enabled === "auto" ? detected : cfg.enabled
  if (!master) {
    // Even if master is off, an explicit per-subsystem true still wins.
    return {
      enabled: false,
      instructions: cfg.instructions ?? false,
      skills: cfg.skills ?? false,
      mcp: cfg.mcp ?? false,
      agents: cfg.agents ?? false,
      prompts: cfg.prompts ?? false,
    }
  }
  return {
    enabled: true,
    instructions: cfg.instructions ?? true,
    skills: cfg.skills ?? true,
    mcp: cfg.mcp ?? true,
    agents: cfg.agents ?? true,
    prompts: cfg.prompts ?? true,
  }
}

export * as ConfigCopilot from "./copilot"
