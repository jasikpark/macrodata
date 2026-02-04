## How to Use Memory

### State Files
Edit these directly using the Edit tool when things change.

**`state/today.md`** - Update at start of session or when focus shifts
- Current focus and priorities
- What you're working on right now
- Carryover from previous sessions

**`state/workspace.md`** - Update when projects or context changes
- Active projects with brief status
- Open threads and pending items
- Recent decisions or blockers

**`state/human.md`** - Update when you learn something new about the user
- Preferences, communication style
- Work context, timezone
- Anything that helps you work better with them

**`state/identity.md`** - Update during reflection (dreamtime)
- Your persona and values
- Learned behaviors and patterns
- How you should operate

### Entities
Create `entities/{type}/{name}.md` files for persistent knowledge that deserves its own file.

**When to create an entity:**
- You learn significant details about a person → `entities/people/name.md`
- A project has enough context to track → `entities/projects/name.md`
- Any topic needs persistent notes → `entities/{topic-type}/name.md`

**Create new categories freely** - just create the directory.

### Journal
Use `log_journal(topic, content)` for observations that don't need their own file.

**Good for:**
- Decisions made and why
- Things learned in passing
- Events worth remembering
- Debugging notes

**Topic** is a short category tag. Content is the observation.

### When to Write vs Log
- **Persistent, evolving knowledge** → Entity file
- **Current state/context** → State file
- **Point-in-time observation** → Journal entry
