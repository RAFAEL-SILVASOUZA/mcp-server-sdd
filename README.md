# mcp-server-sdd

> MCP server for **Spec-Driven Development (SDD)** — enforce a spec-first workflow on any AI agent with a real-time Kanban dashboard.

No implementation line is written before a complete, approved spec exists. The agent executes tasks. The human approves, rejects, and verifies.

Works with **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, and any MCP-compatible client.

---

## How it works

The agent is forced to follow a strict order:

1. **`start_server`** — starts the dashboard and opens it in the browser
2. **`sdd_docs`** — reads the full methodology guide
3. **`create_task`** — creates a task with a complete spec (all fields required)
4. Work through the cycle: `in-progress` → `pending-verification` → `done`

Any tool called before `start_server` returns an error with the required order. There is no way to skip steps.

---

## Installation

### Claude Code (recommended)

```bash
claude mcp add sdd npx -- -y @rafaelsouza-ai/mcp-server-sdd
```

### Manual — `.claude/settings.json` or `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"]
    }
  }
}
```

### Configuring the database location

The SQLite database (`sdd.db`) is stored in the directory defined by the `WORKSPACE_PATH` environment variable. If not set, it defaults to the current working directory (`process.cwd()`).

Set `WORKSPACE_PATH` to keep the database alongside your project:

```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"],
      "env": {
        "WORKSPACE_PATH": "/path/to/your/project"
      }
    }
  }
}
```

**Windows example:**
```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"],
      "env": {
        "WORKSPACE_PATH": "C:\\Users\\you\\projects\\my-app"
      }
    }
  }
}
```

> Without `WORKSPACE_PATH`, a new `sdd.db` is created wherever the process runs — usually a temporary npx cache directory. Set it explicitly so your tasks persist across sessions.

---

## Dashboard

Once `start_server` is called, a real-time Kanban board opens automatically in the browser at `http://localhost:3000`.

- **Drag cards between columns** to update task status
- **Double-click a card** to open the full edit modal
- All changes made by the agent are reflected in real time via WebSocket

---

## Available tools

| Tool | Description |
|---|---|
| `start_server` | **FIRST** — starts the dashboard and opens the browser |
| `sdd_docs` | **SECOND** — returns the full methodology guide |
| `create_task` | Creates a task with complete spec (all fields required) |
| `read_task` | Reads full task details including logs and criteria |
| `update_task` | Updates status or adds a log entry |
| `list_tasks` | Lists all tasks, optionally filtered by status |
| `delete_task` | Deletes a task (only allowed when status is `open`) |
| `add_task_log` | Adds a progress log entry to a task |
| `read_task_logs` | Reads the full history log of a task |
| `add_acceptance_criterion` | Adds a new acceptance criterion to a task |
| `list_criteria` | Lists all acceptance criteria for a task |
| `submit_task_evidence` | Marks implementation complete, moves to `pending-verification` |
| `verify_task_criterion` | Records pass/fail verdict for a criterion |

---

## Task lifecycle

```
open → in-progress                   (agent starts)
in-progress → pending-verification   (agent delivers via submit_task_evidence)
pending-verification → done          (human approves)
pending-verification → in-progress   (human rejects, returns for correction)
pending-verification → error         (human marks as error)
any → open                           (reset, with justification in the log)
```

---

## Rules enforced by the server

- Every tool call is blocked until `start_server` has been called
- `sdd_docs` is blocked until `start_server` has been called
- `delete_task` only works on tasks with status `open`

---

## Requirements

- Node.js 18+
- The dashboard opens on `localhost:3000` (auto-increments if the port is busy)

---

## License

MIT
