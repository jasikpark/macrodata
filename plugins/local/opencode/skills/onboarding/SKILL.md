---
name: onboarding
description: Guide new users through macrodata setup. Creates identity, human profile, and workspace files. Use when get_context returns isFirstRun true, or user asks to set up their profile.
---

# Onboarding Skill

Guide new users through initial macrodata setup.

## When to Use

- `get_context` returns `isFirstRun: true`
- User explicitly asks to set up or reset their profile
- State files are empty or missing

## Onboarding Flow

### Phase 1: Location

Ask where to store macrodata files. Suggest accessible locations:

1. `~/Documents/macrodata` (easy to find)
2. `~/Repos/macrodata` or `~/code/macrodata` (if they use a code folder)
3. `~/.config/macrodata` (default, hidden)

If they choose a non-default location, write the config to `~/.config/opencode/macrodata.json`:

```json
{
  "root": "/chosen/path"
}
```

Then create the directory structure:
- `<root>/state/`
- `<root>/journal/`
- `<root>/entities/people/`
- `<root>/entities/projects/`
- `<root>/topics/`

### Phase 2: Human Profile

Gather information about the user. Start by detecting what you can from the system:

**Auto-detect from system:**
```bash
# Get system username and full name
whoami
id -F 2>/dev/null || getent passwd $(whoami) | cut -d: -f5 | cut -d, -f1

# Timezone
cat /etc/timezone 2>/dev/null || readlink /etc/localtime | sed 's|.*/zoneinfo/||'

# Git config (name, email)
git config --global user.name
git config --global user.email

# GitHub CLI (if authenticated)
gh api user --jq '.login, .name, .blog' 2>/dev/null
```

**Ask the basics:**
- What should I call you? (confirm or correct auto-detected name)
- What's your GitHub username? (if not detected from gh cli)
- Do you have a website or blog?
- Any social profiles you'd like me to know about?

**Communication style:**
If they consent, analyze their OpenCode session history (`~/.local/share/opencode/storage/`):

```bash
# Extract human messages from OpenCode session history
# Messages are stored in part/ directory, organized by message ID
# User messages have role: "user" in the parent message metadata

# Find recent user message parts
for msg_dir in $(ls -t ~/.local/share/opencode/storage/message/ 2>/dev/null | head -20); do
  # Get message metadata
  cat ~/.local/share/opencode/storage/message/$msg_dir/*.json 2>/dev/null | \
    jq -r 'select(.role == "user") | .id' | while read msg_id; do
      # Get the text parts for this message
      cat ~/.local/share/opencode/storage/part/$msg_id/*.json 2>/dev/null | \
        jq -r 'select(.type == "text" and .synthetic != true) | .text' 2>/dev/null
    done
done | head -200
```

Look for patterns:
- Message length (short/direct vs detailed)
- Tone (casual, formal, technical)
- How they give feedback (direct corrections, suggestions, questions)
- Language preferences (spelling variants, idioms)

**Current work context:**
Analyze recent session history to understand what they're working on:

```bash
# Get recent project directories from OpenCode session storage
ls -t ~/.local/share/opencode/storage/session/ 2>/dev/null | head -10 | while read proj_dir; do
  cat ~/.local/share/opencode/storage/session/$proj_dir/*.json 2>/dev/null | \
    jq -r '.directory, .title' 2>/dev/null
done

# Sample recent conversations for context (last 7 days)
find ~/.local/share/opencode/storage/part -name "*.json" -mtime -7 -exec cat {} \; 2>/dev/null | \
  jq -r 'select(.type == "text" and .synthetic != true) | .text' 2>/dev/null | \
  head -100
```

**Working patterns:**
- Ask about current focus areas (or confirm what you detected)
- Any preferences for how the agent should work?

Write findings to `state/human.md`:

```markdown
# Human Profile

## Basics
- **Name:** [name]
- **GitHub:** [username]
- **Website:** [url if provided]
- **Socials:** [any provided]
- **Timezone:** [detected]

## Communication Style
- [observed patterns from analysis]
- [stated preferences]

## Working Patterns
- [current focus areas]
- [preferences]

## Current Projects
- [detected from recent sessions]

## Pending Items
- [empty initially]
```

### Phase 3: Agent Identity

Help define who the agent should be:

**Name and persona:**
- What should the agent be called?
- What's its role? (assistant, partner, specialist)
- Any personality traits?

**Values and patterns:**
- What behaviors should it prioritize?
- How proactive should it be?

Write to `identity.md`:

```markdown
# [Agent Name] Identity

## Persona
[Description of who the agent is, its role, personality]

## Values
- [core value 1]
- [core value 2]

## Patterns
- [behavioral pattern 1]
- [behavioral pattern 2]
```

### Phase 4: Initial Workspace

Set up working context:

1. Ask what they're currently working on
2. Create initial project files in `entities/projects/`
3. Write `state/today.md` with current context
4. Write `state/workspace.md` with active projects

```markdown
# Today

## Now
[Current context from conversation]

## Context
[Background information]
```

```markdown
# Workspace

## Active Projects
- [project 1] - [brief description]

## Open Threads
- [things in progress]
```

### Phase 5: Finalize

1. Rebuild the memory index with `rebuild_memory_index`
2. Log completion to journal
3. Summarize what was created
4. Suggest next steps

## Session History Analysis

If the user consents, analyze their OpenCode history for context:

**Context to extract:**
- Recent project directories they've been working in
- Common file types and technologies
- Recurring themes or topics

## Example Conversation

**Agent:** Welcome to macrodata! Let's get you set up.

First, where would you like me to store your memory files?
1. `~/Documents/macrodata` (easy to find in Finder)
2. `~/Repos/macrodata` (with your code)
3. `~/.config/macrodata` (hidden, default)

**User:** Documents is fine

**Agent:** Got it. Now, what should I call you?

**User:** Matt

**Agent:** I can see from your system that you're [name from git config], GitHub username [from gh cli], and you're in the [timezone] timezone. Is that right?

**User:** Yeah

**Agent:** Do you have a website or any social profiles you'd like me to know about?

**User:** My blog is example.com

**Agent:** Got it. Would you like me to analyze your OpenCode session history to understand your communication style and what you've been working on? I'll look at things like how you communicate and recent projects. This stays completely local.

**User:** Sure

**Agent:** [runs analysis, summarizes findings]

Looking at your history, I can see you communicate in short, direct messages, give quick acknowledgments, and tend to ask questions before committing to an approach. You've been working on [detected projects] recently.

Now, what would you like to call your agent?

[continues through flow...]
