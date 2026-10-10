# Index Configuration

> Configuration for project-indexer. Edit this file to customize index generation.

## Excluded Directories

Directories to skip during indexing:

- node_modules
- .git
- dist
- build
- __pycache__
- .venv
- venv
- vendor
- coverage
- .next
- .nuxt
- .cache
- target
- bin
- obj
- .idea
- .vscode

## Priority Directories

Directories to index in detail (leave empty for auto-detection):

- src/
- lib/
- app/
- core/

## Tech Stack

Detected or specified technology stack:

- **Frontend:** {React | Vue | Angular | Svelte | Next.js | Nuxt | etc.}
- **Backend:** {Express | FastAPI | Django | Rails | Spring | etc.}
- **Language:** {TypeScript | JavaScript | Python | Go | etc.}

## Index Settings

- **Generated:** {YYYY-MM-DD HH:MM:SS}
- **Project Root:** {/path/to/project}
- **Index Version:** 1.0
- **Total Files Indexed:** {N}
- **Total Symbols Extracted:** {N}

## Clean Code Settings

- Enabled: {Yes | No}
- Preset: {strict | relaxed | custom | disabled}
- MAX_FILE_LINES: 1000
- MAX_METHOD_LINES: 60
- MAX_FUNCTION_PARAMS: 5
- MAX_CYCLOMATIC: 10
- MAX_LINE_LENGTH: 100
- MAX_NESTING_DEPTH: 4

## Regeneration Notes

Notes for future regeneration:

- {Any special considerations}
- {Files that need manual review}
- {Known limitations}
