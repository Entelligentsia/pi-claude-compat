# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-05-13

### Added

- Discover `.claude/commands/**/*.md` and register as pi slash commands
- Discover `.claude/skills/*/SKILL.md` and register via `resources_discover`
- Also discover skills from `.agents/skills/` and `.pi/skills/` (with `.claude/skills/` priority)
- Support `$ARGUMENTS`, `${ARGUMENTS}`, and `{{ARGUMENTS}}` placeholder replacement
- Support YAML frontmatter `description` field for command descriptions
- Nested directory command naming with `:` separator (Claude CLI convention)
- `/claude-commands` command to list all loaded commands and skills
- Widget showing active command and skill count
- System prompt injection listing available commands and skills
- Collision detection with other extensions' commands
- Automatic re-discovery on session start, switch, fork, and tree navigation
- Session state persistence for commands and skills across reloads