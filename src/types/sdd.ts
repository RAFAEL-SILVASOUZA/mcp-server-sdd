// Task Status
export type TaskStatus = 'open' | 'in-progress' | 'pending-verification' | 'done' | 'error';
export type LogAuthor = 'agent' | 'user';

// Task — matches dashboard's expected shape exactly
export interface Task {
  task_number: number;
  id: string;           // UUID kept for MCP tool compatibility
  title: string;
  description?: string;
  status: TaskStatus;
  depends_on?: number;  // task_number of the dependency
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
