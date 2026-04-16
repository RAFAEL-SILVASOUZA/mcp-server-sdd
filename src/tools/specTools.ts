import { z } from "zod";
import { store } from "../store/jsonStore.js";
import { broadcastToClients, isServerRunning } from "../server/index.js";

const SERVER_NOT_STARTED = {
  success: false,
  error: "Dashboard server is not running. Required order: (1) call start_server → (2) call sdd_docs → (3) then use any other tool."
};

// ── Spec Tools ────────────────────────────────────────────────────────────────

export const specTools = {

  create_spec: {
    schema: z.object({
      title:           z.string().min(1).max(500),
      description:     z.string().optional(),
      priority:        z.number().int().min(0).max(3).default(1),
      estimated_hours: z.number().positive().optional()
    }),
    handler: async (args: { title: string; description?: string; priority?: number; estimated_hours?: number }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      try {
        const spec = await store.createSpec(args.title, args.description, args.priority ?? 1, args.estimated_hours);
        broadcastToClients({ type: 'data_updated' });
        return { success: true, data: spec };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  },

  read_spec: {
    schema: z.object({
      spec_number:   z.number().int().positive().optional(),
      spec_id:       z.string().uuid().optional(),
      with_hierarchy: z.boolean().default(false)
    }),
    handler: async (args: { spec_number?: number; spec_id?: string; with_hierarchy?: boolean }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      if (!args.spec_number && !args.spec_id) {
        return { success: false, error: "Provide spec_number or spec_id" };
      }
      const specNumber = args.spec_number
        ?? (args.spec_id ? (await store.getSpecByUUID(args.spec_id))?.spec_number : undefined);
      if (!specNumber) return { success: false, error: "Spec not found" };

      if (args.with_hierarchy) {
        const h = store.getSpecWithHierarchy(specNumber);
        return h ? { success: true, data: h } : { success: false, error: "Spec not found" };
      }
      const spec = await store.getSpecByNumber(specNumber);
      if (!spec) return { success: false, error: "Spec not found" };
      const plans = await store.listPlansBySpec(specNumber);
      const progress = store.getSpecProgress(specNumber);
      return { success: true, data: { ...spec, plans, progress } };
    }
  },

  list_specs: {
    schema: z.object({
      status: z.enum(['draft', 'approved', 'in-progress', 'done', 'cancelled']).optional()
    }),
    handler: async (args?: { status?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const specs = await store.listSpecs(args?.status as any);
      const result = specs.map(s => ({
        ...s,
        progress: store.getSpecProgress(s.spec_number),
      }));
      return { success: true, data: result };
    }
  },

  update_spec: {
    schema: z.object({
      spec_number:     z.number().int().positive().optional(),
      spec_id:         z.string().uuid().optional(),
      title:           z.string().min(1).max(500).optional(),
      description:     z.string().optional(),
      status:          z.enum(['draft', 'approved', 'in-progress', 'done', 'cancelled']).optional(),
      priority:        z.number().int().min(0).max(3).optional(),
      estimated_hours: z.number().positive().optional()
    }),
    handler: async (args: any) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const id = args.spec_number ?? (args.spec_id ? (await store.getSpecByUUID(args.spec_id))?.spec_number : undefined);
      if (!id) return { success: false, error: "Provide spec_number or spec_id" };

      const updates: any = {};
      if (args.title           !== undefined) updates.title           = args.title;
      if (args.description     !== undefined) updates.description     = args.description;
      if (args.status          !== undefined) updates.status          = args.status;
      if (args.priority        !== undefined) updates.priority        = args.priority;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;

      const spec = await store.updateSpec(id, updates);
      if (!spec) return { success: false, error: "Spec not found" };
      broadcastToClients({ type: 'data_updated' });
      return { success: true, data: spec };
    }
  },

  delete_spec: {
    schema: z.object({
      spec_number: z.number().int().positive().optional(),
      spec_id:     z.string().uuid().optional()
    }),
    handler: async (args: { spec_number?: number; spec_id?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const id = args.spec_number ?? (args.spec_id ? (await store.getSpecByUUID(args.spec_id))?.spec_number : undefined);
      if (!id) return { success: false, error: "Provide spec_number or spec_id" };
      const deleted = await store.deleteSpec(id);
      if (!deleted) return { success: false, error: "Spec not found" };
      broadcastToClients({ type: 'data_updated' });
      return { success: true, message: "Spec deleted (cascade: plans and task links removed)" };
    }
  },

  // ── Plan Tools ─────────────────────────────────────────────────────────────

  create_plan: {
    schema: z.object({
      spec_number:     z.number().int().positive(),
      title:           z.string().min(1).max(500),
      description:     z.string().optional(),
      sort_order:      z.number().int().min(0).optional(),
      estimated_hours: z.number().positive().optional()
    }),
    handler: async (args: { spec_number: number; title: string; description?: string; sort_order?: number; estimated_hours?: number }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const spec = await store.getSpecByNumber(args.spec_number);
      if (!spec) return { success: false, error: `Spec #${args.spec_number} not found` };
      try {
        const plan = await store.createPlan(args.spec_number, args.title, args.description, args.sort_order, args.estimated_hours);
        broadcastToClients({ type: 'data_updated' });
        return { success: true, data: plan };
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  },

  read_plan: {
    schema: z.object({
      plan_number: z.number().int().positive().optional(),
      plan_id:     z.string().uuid().optional()
    }),
    handler: async (args: { plan_number?: number; plan_id?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      if (!args.plan_number && !args.plan_id) {
        return { success: false, error: "Provide plan_number or plan_id" };
      }
      const plan = args.plan_number
        ? await store.getPlanByNumber(args.plan_number)
        : args.plan_id ? await store.getPlanByUUID(args.plan_id) : undefined;
      if (!plan) return { success: false, error: "Plan not found" };
      const tasks = store.listTasksByPlanWithEmbeds(plan.plan_number);
      return { success: true, data: { ...plan, tasks } };
    }
  },

  list_plans: {
    schema: z.object({
      spec_number: z.number().int().positive()
    }),
    handler: async (args: { spec_number: number }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const spec = await store.getSpecByNumber(args.spec_number);
      if (!spec) return { success: false, error: `Spec #${args.spec_number} not found` };
      const plans = await store.listPlansBySpec(args.spec_number);
      return { success: true, data: plans };
    }
  },

  update_plan: {
    schema: z.object({
      plan_number:     z.number().int().positive().optional(),
      plan_id:         z.string().uuid().optional(),
      title:           z.string().min(1).max(500).optional(),
      description:     z.string().optional(),
      sort_order:      z.number().int().min(0).optional(),
      estimated_hours: z.number().positive().optional()
    }),
    handler: async (args: any) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const id = args.plan_number ?? (args.plan_id ? (await store.getPlanByUUID(args.plan_id))?.plan_number : undefined);
      if (!id) return { success: false, error: "Provide plan_number or plan_id" };

      const updates: any = {};
      if (args.title           !== undefined) updates.title           = args.title;
      if (args.description     !== undefined) updates.description     = args.description;
      if (args.sort_order      !== undefined) updates.sort_order      = args.sort_order;
      if (args.estimated_hours !== undefined) updates.estimated_hours = args.estimated_hours;

      const plan = await store.updatePlan(id, updates);
      if (!plan) return { success: false, error: "Plan not found" };
      broadcastToClients({ type: 'data_updated' });
      return { success: true, data: plan };
    }
  },

  delete_plan: {
    schema: z.object({
      plan_number: z.number().int().positive().optional(),
      plan_id:     z.string().uuid().optional()
    }),
    handler: async (args: { plan_number?: number; plan_id?: string }) => {
      if (!isServerRunning()) return SERVER_NOT_STARTED;
      const id = args.plan_number ?? (args.plan_id ? (await store.getPlanByUUID(args.plan_id))?.plan_number : undefined);
      if (!id) return { success: false, error: "Provide plan_number or plan_id" };
      const deleted = await store.deletePlan(id);
      if (!deleted) return { success: false, error: "Plan not found" };
      broadcastToClients({ type: 'data_updated' });
      return { success: true, message: "Plan deleted (tasks unlinked, not deleted)" };
    }
  }
};
