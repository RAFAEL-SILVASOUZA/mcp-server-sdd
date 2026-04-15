# mcp-server-sdd

> MCP server for **Spec-Driven Development (SDD)** — enforce a spec-first, three-level hierarchy on any AI agent with a real-time dashboard.

No implementation line is written before a complete, approved spec exists. The agent executes tasks. The human approves, rejects, and verifies.

Works with **Claude Code**, **Claude Desktop**, **Cursor**, **Windsurf**, and any MCP-compatible client.

---

## How it works

SDD organizes work in three levels:

```
Spec  →  Plan  →  Task
(what & why)  (how, in phases)  (unit of execution)
```

- **Spec** — the strategic parent. Defines what will be built and why. Must be approved before work begins.
- **Plan** — a tactical phase inside a spec. Groups related tasks into ordered steps. Status is computed automatically from its tasks.
- **Task** — the unit of execution. Has full spec (inputs, outputs, acceptance criteria), logs, and a verification cycle.

The agent follows a strict order:

1. **`start_server`** — starts the dashboard and opens it in the browser (skip if `AUTOOPENPANEL=true`)
2. **`sdd_docs`** — reads the full methodology guide
3. **`create_spec`** → **`create_plan`** → **`create_task`** — build the hierarchy before any implementation
4. Work through the task cycle: `in-progress` → `pending-verification` → `done`

Any tool called before `start_server` returns an error. There is no way to skip steps.

---

## Installation

### Claude Code (recommended)

```bash
claude mcp add sdd npx -- -y @rafaelsouza-ai/mcp-server-sdd
```

Then set the required environment variables in `.claude/settings.json`:

```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"],
      "env": {
        "WORKSPACE_PATH": "/path/to/your/project",
        "AUTOOPENPANEL": "true"
      }
    }
  }
}
```

### Claude Desktop / Cursor / Windsurf — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"],
      "env": {
        "WORKSPACE_PATH": "/path/to/your/project",
        "AUTOOPENPANEL": "true"
      }
    }
  }
}
```

**Windows paths:**
```json
{
  "mcpServers": {
    "sdd": {
      "command": "npx",
      "args": ["-y", "@rafaelsouza-ai/mcp-server-sdd"],
      "env": {
        "WORKSPACE_PATH": "C:\\Users\\you\\projects\\my-app",
        "AUTOOPENPANEL": "true"
      }
    }
  }
}
```

---

## Updating

npx caches packages locally. If the dashboard shows an update banner or you want to force the latest version, clear the cache and restart your MCP client:

```bash
# Clear npm/npx cache
npm cache clean --force

# Windows — delete the npx cache directory directly
rmdir /s /q "%LocalAppData%\npm-cache\_npx"

# Mac / Linux
rm -rf ~/.npm/_npx
```

After clearing the cache, restart your MCP client (Claude Code, Claude Desktop, Cursor, etc.) and the latest version will be downloaded automatically.

If you installed globally instead of via npx:

```bash
npm install -g @rafaelsouza-ai/mcp-server-sdd
```

---

## Environment variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `WORKSPACE_PATH` | `string` | `process.cwd()` | Directory where `sdd.db` is stored. Set this to your project root so data persists across sessions. Without it, a new database is created in a temporary npx cache directory. |
| `AUTOOPENPANEL` | `boolean` | `false` | If `true`, the dashboard server starts and the browser opens automatically as soon as the MCP connects — no need to call `start_server` first. If `false` or unset, the panel only opens when the agent calls `start_server`. |

> Both variables are optional but **`WORKSPACE_PATH` is strongly recommended** — without it your tasks are lost every time npx clears its cache.

---

## Dashboard

The dashboard is available at `http://localhost:3000` (auto-increments if the port is busy).

- **Specs tab** — grid of spec cards with progress bars, edit/delete buttons, and inline plan accordion
- **Plans accordion** — each plan expands to show a mini-Kanban board with its tasks
- **All Tasks tab** — flat Kanban board across all tasks, with drag-and-drop status updates and bulk delete
- All changes made by the agent are reflected in real time via WebSocket

---

## Available tools

### Session

| Tool | Description |
|---|---|
| `start_server` | Starts the dashboard and opens the browser. Not needed if `AUTOOPENPANEL=true` — but still safe to call |
| `sdd_docs` | Returns the full methodology guide |

### Specs

| Tool | Description |
|---|---|
| `create_spec` | Create a spec (strategic "what & why"). Required: `title`. Optional: `description`, `priority`, `estimated_hours` |
| `read_spec` | Read a spec by `spec_number`. Pass `with_hierarchy=true` to include plans and tasks |
| `list_specs` | List all specs, optionally filtered by status. Returns progress counters |
| `update_spec` | Update spec fields or status (`draft` → `approved` → `in-progress` → `done` / `cancelled`) |
| `delete_spec` | Delete a spec and cascade-delete all its plans and linked tasks |

### Plans

| Tool | Description |
|---|---|
| `create_plan` | Create a plan (tactical phase) inside a spec. Required: `spec_number`, `title` |
| `read_plan` | Read a plan by `plan_number`. Returns the plan with all its tasks |
| `list_plans` | List all plans for a given `spec_number`, ordered by `sort_order` |
| `update_plan` | Update plan fields (`title`, `description`, `sort_order`, `estimated_hours`). Status is computed automatically |
| `delete_plan` | Delete a plan. Its tasks are unlinked (not deleted) |

### Tasks

| Tool | Description |
|---|---|
| `create_task` | Create a task with complete spec. Required: `title`, `description`, `inputs`, `expected_outputs`, `acceptance_criteria`. Optional: `plan_number` to link to a plan |
| `read_task` | Read full task details including logs and criteria |
| `update_task` | Update status or add a log entry |
| `list_tasks` | List all tasks, optionally filtered by status |
| `delete_task` | Delete a task (only allowed when status is `open`) |
| `add_task_log` | Add a progress log entry to a task |
| `read_task_logs` | Read the full history log of a task |
| `add_acceptance_criterion` | Add a new acceptance criterion to a task |
| `list_criteria` | List all acceptance criteria for a task |
| `submit_task_evidence` | Mark implementation complete, moves task to `pending-verification` |
| `verify_task_criterion` | Record pass/fail verdict for an acceptance criterion |

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

## Plan status (computed)

Plan status is derived automatically from its tasks — it is never set directly:

| Plan status | Condition |
|---|---|
| `pending` | All tasks are `open` |
| `in-progress` | At least one task is `in-progress` or `pending-verification` |
| `done` | All tasks are `done` |
| `blocked` | At least one task is `error` |

## Spec status (manual)

Spec status follows the human-controlled approval flow:

```
draft → approved → in-progress → done
                              ↘ cancelled
```

---

## Cascade deletion

Deleting a spec removes all its plans and all tasks linked to those plans.
Deleting a plan unlinks its tasks (sets `plan_number` to null) — tasks are preserved.

---

## Rules enforced by the server

- Every tool call is blocked until `start_server` has been called (or `AUTOOPENPANEL=true` was set)
- `delete_task` only works on tasks with status `open`

---

## Requirements

- Node.js 18+

---

## License

MIT
