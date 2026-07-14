---
name: obsidian-vault-manager
description: Push notes, architecture docs, project plans, and daily notes to the Obsidian vault via notesmd-cli. Use when user says "save to obsidian", "push to vault", "create obsidian note", "obsidian daily", "add to vault", "save note", "document this in obsidian", "obsidian architecture", or when completing project milestones that should be documented. Also triggers on "open in obsidian", "vault search", or any reference to the Obsidian vault. Do NOT use for general file creation unrelated to knowledge management.
---

# Obsidian Vault Manager

Manage the user's Obsidian vault via `notesmd-cli` CLI tool on the local machine using `mcp-server-commands`.

## Environment

- **CLI:** `notesmd-cli` v0.3.1 at `/opt/homebrew/bin/notesmd-cli`
- **Vault:** "Obsidian Vault" (default, already configured)
- **Path:** `/Users/supabowl/Library/Mobile Documents/com~apple~CloudDocs/BHT Promo iCloud/Organized AI/Obsidian Vault`
- **Syncs via:** iCloud (available on all Apple devices)
- **Tool:** Always use `mcp-server-commands:run_process` with `mode: "shell"`

## Vault Structure

```
Obsidian Vault/
├── Architecture/       # System diagrams, mermaid, technical docs
├── Attachments/        # Images, PDFs, linked files
├── Content/            # Blog posts, newsletters, social content
├── Daily Notes/        # Daily journal entries
├── Planning/           # Project plans, phase docs, roadmaps
└── Templates/          # Reusable note templates
```

## Core Operations

### Create a Note

```bash
notesmd-cli create "FOLDER/note-name.md" --content "CONTENT"
```

For multi-line content, write to file first then use the vault path directly:

```bash
cat > "/Users/supabowl/Library/Mobile Documents/com~apple~CloudDocs/BHT Promo iCloud/Organized AI/Obsidian Vault/FOLDER/note-name.md" << 'EOF'
---
title: Note Title
date: YYYY-MM-DD
tags: [tag1, tag2]
project: project-name
---

# Note Title

Content here...
EOF
```

### Open in Obsidian

```bash
notesmd-cli open "note-name"
notesmd-cli open "note-name" --vault "Obsidian Vault"
```

### Daily Note

```bash
notesmd-cli daily
```

### Search

```bash
notesmd-cli search                          # Fuzzy title search
notesmd-cli search-content "search term"    # Content search
```

### List / Print

```bash
notesmd-cli list                    # Root
notesmd-cli list "Architecture"     # Subfolder
notesmd-cli print "note-name"       # Print contents
```

### Move / Delete

```bash
notesmd-cli move "old-name.md" "new-name.md"    # Auto-updates links
notesmd-cli delete "note-name"
```

### Frontmatter

```bash
notesmd-cli frontmatter "note-name" --print
notesmd-cli frontmatter "note-name" --edit --key "status" --value "complete"
notesmd-cli frontmatter "note-name" --delete --key "draft"
```

## Folder Routing Rules

Route notes to the correct folder based on content type:

| Content Type | Folder | Example |
|-------------|--------|---------|
| System architecture, diagrams, technical docs | `Architecture/` | Fleet Status Fast v2 architecture |
| Mermaid diagrams (.mermaid or embedded) | `Architecture/` | Sequence diagrams, flowcharts |
| Blog posts, newsletters, social media drafts | `Content/` | LinkedIn posts, newsletter drafts |
| Project plans, phase prompts, roadmaps | `Planning/` | Implementation master plans |
| Daily journals, standups, EOD checkpoints | `Daily Notes/` | Daily checkpoint notes |
| Images, PDFs, non-markdown attachments | `Attachments/` | Screenshots, exported PDFs |
| Reusable templates | `Templates/` | Project template, daily template |

## Frontmatter Standard

Every note should include YAML frontmatter:

```yaml
---
title: Descriptive Title
date: 2026-02-28
tags: [project-name, category]
project: project-slug
status: draft | active | complete | archived
---
```

## Multi-File Push Pattern

When saving multiple related files (e.g., project plan + architecture + phase prompts):

```bash
VAULT="/Users/supabowl/Library/Mobile Documents/com~apple~CloudDocs/BHT Promo iCloud/Organized AI/Obsidian Vault"

# Create subfolder if needed
mkdir -p "$VAULT/Planning/fleet-status-fast-v2"

# Write each file
cat > "$VAULT/Planning/fleet-status-fast-v2/master-plan.md" << 'EOF'
---
title: Fleet Status Fast v2 Master Plan
date: 2026-02-28
tags: [fleet-status, openclaw, infrastructure]
project: fleet-status-fast-v2
status: active
---

Content...
EOF
```

## Linking Notes

Use Obsidian wiki-link syntax for cross-references:

```markdown
See [[Architecture/fleet-status-fast-v2-architecture]] for the system diagram.
Related: [[Planning/fleet-status-fast-v2/master-plan]]
```

## When to Auto-Push

After completing significant work, proactively ask the user:
> "Would you like me to save this to your Obsidian vault?"

Triggers for auto-suggesting:
- Architecture diagrams or mermaid files created
- Project plans or phase docs finalized
- Daily checkpoint completed
- Newsletter or content drafted
- Implementation milestone reached
