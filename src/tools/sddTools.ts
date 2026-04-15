import { z } from "zod";
import { store } from "../store/sqliteStore.js";
import { broadcastToClients, isServerRunning } from "../server/index.js";

const SERVER_NOT_STARTED = {
  success: false,
  error: "Dashboard server is not running. Required order: (1) call start_server → (2) call sdd_docs → (3) then use any other tool."
};

// ── Input schemas ─────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title:               z.string().min(1).max(500),
  description:         z.string().min(1),
  inputs:              z.string().min(1),
  expected_outputs:    z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  status:              z.enum(["open", "in-progress", "pending-verification", "done", "error"]).default("open"),
  depends_on:          z.string().uuid().optional(),
  plan_number:         z.number().int().positive().optional()
});

export const UpdateTaskSchema = z.object({
  task_id:          z.string().uuid(),
  title:            z.string().min(1).max(500).optional(),
  description:      z.string().optional(),
  status:           z.enum(["open", "in-progress", "pending-verification", "done", "error"]).optional(),
  depends_on:       z.string().uuid().optional(),
  inputs:           z.string().optional(),
  expected_outputs: z.string().optional(),
  log_message:      z.string().min(1).max(2000).optional()
});

export const SubmitEvidenceSchema = z.object({
  task_id:     z.string().uuid(),
  summary:     z.string().min(1),
  test_output: z.string().optional()
});

export const VerifyCriterionSchema = z.object({
  criterion_id: z.number().int().positive(),
  passed:       z.boolean(),
  note:         z.string().min(1).max(2000)
});

export type CreateTaskInput    = z.infer<typeof CreateTaskSchema> & { plan_number?: number };
export type UpdateTaskInput    = z.infer<typeof UpdateTaskSchema>;
export type SubmitEvidenceInput = z.infer<typeof SubmitEvidenceSchema>;
export type VerifyCriterionInput = z.infer<typeof VerifyCriterionSchema>;
// Note: task_id removed from VerifyCriterionSchema — criterion_id is globally unique

// ── Tools ─────────────────────────────────────────────────────────────────────

export const sddTools = {

  create_task: {
    schema: CreateTaskSchema,
    handler: async (args: CreateTaskInput) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      try {
        const task = store.createTask(
          args.title,
          args.description,
          args.status as any,
          args.depends_on,
          args.inputs,
          args.expected_outputs,
          args.plan_number
        );

        if (args.acceptance_criteria?.length) {
          for (const c of args.acceptance_criteria) {
            store.addAcceptanceCriterion(task.task_number, c);
          }
        }

        broadcastToClients({ type: 'tasks_updated' });
        return { success: true, data: store.getTaskWithEmbeds(task.task_number) };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  },

  read_task: {
    schema: z.object({ task_id: z.string().uuid() }),
    handler: async (args: { task_id: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const task = store.getTaskByUUID(args.task_id);
      if (!task) return { success: false, error: "Task not found" };
      return { success: true, data: store.getTaskWithEmbeds(task.task_number) };
    }
  },

  update_task: {
    schema: UpdateTaskSchema,
    handler: async (args: UpdateTaskInput) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const updates: any = {};
      if (args.title            !== undefined) updates.title            = args.title;
      if (args.description      !== undefined) updates.description      = args.description;
      if (args.status           !== undefined) updates.status           = args.status;
      if (args.depends_on       !== undefined) updates.depends_on       = args.depends_on;
      if (args.inputs           !== undefined) updates.inputs           = args.inputs;
      if (args.expected_outputs !== undefined) updates.expected_outputs = args.expected_outputs;

      const task = store.updateTask(args.task_id, updates);
      if (!task) return { success: false, error: "Task not found" };

      if (args.log_message) {
        store.addLog(task.task_number, args.log_message, 'agent');
      }

      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, data: store.getTaskWithEmbeds(task.task_number) };
    }
  },

  list_tasks: {
    schema: z.object({
      status: z.enum(["open", "in-progress", "pending-verification", "done", "error"]).optional()
    }),
    handler: async (args?: { status?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const tasks = store.listTasksWithEmbeds(args?.status as any);
      return { success: true, data: tasks };
    }
  },

  delete_task: {
    schema: z.object({ task_id: z.string().uuid() }),
    handler: async (args: { task_id: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const task = store.getTaskByUUID(args.task_id);
      if (!task) return { success: false, error: "Task not found" };
      if (task.status !== 'open') {
        return { success: false, error: `Cannot delete task with status '${task.status}' — only 'open' tasks can be deleted` };
      }
      store.deleteTask(args.task_id);
      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, message: "Task deleted" };
    }
  },

  add_task_log: {
    schema: z.object({
      task_id:    z.string().uuid(),
      message:    z.string().min(1).max(2000),
      created_by: z.enum(["agent", "user"]).default("agent")
    }),
    handler: async (args: { task_id: string; message: string; created_by?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const task = store.getTaskByUUID(args.task_id);
      if (!task) return { success: false, error: "Task not found" };
      const log = store.addLog(task.task_number, args.message, args.created_by ?? 'agent');
      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, data: log };
    }
  },

  read_task_logs: {
    schema: z.object({ task_id: z.string().uuid() }),
    handler: async (args: { task_id: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const logs = store.listLogs(args.task_id);
      return { success: true, data: logs };
    }
  },

  submit_task_evidence: {
    schema: SubmitEvidenceSchema,
    handler: async (args: SubmitEvidenceInput) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const task = store.getTaskByUUID(args.task_id);
      if (!task) return { success: false, error: "Task not found" };

      store.updateTask(args.task_id, {
        evidence_summary:     args.summary,
        test_output_snapshot: args.test_output,
        status:               'pending-verification'
      });

      store.addLog(task.task_number, `Evidence submitted: ${args.summary}`, 'agent');
      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, message: "Evidence submitted. Task moved to pending-verification." };
    }
  },

  verify_task_criterion: {
    schema: VerifyCriterionSchema,
    handler: async (args: VerifyCriterionInput) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const criterion = store.verifyCriterion(args.criterion_id, args.passed, args.note);
      if (!criterion) return { success: false, error: "Criterion not found — check criterion_id from list_criteria" };

      const verb = args.passed ? "PASSED" : "FAILED";
      store.addLog(criterion.task_number, `Criterion #${args.criterion_id} ${verb}: ${args.note}`, 'user');
      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, data: criterion };
    }
  },

  list_criteria: {
    schema: z.object({ task_id: z.string().uuid() }),
    handler: async (args: { task_id: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const criteria = store.listCriteria(args.task_id);
      return { success: true, data: criteria };
    }
  },

  add_acceptance_criterion: {
    schema: z.object({
      task_id:   z.string().uuid(),
      criterion: z.string().min(1).max(1000)
    }),
    handler: async (args: { task_id: string; criterion: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const task = store.getTaskByUUID(args.task_id);
      if (!task) return { success: false, error: "Task not found" };
      const c = store.addAcceptanceCriterion(task.task_number, args.criterion);
      broadcastToClients({ type: 'tasks_updated' });
      return { success: true, data: c };
    }
  }
};
