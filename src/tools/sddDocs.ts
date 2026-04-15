import { z } from 'zod';
import { isServerRunning } from '../server/index.js';

const SDD_DOCUMENTATION = `
# Spec-Driven Development (SDD) — Agent Reference

## What is SDD
SDD is a methodology where NO implementation line is written before a complete, approved spec exists.
Work is organized in three levels:

\`\`\`
Spec  →  Plan  →  Task
(what & why)  (how, in phases)  (unit of execution)
\`\`\`

- **Spec** — the strategic parent. Defines what will be built and why. Must be approved before work begins.
- **Plan** — a tactical phase inside a spec. Groups related tasks into ordered steps. Status is computed automatically from task statuses.
- **Task** — the unit of execution. Has full spec (inputs, outputs, acceptance criteria), logs, and a verification cycle.

The agent executes tasks — it does not decide what to do. The human approves, rejects, and verifies.

---

## ⚠️ ABSOLUTE RULE — BEFORE ANYTHING ELSE

**THE DASHBOARD MUST BE ACTIVE BEFORE ANY OTHER TOOL IS USED.**

There are two ways the dashboard can be active:

1. **AUTOOPENPANEL=true (configured by the human)** — the server started automatically when the MCP connected. In this case you may skip \`start_server\` and go straight to \`sdd_docs\`.
2. **AUTOOPENPANEL not set or false** — you MUST call \`start_server\` as the very first action, then \`sdd_docs\`.

When in doubt, call \`start_server\` — it is always safe and idempotent (returns the existing URL if already running).

Do not create specs, plans, or tasks before the dashboard is active and \`sdd_docs\` has been called.
If the human asks to create a task immediately, explain this mandatory order.

Reason: the dashboard must be active so the human can follow progress in real time.

---

## Available tools and when to use each

### start_server
Starts the dashboard server and automatically opens it in the browser.
- If AUTOOPENPANEL=true was set by the human, the server is already running — calling start_server is still safe (returns the existing URL).
- If AUTOOPENPANEL is not set or false, this MUST be the first tool called.
Only after the dashboard is active may the agent use any other SDD tool.

### sdd_docs
**SECOND TOOL TO CALL — right after start_server.**
Returns this complete reference guide. Call it again whenever you are unsure about the correct flow, rules, or expected behavior.

---

### Spec tools

### create_spec
Creates a new Spec — the strategic "WHAT" and "WHY".
- title: short and objective (required)
- description: full context of what will be built and why (optional)
- priority: 0=low, 1=medium, 2=high, 3=critical (optional)
- estimated_hours: total hours estimate for the spec (optional)

A spec must exist before creating any plan. Do not start planning without a spec.

### read_spec
Read a spec by spec_number.
Pass with_hierarchy=true to include all its plans and their tasks.

### list_specs
List all specs, optionally filtered by status. Returns progress counters per spec.

### update_spec
Update spec fields or advance its status:
\`\`\`
draft → approved → in-progress → done
                              ↘ cancelled
\`\`\`
Set status='approved' when the spec is ready for implementation.

### delete_spec
Deletes the spec AND cascade-deletes all its plans and all tasks linked to those plans.
This is irreversible — confirm with the human before calling.

---

### Plan tools

### create_plan
Creates a plan (tactical phase) inside a spec.
- spec_number: the parent spec (required)
- title: short objective for this phase (required)
- description, sort_order, estimated_hours: optional

Plans are ordered steps toward completing the spec. Create one plan per logical phase.

### read_plan
Read a plan by plan_number. Returns the plan with all its tasks.

### list_plans
List all plans for a given spec_number, ordered by sort_order.

### update_plan
Update plan fields (title, description, sort_order, estimated_hours).
Plan status is computed automatically — never set it directly.

Plan status rules:
- pending: all tasks are open
- in-progress: at least one task is in-progress or pending-verification
- done: all tasks are done
- blocked: at least one task is error

### delete_plan
Deletes the plan. Its tasks are unlinked (plan_number set to null) but NOT deleted.

---

### Task tools

### create_task
Creates a new task with a complete spec. ALL fields are required:
- title: short and objective title
- description: what it is and why this task exists
- inputs: all context the agent will need (files, variables, APIs, business rules)
- expected_outputs: what will be produced at the end (endpoint, component, file, etc.)
- acceptance_criteria: list of verifiable conditions that define "done" (min. 1)
- plan_number: links the task to a plan (optional but strongly recommended)
- depends_on: UUID of another task that must be completed first (optional)

NEVER create a task without a spec and plan. If the human's request is vague, ask for clarification.

### read_task
Read the task before starting implementation. Confirm you understand all fields.
Returns the task with embedded logs and acceptance criteria.

### update_task
Use to:
- Change status as work progresses
- Add a log_message recording what was done, decided, or found
The log_message field is the correct way to maintain history — use it whenever something relevant happens.

### list_tasks
List tasks to get an overview of the backlog. Useful for understanding dependencies.

### delete_task
Only works on tasks with status 'open'. Tasks in progress or completed cannot be deleted.

### add_task_log
Add logs during execution to record progress, decisions, and problems.
Use created_by='agent' for agent actions, 'user' for human actions.

### read_task_logs
Read the history of a task to understand what has already been done before continuing.

### add_acceptance_criterion
Add criteria that were not anticipated at creation. Only do this if the task is not yet in progress.

### list_criteria
List the acceptance criteria of a task. Use before submit_task_evidence to confirm all criteria will be met.

### submit_task_evidence
Use when implementation is complete.
- summary: objective summary of what was done
- test_output: test results (if any)
Automatically moves the task to 'pending-verification'.
Do NOT use if any acceptance criterion has not been met.

### verify_task_criterion
Used by the HUMAN (or by the agent when explicitly authorized) to record pass/fail for each criterion.
Requires criterion_id — obtain it with list_criteria or read_task.

---

## Correct full workflow

\`\`\`
1. start_server            → if AUTOOPENPANEL=true, skip (dashboard already open); otherwise MANDATORY
2. sdd_docs                → MANDATORY — read the full methodology guide
3. create_spec             → define WHAT will be built and WHY
4. update_spec             → set status='approved' when ready
5. create_plan             → define tactical phases (one plan per phase)
6. create_task             → create tasks linked to a plan (all fields required)
7. update_task             → change status to 'in-progress' + log "Starting implementation"
8. [implement]
9. add_task_log            → record decisions and progress during implementation
10. list_criteria          → confirm all criteria will be met
11. submit_task_evidence   → deliver evidence, moves to 'pending-verification'
12. verify_task_criterion  → human verifies each criterion (pass/fail)
13. update_task            → human moves to 'done' or 'error' based on result
\`\`\`

---

## Non-negotiable rules

1. **Spec first** — never plan or implement without an approved spec
2. **Plan before tasks** — group tasks into plans before creating them
3. **Do not change the spec mid-execution** — if a task is 'in-progress', do not change inputs/outputs/criteria
4. **Log everything that matters** — every relevant decision becomes a log entry
5. **Submit only when ready** — only call submit_task_evidence when ALL criteria are met
6. **Do not move to 'done' alone** — the human approves via verify_task_criterion
7. **One task at a time** — do not start another task while the current one is 'in-progress'

---

## Valid task statuses and transitions

\`\`\`
open → in-progress                   (agent starts)
in-progress → pending-verification   (agent delivers via submit_task_evidence)
pending-verification → done          (human approves)
pending-verification → in-progress   (human rejects, returns for correction)
pending-verification → error         (human marks as error)
any → open                           (reset, only with justification in the log)
\`\`\`

---

## Example of a well-formed create_task

\`\`\`json
{
  "title": "Implement POST /auth/login endpoint",
  "description": "Create a JWT authentication endpoint. The user sends email and password and receives an access token valid for 24h.",
  "inputs": "JWT_SECRET is in .env. Use HS256 algorithm. User model is in src/models/user.ts. Password hashing with bcrypt is already implemented.",
  "expected_outputs": "POST /auth/login returns { token: string } with status 200 on valid credentials, 401 on invalid. Unit tests covering both cases.",
  "acceptance_criteria": [
    "POST /auth/login with valid credentials returns status 200 and a JWT token",
    "POST /auth/login with wrong password returns status 401",
    "POST /auth/login with non-existent email returns status 401",
    "Expired token returns 401 on protected routes",
    "All existing tests continue to pass"
  ],
  "plan_number": 1
}
\`\`\`
`;

export const sddDocsTools = {
  sdd_docs: {
    schema: z.object({}),
    handler: async (): Promise<any> => {
      if (!isServerRunning()) {
        return {
          success: false,
          error: "Dashboard server is not running. Required order: (1) call start_server → (2) call sdd_docs → (3) then use any other tool."
        };
      }
      return { success: true, data: SDD_DOCUMENTATION };
    }
  }
};
