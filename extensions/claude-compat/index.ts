// claude-compat -- Claude CLI compatibility layer for pi.
//
// Discovers:
//   .claude/commands/**/*.md     -> registered as pi slash commands
//     .claude/commands/test.md       -> /test
//     .claude/commands/xyz/test1.md  -> /xyz:test1
//   .claude/skills/*/SKILL.md    -> registered as pi skills via resources_discover
//     .claude/skills/my-skill/       -> /skill:my-skill
//
// Commands are re-discovered on session start, switch, fork, and tree
// navigation so they stay current when changing projects.
//
// Features:
//   - Automatic discovery of Claude custom commands and skills
//   - $ARGUMENTS / ${ARGUMENTS} / {{ARGUMENTS}} placeholder replacement
//   - YAML frontmatter support for descriptions
//   - Collision detection with other extensions' commands
//   - /claude-commands command to list all loaded commands
//   - Widget showing active command and skill count
//   - System prompt injection listing available commands and skills

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeCommand {
  /** Command name as it appears in the pi dropdown, e.g. "test" or "xyz:test1" */
  name: string;
  /** Relative path from .claude/commands/, e.g. "test.md" or "xyz/test1.md" */
  relativePath: string;
  /** Description extracted from frontmatter or content */
  description: string;
}

interface ClaudeSkill {
  /** Skill name (directory name) */
  name: string;
  /** Absolute path to the SKILL.md file */
  skillMdPath: string;
  /** Absolute path to the skill directory */
  dirPath: string;
  /** Description extracted from SKILL.md frontmatter */
  description: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMANDS_SUBDIR = path.join(".claude", "commands");
const STATE_ENTRY_TYPE = "claude-compat:state";

// Directories where skills live, relative to a project root.
// Ordered by priority: .claude first since that is what this extension is about.
const SKILL_DIRS = [
  ".claude/skills",
  ".agents/skills",
  ".pi/skills",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively discover all `.md` files under the commands directory,
 * computing command names that follow Claude CLI's convention.
 *
 *   Root-level files:     basename without .md -> "test"
 *   Nested files:         path segments joined by ":" -> "xyz:test1"
 */
function discoverCommands(cwd: string): ClaudeCommand[] {
  const commandsDir = path.join(cwd, COMMANDS_SUBDIR);
  if (!dirExists(commandsDir)) return [];

  const commands: ClaudeCommand[] = [];

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nestedPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        walk(path.join(dir, entry.name), nestedPrefix);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const baseName = entry.name.slice(0, -3);
        const commandName = prefix ? `${prefix}:${baseName}` : baseName;
        const dirPart = prefix ? prefix.replace(/:/g, path.sep) : "";
        const relativePath = dirPart ? path.join(dirPart, entry.name) : entry.name;
        const absolutePath = path.join(dir, entry.name);

        const content = readFileSafe(absolutePath);
        if (content === null) continue;

        const description = extractDescription(content, commandName);
        commands.push({ name: commandName, relativePath, description });
      }
    }
  }

  walk(commandsDir, "");
  return commands;
}

/**
 * Discover Agent Skills directories in the project.
 *
 * Scans `.claude/skills/`, `.agents/skills/`, and `.pi/skills/`
 * for directories containing `SKILL.md`. First match wins on name collisions.
 */
function discoverSkills(cwd: string): ClaudeSkill[] {
  const skills: ClaudeSkill[] = [];
  const seen = new Set<string>();

  for (const skillDir of SKILL_DIRS) {
    const fullSkillDir = path.join(cwd, skillDir);
    if (!dirExists(fullSkillDir)) continue;

    try {
      const entries = fs.readdirSync(fullSkillDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (seen.has(entry.name)) continue;

        const skillMdPath = path.join(fullSkillDir, entry.name, "SKILL.md");
        const content = readFileSafe(skillMdPath);
        if (content === null) continue;

        seen.add(entry.name);
        const description = extractDescription(content, entry.name);
        skills.push({
          name: entry.name,
          skillMdPath,
          dirPath: path.join(fullSkillDir, entry.name),
          description,
        });
      }
    } catch {
      // Skip unreadable directories
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Reconstruct a command's absolute file path from its name and cwd.
 */
function resolveCommandPath(cwd: string, commandName: string): string {
  const parts = commandName.split(":");
  const fileName = parts.pop()! + ".md";
  return path.join(cwd, COMMANDS_SUBDIR, ...parts, fileName);
}

/** Read a file safely, returning null on error. */
function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Check if a path is an existing directory. */
function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Extract a description for a command or skill from its content.
 *
 * Priority: frontmatter description > first heading > first content line > fallback
 */
function extractDescription(content: string, fallbackName: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const frontmatter = fmMatch[1];
    const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) {
      return descMatch[1].trim();
    }
  }

  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

  const headingMatch = body.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("<!--")) {
      return trimmed.length > 100 ? trimmed.slice(0, 100) + "..." : trimmed;
    }
  }

  return `Claude command: /${fallbackName}`;
}

/**
 * Safe string replacement that doesn't interpret $-patterns in the replacement.
 */
function safeReplace(str: string, search: RegExp, replacement: string): string {
  return str.replace(search, () => replacement);
}

/**
 * Read a command's content and process it for use as a prompt.
 *
 * - Replaces $ARGUMENTS / ${ARGUMENTS} / {{ARGUMENTS}} before frontmatter stripping
 * - Strips YAML frontmatter
 * - If no placeholder found and args provided, appends them as fallback
 */
function loadCommandContent(cwd: string, commandName: string, args?: string): string | null {
  const filePath = resolveCommandPath(cwd, commandName);
  const content = readFileSafe(filePath);
  if (content === null) return null;

  const hasArgs = args && args.trim();
  const trimmedArgs = hasArgs ? args!.trim() : "";

  let processed = content;
  const hasPlaceholder = /\$ARGUMENTS|\$\{ARGUMENTS\}|\{\{ARGUMENTS\}\}/.test(content);

  if (hasArgs) {
    processed = safeReplace(processed, /\$\{ARGUMENTS\}|\$ARGUMENTS/g, trimmedArgs);
    processed = safeReplace(processed, /\{\{ARGUMENTS\}\}/g, trimmedArgs);
  } else {
    processed = processed
      .replace(/\s*\$\{ARGUMENTS\}\s*/g, " ")
      .replace(/\s*\$ARGUMENTS\s*/g, " ")
      .replace(/\s*\{\{ARGUMENTS\}\}\s*/g, " ")
      .replace(/  +/g, " ");
  }

  const body = processed.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();

  if (hasArgs && !hasPlaceholder) {
    return `${body}\n\n${trimmedArgs}`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function claudeEnvLoaderExtension(pi: ExtensionAPI) {
  const registeredCommands = new Set<string>();

  // Commands skipped due to name collisions with other extensions.
  // Key: command name, Value: source that owns it.
  const collisions = new Map<string, string>();

  let currentCwd = "";
  let currentCommands: ClaudeCommand[] = [];
  let currentSkills: ClaudeSkill[] = [];

  // -----------------------------------------------------------------------
  // Core: discover & register commands and skills
  // -----------------------------------------------------------------------

  function syncResources(ctx: ExtensionContext): void {
    currentCwd = ctx.cwd;
    currentCommands = discoverCommands(ctx.cwd);
    currentSkills = discoverSkills(ctx.cwd);
    collisions.clear();

    // Get existing command names from other extensions/builtins
    const existingCommands = new Map<string, string>();
    for (const cmd of pi.getCommands()) {
      existingCommands.set(cmd.name, cmd.sourceInfo?.source ?? "unknown");
    }

    // Register commands that haven't been registered yet, checking collisions
    for (const cmd of currentCommands) {
      if (registeredCommands.has(cmd.name)) {
        // Already registered by us in a previous session/cwd -- no collision
        continue;
      }

      const existing = existingCommands.get(cmd.name);
      if (existing !== undefined) {
        // Another extension or builtin already owns this command name
        collisions.set(cmd.name, existing);
        continue;
      }

      registerCommand(cmd);
    }

    updateWidget(ctx);
  }

  function registerCommand(cmd: ClaudeCommand): void {
    pi.registerCommand(cmd.name, {
      description: cmd.description,
      handler: async (args, ctx) => {
        const content = loadCommandContent(ctx.cwd, cmd.name, args);

        if (content === null) {
          ctx.ui.notify(
            `Command file not found: .claude/commands/${cmd.relativePath}\n` +
            `This command may belong to a different project. Run /claude-commands to see available commands.`,
            "error",
          );
          return;
        }

        if (!content.trim()) {
          ctx.ui.notify(
            `Command file is empty: .claude/commands/${cmd.relativePath}`,
            "warning",
          );
          return;
        }

        pi.sendUserMessage(content);
      },
    });

    registeredCommands.add(cmd.name);
  }

  // -----------------------------------------------------------------------
  // State persistence
  // -----------------------------------------------------------------------

  function reconstructState(ctx: ExtensionContext): void {
    currentCwd = ctx.cwd;
    currentCommands = [];
    currentSkills = [];

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as
          | { commands?: ClaudeCommand[]; skills?: ClaudeSkill[]; cwd?: string }
          | undefined;
        if (data?.commands) currentCommands = data.commands;
        if (data?.skills) currentSkills = data.skills;
      }
    }

    syncResources(ctx);
    persistState();
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY_TYPE, {
      commands: currentCommands,
      skills: currentSkills,
      cwd: currentCwd,
    });
  }

  // -----------------------------------------------------------------------
  // Widget
  // -----------------------------------------------------------------------

  function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    const totalItems = currentCommands.length + currentSkills.length;

    if (totalItems === 0 && collisions.size === 0) {
      ctx.ui.setWidget("claude-compat", undefined);
      return;
    }

    ctx.ui.setWidget("claude-compat", (_tui, theme) => {
      return {
        dispose() {},
        invalidate() {},
        render(width: number): string[] {
          const parts: string[] = [];

          if (currentCommands.length > 0) {
            const prefix = theme.fg("accent", "⚡");
            const cmdCount = theme.fg("muted", `${currentCommands.length} cmd${currentCommands.length === 1 ? "" : "s"}`);
            parts.push(`${prefix}${cmdCount}`);
          }

          if (currentSkills.length > 0) {
            const skillPrefix = theme.fg("accent", "🛠");
            const skillCount = theme.fg("muted", `${currentSkills.length} skill${currentSkills.length === 1 ? "" : "s"}`);
            parts.push(`${skillPrefix}${skillCount}`);
          }

          if (collisions.size > 0) {
            const warnPrefix = theme.fg("warning", "⚠");
            const warnCount = theme.fg("muted", `${collisions.size} conflict${collisions.size === 1 ? "" : "s"}`);
            parts.push(`${warnPrefix}${warnCount}`);
          }

          if (parts.length === 0) return [""];

          const sep = theme.fg("dim", " │ ");
          return [` ${parts.join(sep)}`];
        },
      };
    });
  }

  // -----------------------------------------------------------------------
  // Resources discovery
  // -----------------------------------------------------------------------

  pi.on("resources_discover", (event) => {
    const commands = discoverCommands(event.cwd);
    const skills = discoverSkills(event.cwd);
    const skillPaths = skills.map(s => s.skillMdPath);

    currentCwd = event.cwd;
    currentCommands = commands;
    currentSkills = skills;
    collisions.clear();

    // Get existing command names from other extensions/builtins
    const existingCommands = new Map<string, string>();
    for (const cmd of pi.getCommands()) {
      existingCommands.set(cmd.name, cmd.sourceInfo?.source ?? "unknown");
    }

    // Register commands, checking collisions
    for (const cmd of commands) {
      if (registeredCommands.has(cmd.name)) continue;

      const existing = existingCommands.get(cmd.name);
      if (existing !== undefined) {
        collisions.set(cmd.name, existing);
        continue;
      }

      registerCommand(cmd);
    }

    if (skillPaths.length > 0) {
      return { skillPaths };
    }

    return undefined;
  });

  // -----------------------------------------------------------------------
  // Session events
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => { reconstructState(ctx); });
  pi.on("session_switch", async (_e, ctx) => { reconstructState(ctx); });
  pi.on("session_fork", async (_e, ctx) => { reconstructState(ctx); });
  pi.on("session_tree", async (_e, ctx) => { reconstructState(ctx); });

  // -----------------------------------------------------------------------
  // System prompt injection
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", (event) => {
    if (currentCommands.length === 0 && currentSkills.length === 0 && collisions.size === 0) return;

    const sections: string[] = [];

    if (currentCommands.length > 0) {
      const commandList = currentCommands
        .map(cmd => {
          const suffix = collisions.has(cmd.name) ? ` [CONFLICT with ${collisions.get(cmd.name)}]` : "";
          return `- \`/${cmd.name}\`: ${cmd.description}${suffix}`;
        })
        .join("\n");

      sections.push(
        "## Claude Custom Commands\n" +
        "The following Claude CLI custom commands are loaded:\n\n" +
        `${commandList}\n\n` +
        "Use `/commandname` to invoke a command (e.g. `/test`, `/xyz:test1`). " +
        "Pass arguments after the command name, e.g. `/test my arguments`. " +
        "The `$ARGUMENTS` placeholder in command files will be replaced with the provided arguments.",
      );
    }

    if (collisions.size > 0) {
      const collisionList = [...collisions.entries()]
        .map(([name, source]) => `- \`/${name}\`: already registered by ${source}`)
        .join("\n");

      sections.push(
        "## Command Name Collisions\n" +
        "The following Claude command names conflict with existing commands and were not registered:\n\n" +
        `${collisionList}\n\n` +
        "Rename the .md file or move it to a subdirectory to change the command name. " +
        'For example, rename "test.md" to "mytest.md" to get `/mytest` instead of `/test`.',
      );
    }

    if (currentSkills.length > 0) {
      const skillList = currentSkills
        .map(s => `- \`/skill:${s.name}\`: ${s.description} (${s.dirPath})`)
        .join("\n");

      sections.push(
        "## Claude Custom Skills\n" +
        "The following skills are available as pi slash commands:\n\n" +
        `${skillList}\n\n` +
        "Use `/skill:name` to invoke a skill. " +
        "Skills are also discoverable by the agent.",
      );
    }

    return {
      systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n"),
    };
  });

  // -----------------------------------------------------------------------
  // /claude-commands command
  // -----------------------------------------------------------------------

  pi.registerCommand("claude-commands", {
    description: "List all loaded Claude CLI custom slash commands and skills",
    handler: async (_args, ctx) => {
      const commands = discoverCommands(ctx.cwd);
      const skills = discoverSkills(ctx.cwd);

      if (commands.length === 0 && skills.length === 0 && collisions.size === 0) {
        const hasClaudeDir = dirExists(path.join(ctx.cwd, ".claude"));
        if (hasClaudeDir) {
          ctx.ui.notify(
            "No commands or skills found in .claude/commands/ or .claude/skills/.\n" +
            "Create .md files in commands/ or skill dirs with SKILL.md to add them.",
            "info",
          );
        } else {
          ctx.ui.notify(
            "No .claude directory found.\n" +
            "Create it with: mkdir -p .claude/commands .claude/skills\n" +
            "Add .md files as commands or skill dirs with SKILL.md.",
            "info",
          );
        }
        return;
      }

      const lines: string[] = [];

      if (commands.length > 0) {
        lines.push(`Commands (${commands.length}):\n`);
        for (const cmd of commands) {
          const collision = collisions.get(cmd.name);
          const collisionNote = collision ? ` [CONFLICT with ${collision}]` : "";
          lines.push(`  /${cmd.name}${collisionNote}`);
          lines.push(`    ${path.join(COMMANDS_SUBDIR, cmd.relativePath)}`);
          if (cmd.description) {
            lines.push(`    ${cmd.description}`);
          }
          lines.push("");
        }
        lines.push("Usage: /<command-name> [arguments]");
        lines.push("$ARGUMENTS in command files is replaced by the provided arguments.\n");
      }

      if (collisions.size > 0) {
        lines.push(`Collisions (${collisions.size}):\n`);
        for (const [name, source] of collisions) {
          lines.push(`  /${name} - already registered by ${source}`);
        }
        lines.push("\nRename the .md file or move it to a subdirectory to avoid conflicts.");
        lines.push('e.g., rename "test.md" to "mytest.md" to get /mytest instead of /test.\n');
      }

      if (skills.length > 0) {
        lines.push(`Skills (${skills.length}):\n`);
        for (const skill of skills) {
          lines.push(`  /skill:${skill.name}`);
          lines.push(`    ${skill.skillMdPath}`);
          if (skill.description) {
            lines.push(`    ${skill.description}`);
          }
          lines.push("");
        }
        lines.push("Skills are invoked with /skill:<name> or used automatically by the agent.");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}