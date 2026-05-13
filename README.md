# pi-claude-compat

**Claude CLI compatibility layer for pi — load `.claude/commands` and `.claude/skills` as native pi resources**

Automatically discovers commands and skills from your project's `.claude/` directory and registers them as native pi resources:

- `.claude/commands/**/*.md` → pi slash commands (`/test`, `/xyz:test1`)
- `.claude/skills/*/SKILL.md` → pi skills (`/skill:my-skill`)

Also discovers skills from `.agents/skills/` and `.pi/skills/` in your project root (with `.claude/skills/` taking priority on name collisions).

## Install

```bash
pi install npm:pi-claude-compat
```

Or from git:

```bash
pi install git:github.com/Entelligentsia/pi-claude-compat
```

Then `/reload` in pi.

## How It Works

### Commands

On session start (and whenever you switch sessions), the extension scans `.claude/commands/**/*.md` in your current working directory and registers each file as a pi slash command:

| File | Command |
|------|---------|
| `.claude/commands/test.md` | `/test` |
| `.claude/commands/xyz/test1.md` | `/xyz:test1` |
| `.claude/commands/deploy/staging.md` | `/deploy:staging` |

### Skills

The extension also discovers skill directories containing `SKILL.md` and registers them via pi's `resources_discover` mechanism, making them available as `/skill:name` commands:

| Directory | Command |
|-----------|---------|
| `.claude/skills/search/SKILL.md` | `/skill:search` |
| `.claude/skills/deploy/SKILL.md` | `/skill:deploy` |

Skill directories are scanned in priority order (first match wins on name collisions):

1. `.claude/skills/`
2. `.agents/skills/`
3. `.pi/skills/`

### Command Discovery Rules

- Only `.md` files are discovered as commands
- Root-level files → command name = filename without `.md`
- Nested directories → command name = `dir:subdir:filename` (Claude CLI convention using `:` separator)
- Files are sorted alphabetically for deterministic ordering

### Invoking Commands

Once loaded, just type the command name like any pi slash command:

```
/test                    # sends content of test.md
/test my arguments       # sends content with $ARGUMENTS replaced
/deploy:staging          # sends content of deploy/staging.md
/skill:search            # invokes the search skill (registered natively by pi)
```

### $ARGUMENTS Placeholder

Command files support the `$ARGUMENTS` placeholder (Claude CLI convention):

```markdown
# .claude/commands/commit.md
---
description: Generate a commit message for staged changes
---

Write a concise commit message for the staged changes. Focus on: $ARGUMENTS
```

When invoked as `/commit breaking API changes`, the `$ARGUMENTS` placeholder is replaced with `breaking API changes`. If no arguments are provided, the placeholder is removed.

Multiple placeholder formats are supported:
- `$ARGUMENTS` — Claude CLI convention
- `${ARGUMENTS}` — alternative bracket form
- `{{ARGUMENTS}}` — Mustache-style

If a command file has **no** `$ARGUMENTS` placeholder but arguments are provided, they're appended to the end of the content.

### YAML Frontmatter

Command files support YAML frontmatter for descriptions:

```markdown
---
description: Generate a commit message for staged changes
---

Write a concise commit message for the staged changes.
```

The `description` field appears in the `/` command dropdown and in the system prompt.

## Commands

| Command | Description |
|---------|-------------|
| `/claude-commands` | List all loaded Claude custom commands and skills |
| `/<command-name>` | Any discovered command (e.g. `/test`, `/xyz:test1`) |

## System Prompt Injection

When commands or skills are loaded, the extension injects a section into the system prompt listing all available resources. This ensures the agent is aware of the commands and can suggest them to the user.

## Widget

When resources are loaded, a widget appears above the editor:

```
⚡ 3 cmds │ 🛠 2 skills │ /test /review /deploy /skill:search
```

## Reloading

To pick up new or changed commands/skills after editing files:

```
/reload
```

## Example Setup

### Commands

```bash
# Create the commands directory
mkdir -p .claude/commands

# Create a simple command
cat > .claude/commands/review.md << 'EOF'
---
description: Code review focused on specific areas
---

Review the code for $ARGUMENTS. Look for bugs, performance issues, and suggest improvements.
EOF

# Create a nested command
mkdir -p .claude/commands/deploy
cat > .claude/commands/deploy/staging.md << 'EOF'
---
description: Deploy to staging environment
---

Deploy the current branch to the staging environment. Run all tests first.
EOF
```

### Skills

```bash
# Create a skill directory with SKILL.md
mkdir -p .claude/skills/search
cat > .claude/skills/search/SKILL.md << 'EOF'
---
name: search
description: Search the web for information using Brave Search API
---

# Web Search

Use the Brave Search API to find information on the web.

## Usage

\`\`\`bash
curl -s "https://api.search.brave.com/res/v1/web/search?q=$ARGUMENTS" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"
\`\`\`
EOF
```

After `/reload`, `/review`, `/deploy:staging`, and `/skill:search` are all available.

## How It Works Internally

```
+-------------------------------------------------------------+
|  pi session (cwd: /my-project)                              |
|                                                             |
|  .claude/commands/                                          |
|  +-- test.md       -> registered as /test                   |
|  +-- review.md     -> registered as /review                 |
|  +-- deploy/                                                |
|      +-- staging.md -> registered as /deploy:staging       |
|                                                             |
|  .claude/skills/                                            |
|  +-- search/                                                |
|      +-- SKILL.md  -> registered as /skill:search          |
|                                                             |
|  resources_discover -> scan & register commands + skills    |
|  session_start     -> rescan & sync                         |
|  session_switch    -> rescan & sync                         |
|  before_agent_start -> inject command/skill list into prompt|
|                                                             |
|  /test my args                                              |
|     |                                                       |
|     +-- Re-read test.md from disk                           |
|     +-- Replace $ARGUMENTS with "my args"                   |
|     +-- Send as user message to the agent                   |
+-------------------------------------------------------------+
```

## License

MIT