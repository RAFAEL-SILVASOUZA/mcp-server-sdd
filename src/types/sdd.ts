// Task Status
export type TaskStatus = 'open' | 'in-progress' | 'pending-verification' | 'done' | 'error';
export type LogAuthor = 'agent' | 'user';
export type SpecStatus = 'draft' | 'approved' | 'in-progress' | 'done' | 'cancelled';
export type PlanStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

// ── Spec ────────────────────────────────────────────────────────────────────
export interface Spec {
  spec_number: number;
  id: string;
  title: string;
  description?: string;
  status: SpecStatus;
  priority: 0 | 1 | 2 | 3;  // 0=low, 1=medium, 2=high, 3=critical
  estimated_hours?: number;
  created_at: string;
  updated_at: string;
}

export interface SpecWithPlans extends Spec {
  plans: Plan[];
}

export interface SpecWithHierarchy extends Spec {
  plans: PlanWithTasks[];
}

// ── Plan ────────────────────────────────────────────────────────────────────
export interface Plan {
  plan_number: number;
  id: string;
  spec_number: number;
  title: string;
  description?: string;
  sort_order: number;
  status: PlanStatus;         // computed from tasks
  estimated_hours?: number;
  created_at: string;
  updated_at: string;
}

export interface PlanWithTasks extends Plan {
  tasks: TaskWithEmbeds[];
}

// ── Task ────────────────────────────────────────────────────────────────────
// Task — matches dashboard's expected shape exactly
export interface Task {
  task_number: number;
  id: string;           // UUID kept for MCP tool compatibility
  plan_number?: number; // FK → plans (optional for backward compat)
  title: string;
  description?: string;
  status: TaskStatus;
  depends_on?: number;  // task_number of the dependency (kept for cross-plan deps)
  inputs?: string;
  expected_outputs?: string;
  sort_order: number;
  spec_locked_at?: string;
  evidence_summary?: string;
  git_diff_snapshot?: string;
  test_output_snapshot?: string;
  created_at: string;
  updated_at: string;
}

// Task returned by the REST API — includes embedded logs and criteria
export interface TaskWithEmbeds extends Task {
  logs: TaskLog[];
  criteria: TaskCriterion[];
}

// Log entry
export interface TaskLog {
  id: string;
  task_number: number;
  message: string;
  created_by: LogAuthor;
  created_at: string;
}

// Acceptance criterion
export interface TaskCriterion {
  id: number;
  task_number: number;
  criterion: string;
  passed: 1 | 0 | null;  // null = pending, 1 = passed, 0 = failed
  note?: string;
  created_at: string;
}

// Legacy aliases — kept so existing tools compile without change
export type Log = TaskLog;
export type AcceptanceCriterion = TaskCriterion;
