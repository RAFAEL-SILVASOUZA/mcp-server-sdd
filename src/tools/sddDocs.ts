import { z } from 'zod';
import { isServerRunning } from '../server/index.js';

const SDD_DOCUMENTATION = `
# Spec-Driven Development (SDD) — Agent Reference

## What is SDD
SDD is a methodology where NO implementation line is written before a complete, approved spec exists.
The agent executes tasks — it does not decide what to do. The human approves, rejects, and verifies.

---

## ⚠️ ABSOLUTE RULE — BEFORE ANYTHING ELSE

**CALL \`start_server\` AS THE FIRST ACTION OF THE SESSION, THEN CALL \`sdd_docs\`.**

Do not create tasks. Do not read tasks. Do not do anything before calling \`start_server\` followed by \`sdd_docs\`.
This applies to every model, every instruction, every context.
If the human asks to create a task immediately, explain that \`start_server\` and \`sdd_docs\` must be called first — it is mandatory.

Reason: the dashboard must be active so the human can follow progress in real time. Creating tasks without the dashboard means working without visibility.

---

## Available tools and when to use each

### start_server
**FIRST TOOL TO CALL — no exceptions.**
Starts the dashboard server and automatically opens it in the browser.
Only after this call may the agent use any other SDD tool.

### sdd_docs
**SECOND TOOL TO CALL — right after start_server.**
Returns this complete reference guide. Call it again whenever you are unsure about the correct flow, rules, or expected behavior.

### create_task
Creates a new task with a complete spec. ALL fields are required:
- title: short and objective title
- description: what it is and why this task exists
- inputs: all context the agent will need (files, variables, APIs, business rules)
- expected_outputs: what will be produced at the end (endpoint, component, file, etc.)
- acceptance_criteria: list of verifiable conditions that define "done" (min. 1)
- depends_on: UUID of another task that must be completed first (optional)

NEVER create a task without a complete spec. If the human's request is vague, ask for clarification before creating.

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
Add criteria that were not anticipated at creation. Only do this if the task is not yet in progress (spec must be closed before implementation starts).

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

## Correct task flow

\`\`\`
1. start_server            → MANDATORY — starts the server and opens the dashboard
2. sdd_docs                → MANDATORY — read the full methodology guide
3. create_task             → create with complete spec (all fields)
4. update_task             → change status to 'in-progress' + log "Starting implementation"
5. [implement]
6. add_task_log            → record decisions and progress during implementation
7. list_criteria           → confirm all criteria will be met
8. submit_task_evidence    → deliver evidence, moves to 'pending-verification'
9. verify_task_criterion   → human verifies each criterion (pass/fail)
10. update_task            → human moves to 'done' or 'error' based on result
\`\`\`

---

## Non-negotiable rules

1. **Spec first** — never implement without creating the task with a complete spec
2. **Do not change the spec mid-execution** — if the task is 'in-progress', do not change inputs/outputs/criteria
3. **Log everything that matters** — every relevant decision becomes a log entry
4. **Submit only when ready** — only call submit_task_evidence when ALL criteria are met
5. **Do not move to 'done' alone** — the human approves via verify_task_criterion
6. **One task at a time** — do not start another task while the current one is 'in-progress'

---

## Valid statuses and transitions

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
  ]
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
