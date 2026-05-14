import path from "path"
import { Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect } from "effect"
import { isRecord } from "@/util/record"
import { ConfigMCP } from "./mcp"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigMarkdown } from "./markdown"
import { ConfigParse } from "./parse"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "config-copilot" })

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

// Parse one MCP-server file in either the Copilot CLI shape
// ({"mcpServers": {...}}) or the VS Code shape ({"servers": {...}}).
// Returns translated opencode MCP entries keyed by server name.
export function parseMcpFile(text: string, source: string): Record<string, ConfigMCP.Info> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    log.warn("failed to parse mcp config", { source, error: String(err) })
    return {}
  }
  if (!isRecord(data)) return {}
  const servers = isRecord(data.mcpServers)
    ? data.mcpServers
    : isRecord(data.servers)
      ? data.servers
      : undefined
  if (!servers) return {}

  const result: Record<string, ConfigMCP.Info> = {}
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue
    const translated = translateMcpEntry(raw, `${source}:${name}`)
    if (translated) result[name] = translated
  }
  return result
}

function translateMcpEntry(raw: Record<string, unknown>, source: string): ConfigMCP.Info | undefined {
  const isRemote =
    raw.type === "http" || raw.type === "sse" || raw.type === "remote" || (typeof raw.url === "string" && !raw.command)

  if (isRemote) {
    if (typeof raw.url !== "string") {
      log.warn("mcp remote entry missing url", { source })
      return undefined
    }
    let headers: Record<string, string> | undefined
    if (isRecord(raw.headers)) {
      headers = {}
      for (const [k, v] of Object.entries(raw.headers)) {
        if (typeof v === "string") headers[k] = v
      }
    }
    return {
      type: "remote",
      url: raw.url,
      ...(headers ? { headers } : {}),
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    }
  }

  if (typeof raw.command !== "string") {
    log.warn("mcp local entry missing command", { source })
    return undefined
  }
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : []
  const envSrc = isRecord(raw.env) ? raw.env : isRecord(raw.environment) ? raw.environment : undefined
  let environment: Record<string, string> | undefined
  if (envSrc) {
    environment = {}
    for (const [k, v] of Object.entries(envSrc)) {
      if (typeof v === "string") environment[k] = v
    }
  }
  return {
    type: "local",
    command: [raw.command, ...args],
    ...(environment ? { environment } : {}),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
  }
}

// Discover and merge all Copilot CLI MCP servers visible to the current instance.
// Order (later wins on conflict): ~/.copilot/mcp-config.json -> .github/mcp.json (walked up) -> .vscode/mcp.json (walked up).
// Existing opencode mcp config still wins over these — see the merge site in config.ts.
export const loadMcpServers = Effect.fn("ConfigCopilot.loadMcpServers")(function* (params: {
  home: string
  start: string
  stop: string
}) {
  const afs = yield* AppFileSystem.Service
  const merged: Record<string, ConfigMCP.Info> = {}

  const tryRead = Effect.fn("ConfigCopilot.tryRead")(function* (filepath: string) {
    if (!(yield* afs.existsSafe(filepath))) return
    const text = yield* afs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed("")))
    if (!text) return
    Object.assign(merged, parseMcpFile(text, filepath))
  })

  yield* tryRead(path.join(params.home, ".copilot", "mcp-config.json"))

  const githubDirs = yield* afs
    .up({ targets: [".github"], start: params.start, stop: params.stop })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  for (const dir of githubDirs) {
    yield* tryRead(path.join(dir, "mcp.json"))
  }

  const vscodeDirs = yield* afs
    .up({ targets: [".vscode"], start: params.start, stop: params.stop })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  for (const dir of vscodeDirs) {
    yield* tryRead(path.join(dir, "mcp.json"))
  }

  return merged
})

// Strip .agent.md / .prompt.md double extension; fall back to single extension strip.
function stripCopilotExt(filename: string, expected: ".agent.md" | ".prompt.md"): string {
  if (filename.endsWith(expected)) return filename.slice(0, -expected.length)
  const ext = path.extname(filename)
  return ext.length ? filename.slice(0, -ext.length) : filename
}

// Convert a Copilot agent frontmatter into opencode's AgentSchema shape.
// Differences handled here:
//   - Copilot's tools: string[] allowlist -> opencode tools: Record<string, true> (mapped to permission via existing normalize)
//   - Copilot's model: string[] fallback list -> opencode model: first element only (rest is dropped, lossy)
//   - Copilot's handoffs field is dropped (opencode has no equivalent)
function normalizeCopilotAgentFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data }

  if (Array.isArray(next.tools)) {
    const map: Record<string, boolean> = {}
    for (const tool of next.tools) {
      if (typeof tool === "string") map[tool] = true
    }
    next.tools = map
  }

  if (Array.isArray(next.model)) {
    const first = next.model.find((m): m is string => typeof m === "string")
    if (first) next.model = first
    else delete next.model
  }

  // Drop fields opencode doesn't understand to avoid schema rejection (StructWithRest tolerates them but they're
  // misleading if persisted).
  delete next.handoffs

  return next
}

// Load .github/agents/*.agent.md from a single directory and return them keyed by name.
// Name is the filename minus the .agent.md extension (frontmatter "name" wins if provided).
export async function loadAgents(githubDir: string): Promise<Record<string, ConfigAgent.Info>> {
  const result: Record<string, ConfigAgent.Info> = {}
  const items = await Glob.scan("agents/**/*.agent.md", {
    cwd: githubDir,
    absolute: true,
    dot: true,
    symlink: true,
  })
  for (const item of items) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      log.warn("failed to parse copilot agent", { path: item, error: String(err) })
      return undefined
    })
    if (!md) continue

    const filename = path.basename(item)
    const baseName = stripCopilotExt(filename, ".agent.md")
    const data = isRecord(md.data) ? md.data : {}
    const normalized = normalizeCopilotAgentFrontmatter(data)
    const name = typeof normalized.name === "string" && normalized.name.length > 0 ? normalized.name : baseName

    try {
      const config = {
        ...normalized,
        name,
        prompt: md.content.trim(),
      }
      result[name] = ConfigParse.schema(ConfigAgent.Info, config, item)
    } catch (err) {
      log.warn("failed to validate copilot agent", { path: item, error: String(err) })
    }
  }
  return result
}

// Load .github/prompts/*.prompt.md from a single directory and return them keyed by name as ConfigCommand entries.
// Frontmatter description carries over; the markdown body becomes the command template.
export async function loadPrompts(githubDir: string): Promise<Record<string, ConfigCommand.Info>> {
  const result: Record<string, ConfigCommand.Info> = {}
  const items = await Glob.scan("prompts/**/*.prompt.md", {
    cwd: githubDir,
    absolute: true,
    dot: true,
    symlink: true,
  })
  for (const item of items) {
    const md = await ConfigMarkdown.parse(item).catch((err) => {
      log.warn("failed to parse copilot prompt", { path: item, error: String(err) })
      return undefined
    })
    if (!md) continue

    const filename = path.basename(item)
    const name = stripCopilotExt(filename, ".prompt.md")
    const data = isRecord(md.data) ? md.data : {}

    const config: Record<string, unknown> = {
      template: md.content.trim(),
    }
    if (typeof data.description === "string") config.description = data.description
    if (typeof data.agent === "string") config.agent = data.agent
    if (typeof data.model === "string") config.model = data.model
    else if (Array.isArray(data.model)) {
      const first = data.model.find((m): m is string => typeof m === "string")
      if (first) config.model = first
    }

    try {
      result[name] = ConfigParse.schema(ConfigCommand.Info, config, item)
    } catch (err) {
      log.warn("failed to validate copilot prompt", { path: item, error: String(err) })
    }
  }
  return result
}
