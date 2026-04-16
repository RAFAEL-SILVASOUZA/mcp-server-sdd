import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { existsSync, mkdirSync } from 'fs';
import type {
  Task,
  TaskLog,
  TaskCriterion,
  TaskWithEmbeds,
  TaskStatus,
  Spec,
  SpecStatus,
  Plan,
  PlanStatus,
  PlanWithTasks,
  SpecWithHierarchy
} from '../types/sdd.js';

/**
 * JSON-based storage for SDD entities.
 * Stores data in workspace root: specs/, plans/, tasks/ directories.
 * Each entity is stored as a separate JSON file named by its UUID.
 */
export class JsonStore {
  private baseDir: string;
  private specsDir: string;
  private plansDir: string;
  private tasksDir: string;

  constructor(workspacePath?: string) {
    // Determine base directory
    const basePath = workspacePath || process.env.WORKSPACE_PATH || this.findProjectRoot();
    this.baseDir = path.join(basePath, 'sdd');
    this.specsDir = path.join(this.baseDir, 'specs');
    this.plansDir = path.join(this.baseDir, 'plans');
    this.tasksDir = path.join(this.baseDir, 'tasks');

    // Ensure directories exist
    [this.baseDir, this.specsDir, this.plansDir, this.tasksDir].forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Finds the project root by walking up from cwd looking for .git or package.json
   */
  private findProjectRoot(): string {
    let currentDir = process.cwd();
    const maxDepth = 20;
    let depth = 0;

    while (depth < maxDepth) {
      if (
        existsSync(path.join(currentDir, '.git')) ||
        existsSync(path.join(currentDir, 'package.json'))
      ) {
        return currentDir;
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
      depth++;
    }

    return process.cwd();
  }

  /**
   * Get file path for a spec by UUID
   */
  private getSpecPath(id: string): string {
    return path.join(this.specsDir, `${id}.json`);
  }

  /**
   * Get file path for a plan by UUID
   */
  private getPlanPath(id: string): string {
    return path.join(this.plansDir, `${id}.json`);
  }

  /**
   * Get file path for a task by UUID
   */
  private getTaskPath(id: string): string {
    return path.join(this.tasksDir, `${id}.json`);
  }

  /**
   * Read JSON file
   */
  private readJson<T>(filePath: string): T | null {
    try {
      if (!existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  /**
   * Write JSON file
   */
  private writeJson<T>(filePath: string, data: T): void {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * List all files in a directory with extension
   */
  private listFiles(directory: string, extension: string = '.json'): string[] {
    if (!existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(f => f.endsWith(extension));
  }

  /**
   * Get current timestamp in ISO format
   */
  private now(): string {
    return new Date().toISOString();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          SPEC CRUD OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new spec
   */
  createSpec(
    title: string,
    description?: string,
    priority: number = 1,
    estimated_hours?: number
  ): Spec {
    const id = uuidv4();
    const now = this.now();
    // Clamp priority to valid range (0-3)
    const clampedPriority = Math.max(0, Math.min(3, Math.round(priority))) as 0 | 1 | 2 | 3;
    const spec: Spec = {
      spec_number: this.getNextSpecNumber(),
      id,
      title,
      description: description ?? undefined,
      status: 'draft',
      priority: clampedPriority,
      estimated_hours: estimated_hours ?? undefined,
      created_at: now,
      updated_at: now
    };

    this.writeJson(this.getSpecPath(id), spec);
    return spec;
  }

  /**
   * Get next available spec_number
   */
  private getNextSpecNumber(): number {
    const files = this.listFiles(this.specsDir);
    if (files.length === 0) return 1;

    let maxNumber = 0;
    for (const file of files) {
      const spec = this.readJson<Spec>(path.join(this.specsDir, file));
      if (spec && spec.spec_number > maxNumber) {
        maxNumber = spec.spec_number;
      }
    }
    return maxNumber + 1;
  }

  /**
   * Get spec by UUID
   */
  getSpecByUUID(id: string): Spec | undefined {
    const spec = this.readJson<Spec>(this.getSpecPath(id));
    return spec ?? undefined;
  }

  /**
   * Get spec by number
   */
  getSpecByNumber(n: number): Spec | undefined {
    const files = this.listFiles(this.specsDir);
    for (const file of files) {
      const spec = this.readJson<Spec>(path.join(this.specsDir, file));
      if (spec && spec.spec_number === n) {
        return spec;
      }
    }
    return undefined;
  }

  /**
   * List all specs, optionally filtered by status
   */
  listSpecs(status?: SpecStatus): Spec[] {
    const files = this.listFiles(this.specsDir);
    const specs: Spec[] = [];

    for (const file of files) {
      const spec = this.readJson<Spec>(path.join(this.specsDir, file));
      if (spec) {
        if (!status || spec.status === status) {
          specs.push(spec);
        }
      }
    }

    // Sort by priority DESC, then spec_number ASC
    specs.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.spec_number - b.spec_number;
    });

    return specs;
  }

  /**
   * Update a spec
   */
  updateSpec(
    idOrNumber: string | number,
    updates: Partial<Omit<Spec, 'spec_number' | 'id' | 'created_at'>>
  ): Spec | null {
    let spec: Spec | undefined;

    if (typeof idOrNumber === 'number') {
      spec = this.getSpecByNumber(idOrNumber);
    } else {
      spec = this.getSpecByUUID(idOrNumber);
    }

    if (!spec) return null;

    // Apply updates
    const updated: Spec = {
      ...spec,
      title: updates.title ?? spec.title,
      description: updates.description !== undefined ? updates.description : spec.description,
      status: updates.status ?? spec.status,
      priority: updates.priority ?? spec.priority,
      estimated_hours: updates.estimated_hours !== undefined ? updates.estimated_hours : spec.estimated_hours,
      updated_at: this.now()
    };

    this.writeJson(this.getSpecPath(spec.id), updated);
    return updated;
  }

  /**
   * Delete a spec and all related data
   */
  deleteSpec(idOrNumber: string | number): boolean {
    let spec: Spec | undefined;

    if (typeof idOrNumber === 'number') {
      spec = this.getSpecByNumber(idOrNumber);
    } else {
      spec = this.getSpecByUUID(idOrNumber);
    }

    if (!spec) return false;

    // Delete all plans for this spec
    const plans = this.listPlansBySpec(spec.spec_number);
    for (const plan of plans) {
      // Delete all tasks for this plan
      const tasks = this.listTasksByPlan(plan.plan_number);
      for (const task of tasks) {
        this.deleteTask(task.id);
      }
      this.deletePlan(plan.id);
    }

    // Delete the spec file
    const specPath = this.getSpecPath(spec.id);
    if (existsSync(specPath)) {
      fs.unlinkSync(specPath);
    }

    return true;
  }

  /**
   * Get spec progress for dashboard
   */
  getSpecProgress(spec_number: number): {
    total_plans: number;
    done_plans: number;
    total_tasks: number;
    done_tasks: number;
  } {
    const plans = this.listPlansBySpec(spec_number);
    const total_plans = plans.length;
    const done_plans = plans.filter(p => p.status === 'done').length;
    const allTasks = plans.flatMap(p => this.listTasksByPlan(p.plan_number));

    return {
      total_plans,
      done_plans,
      total_tasks: allTasks.length,
      done_tasks: allTasks.filter(t => t.status === 'done').length
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          PLAN CRUD OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute plan status based on its tasks
   */
  computePlanStatus(plan_number: number): PlanStatus {
    const tasks = this.listTasksByPlan(plan_number);
    if (tasks.length === 0) return 'pending';
    if (tasks.every(t => t.status === 'done')) return 'done';
    if (tasks.some(t => t.status === 'error')) return 'blocked';
    if (tasks.some(t => t.status === 'in-progress' || t.status === 'pending-verification')) return 'in-progress';
    return 'pending';
  }

  /**
   * Create a new plan
   */
  createPlan(
    spec_number: number,
    title: string,
    description?: string,
    sort_order?: number,
    estimated_hours?: number
  ): Plan {
    const id = uuidv4();
    const now = this.now();

    // Calculate max sort_order for this spec
    let maxSortOrder = sort_order ?? -1;
    const plans = this.listPlansBySpec(spec_number);
    for (const plan of plans) {
      if (plan.sort_order > maxSortOrder) {
        maxSortOrder = plan.sort_order;
      }
    }

    const plan: Plan = {
      plan_number: this.getNextPlanNumber(),
      id,
      spec_number,
      title,
      description: description ?? undefined,
      sort_order: maxSortOrder + 1,
      status: 'pending',
      estimated_hours: estimated_hours ?? undefined,
      created_at: now,
      updated_at: now
    };

    this.writeJson(this.getPlanPath(id), plan);
    return plan;
  }

  /**
   * Get next available plan_number
   */
  private getNextPlanNumber(): number {
    const files = this.listFiles(this.plansDir);
    if (files.length === 0) return 1;

    let maxNumber = 0;
    for (const file of files) {
      const plan = this.readJson<Plan>(path.join(this.plansDir, file));
      if (plan && plan.plan_number > maxNumber) {
        maxNumber = plan.plan_number;
      }
    }
    return maxNumber + 1;
  }

  /**
   * Get plan by UUID
   */
  getPlanByUUID(id: string): Plan | undefined {
    const plan = this.readJson<Plan>(this.getPlanPath(id));
    if (!plan) return undefined;
    plan.status = this.computePlanStatus(plan.plan_number);
    return plan;
  }

  /**
   * Get plan by number
   */
  getPlanByNumber(n: number): Plan | undefined {
    const files = this.listFiles(this.plansDir);
    for (const file of files) {
      const plan = this.readJson<Plan>(path.join(this.plansDir, file));
      if (plan && plan.plan_number === n) {
        plan.status = this.computePlanStatus(plan.plan_number);
        return plan;
      }
    }
    return undefined;
  }

  /**
   * List all plans for a spec
   */
  listPlansBySpec(spec_number: number): Plan[] {
    const files = this.listFiles(this.plansDir);
    const plans: Plan[] = [];

    for (const file of files) {
      const plan = this.readJson<Plan>(path.join(this.plansDir, file));
      if (plan && plan.spec_number === spec_number) {
        plan.status = this.computePlanStatus(plan.plan_number);
        plans.push(plan);
      }
    }

    // Sort by sort_order ASC, then plan_number ASC
    plans.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.plan_number - b.plan_number;
    });

    return plans;
  }

  /**
   * Update a plan
   */
  updatePlan(
    idOrNumber: string | number,
    updates: Partial<Omit<Plan, 'plan_number' | 'id' | 'created_at' | 'status'>>
  ): Plan | null {
    let plan: Plan | undefined;

    if (typeof idOrNumber === 'number') {
      plan = this.getPlanByNumber(idOrNumber);
    } else {
      plan = this.getPlanByUUID(idOrNumber);
    }

    if (!plan) return null;

    // Apply updates (exclude status - it's computed)
    const updated: Plan = {
      ...plan,
      title: updates.title ?? plan.title,
      description: updates.description !== undefined ? updates.description : plan.description,
      sort_order: updates.sort_order ?? plan.sort_order,
      estimated_hours: updates.estimated_hours !== undefined ? updates.estimated_hours : plan.estimated_hours,
      updated_at: this.now()
    };

    // Recompute status
    updated.status = this.computePlanStatus(plan.plan_number);

    this.writeJson(this.getPlanPath(plan.id), updated);
    return updated;
  }

  /**
   * Delete a plan and all related tasks
   */
  deletePlan(idOrNumber: string | number): boolean {
    let plan: Plan | undefined;

    if (typeof idOrNumber === 'number') {
      plan = this.getPlanByNumber(idOrNumber);
    } else {
      plan = this.getPlanByUUID(idOrNumber);
    }

    if (!plan) return false;

    // Delete all tasks for this plan
    const tasks = this.listTasksByPlan(plan.plan_number);
    for (const task of tasks) {
      this.deleteTask(task.id);
    }

    // Delete the plan file
    const planPath = this.getPlanPath(plan.id);
    if (existsSync(planPath)) {
      fs.unlinkSync(planPath);
    }

    return true;
  }

  /**
   * Get spec with full hierarchy (plans, tasks, logs, criteria)
   */
  getSpecWithHierarchy(spec_number: number): SpecWithHierarchy | undefined {
    const spec = this.getSpecByNumber(spec_number);
    if (!spec) return undefined;

    const plans = this.listPlansBySpec(spec_number).map(p => ({
      ...p,
      tasks: this.listTasksByPlan(p.plan_number).map(t => ({
        ...t,
        logs: this.getLogs(t.task_number),
        criteria: this.getCriteria(t.task_number)
      }))
    }));

    return {
      ...spec,
      plans
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          TASK CRUD OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a new task
   */
  createTask(
    title: string,
    description?: string,
    status: TaskStatus = 'open',
    depends_on?: string | number,
    inputs?: string,
    expected_outputs?: string,
    plan_number?: number
  ): Task {
    const id = uuidv4();
    const now = this.now();

    // Resolve depends_on to task_number if it's a UUID
    let dependsOnNumber: number | undefined;
    if (depends_on !== undefined) {
      if (typeof depends_on === 'number') {
        dependsOnNumber = depends_on;
      } else {
        const depTask = this.getTaskByUUID(depends_on);
        dependsOnNumber = depTask?.task_number ?? undefined;
      }
    }

    // Calculate max sort_order
    let maxSortOrder = -1;
    const allTasks = this.listTasks();
    for (const task of allTasks) {
      if (task.sort_order > maxSortOrder) {
        maxSortOrder = task.sort_order;
      }
    }

    const task: Task = {
      task_number: this.getNextTaskNumber(),
      id,
      plan_number: plan_number ?? undefined,
      title,
      description: description ?? undefined,
      status,
      depends_on: dependsOnNumber,
      inputs: inputs ?? undefined,
      expected_outputs: expected_outputs ?? undefined,
      sort_order: maxSortOrder + 1,
      created_at: now,
      updated_at: now
    };

    this.writeJson(this.getTaskPath(id), task);
    return task;
  }

  /**
   * Get next available task_number
   */
  private getNextTaskNumber(): number {
    const files = this.listFiles(this.tasksDir);
    if (files.length === 0) return 1;

    let maxNumber = 0;
    for (const file of files) {
      const task = this.readJson<Task>(path.join(this.tasksDir, file));
      if (task && task.task_number > maxNumber) {
        maxNumber = task.task_number;
      }
    }
    return maxNumber + 1;
  }

  /**
   * Get task by UUID
   */
  getTaskByUUID(id: string): Task | undefined {
    const task = this.readJson<Task>(this.getTaskPath(id));
    return task ?? undefined;
  }

  /**
   * Get task by number
   */
  getTaskByNumber(task_number: number): Task | undefined {
    const files = this.listFiles(this.tasksDir);
    for (const file of files) {
      const task = this.readJson<Task>(path.join(this.tasksDir, file));
      if (task && task.task_number === task_number) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Get task with embedded logs and criteria
   */
  getTaskWithEmbeds(task_number: number): TaskWithEmbeds | undefined {
    const task = this.getTaskByNumber(task_number);
    if (!task) return undefined;

    return {
      ...task,
      logs: this.getLogs(task.task_number),
      criteria: this.getCriteria(task.task_number)
    };
  }

  /**
   * List all tasks, optionally filtered by status
   */
  listTasks(status?: TaskStatus): Task[] {
    const files = this.listFiles(this.tasksDir);
    const tasks: Task[] = [];

    for (const file of files) {
      const task = this.readJson<Task>(path.join(this.tasksDir, file));
      if (task) {
        if (!status || task.status === status) {
          tasks.push(task);
        }
      }
    }

    // Sort by sort_order ASC, then task_number ASC
    tasks.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.task_number - b.task_number;
    });

    return tasks;
  }

  /**
   * List all tasks with embedded logs and criteria
   */
  listTasksWithEmbeds(status?: TaskStatus): TaskWithEmbeds[] {
    return this.listTasks(status).map(t => ({
      ...t,
      logs: this.getLogs(t.task_number),
      criteria: this.getCriteria(t.task_number)
    }));
  }

  /**
   * List tasks by plan number
   */
  listTasksByPlan(plan_number: number): Task[] {
    const files = this.listFiles(this.tasksDir);
    const tasks: Task[] = [];

    for (const file of files) {
      const task = this.readJson<Task>(path.join(this.tasksDir, file));
      if (task && task.plan_number === plan_number) {
        tasks.push(task);
      }
    }

    // Sort by sort_order ASC, then task_number ASC
    tasks.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.task_number - b.task_number;
    });

    return tasks;
  }

  /**
   * List tasks by plan with embeds
   */
  listTasksByPlanWithEmbeds(plan_number: number): TaskWithEmbeds[] {
    return this.listTasksByPlan(plan_number).map(t => ({
      ...t,
      logs: this.getLogs(t.task_number),
      criteria: this.getCriteria(t.task_number)
    }));
  }

  /**
   * Update a task
   */
  updateTask(
    idOrNumber: string | number,
    updates: Partial<Omit<Task, 'task_number' | 'id' | 'created_at'>>
  ): Task | null {
    let task: Task | undefined;

    if (typeof idOrNumber === 'number') {
      task = this.getTaskByNumber(idOrNumber);
    } else {
      task = this.getTaskByUUID(idOrNumber);
    }

    if (!task) return null;

    // Resolve depends_on if provided
    let dependsOnNumber: number | undefined = task.depends_on;
    if ('depends_on' in updates && updates.depends_on !== undefined) {
      if (updates.depends_on === null || updates.depends_on === undefined) {
        dependsOnNumber = undefined;
      } else if (typeof updates.depends_on === 'number') {
        dependsOnNumber = updates.depends_on;
      } else {
        const depTask = this.getTaskByUUID(updates.depends_on);
        dependsOnNumber = depTask?.task_number ?? undefined;
      }
    }

    // Apply updates
    const updated: Task = {
      ...task,
      title: updates.title ?? task.title,
      description: updates.description !== undefined ? updates.description : task.description,
      status: updates.status ?? task.status,
      depends_on: dependsOnNumber,
      inputs: updates.inputs !== undefined ? updates.inputs : task.inputs,
      expected_outputs: updates.expected_outputs !== undefined ? updates.expected_outputs : task.expected_outputs,
      sort_order: updates.sort_order ?? task.sort_order,
      plan_number: updates.plan_number !== undefined ? updates.plan_number : task.plan_number,
      spec_locked_at: updates.spec_locked_at !== undefined ? updates.spec_locked_at : task.spec_locked_at,
      evidence_summary: updates.evidence_summary !== undefined ? updates.evidence_summary : task.evidence_summary,
      git_diff_snapshot: updates.git_diff_snapshot !== undefined ? updates.git_diff_snapshot : task.git_diff_snapshot,
      test_output_snapshot: updates.test_output_snapshot !== undefined ? updates.test_output_snapshot : task.test_output_snapshot,
      updated_at: this.now()
    };

    this.writeJson(this.getTaskPath(task.id), updated);
    return updated;
  }

  /**
   * Update task status only
   */
  updateTaskStatus(id: string, status: TaskStatus): Task | null {
    return this.updateTask(id, { status });
  }

  /**
   * Delete a task and all related logs/criteria
   */
  deleteTask(idOrNumber: string | number): boolean {
    let task: Task | undefined;

    if (typeof idOrNumber === 'number') {
      task = this.getTaskByNumber(idOrNumber);
    } else {
      task = this.getTaskByUUID(idOrNumber);
    }

    if (!task) return false;

    // Delete the task file
    const taskPath = this.getTaskPath(task.id);
    if (existsSync(taskPath)) {
      fs.unlinkSync(taskPath);
    }

    return true;
  }

  /**
   * Update sort order for multiple tasks
   */
  updateSortOrder(taskNumbers: number[]): void {
    for (let i = 0; i < taskNumbers.length; i++) {
      const task = this.getTaskByNumber(taskNumbers[i]);
      if (task) {
        task.sort_order = i;
        this.writeJson(this.getTaskPath(task.id), task);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          LOG OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a log entry for a task
   */
  addLog(taskIdOrNumber: string | number, message: string, createdBy: string = 'agent'): TaskLog {
    let task: Task | undefined;

    if (typeof taskIdOrNumber === 'number') {
      task = this.getTaskByNumber(taskIdOrNumber);
    } else {
      task = this.getTaskByUUID(taskIdOrNumber);
    }

    if (!task) {
      throw new Error('Task not found');
    }

    const id = uuidv4();
    const now = this.now();
    const log: TaskLog = {
      id,
      task_number: task.task_number,
      message,
      created_by: createdBy as 'agent' | 'user',
      created_at: now
    };

    // Append to logs array in task file or create new logs file
    const logsFile = path.join(this.tasksDir, `${task.id}.logs.json`);
    let logs: TaskLog[] = [];
    if (existsSync(logsFile)) {
      try {
        logs = JSON.parse(fs.readFileSync(logsFile, 'utf-8')) as TaskLog[];
      } catch {}
    }

    logs.push(log);
    fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2), 'utf-8');

    return log;
  }

  /**
   * Get logs for a task by number
   */
  getLogs(task_number?: number): TaskLog[] {
    if (task_number !== undefined) {
      // Find task by number
      const task = this.getTaskByNumber(task_number);
      if (!task) return [];

      const logsFile = path.join(this.tasksDir, `${task.id}.logs.json`);
      if (!existsSync(logsFile)) return [];

      try {
        const logs = JSON.parse(fs.readFileSync(logsFile, 'utf-8')) as TaskLog[];
        return logs.sort((a, b) => a.created_at.localeCompare(b.created_at));
      } catch {
        return [];
      }
    }

    // Return all logs from all tasks
    const allLogs: TaskLog[] = [];
    const files = this.listFiles(this.tasksDir);
    for (const file of files) {
      if (!file.endsWith('.logs.json')) continue;
      try {
        const logs = JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), 'utf-8')) as TaskLog[];
        allLogs.push(...logs);
      } catch {}
    }
    return allLogs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * List logs with flexible input
   */
  listLogs(taskIdOrNumber?: string | number): TaskLog[] {
    if (taskIdOrNumber === undefined) return this.getLogs();
    if (typeof taskIdOrNumber === 'number') return this.getLogs(taskIdOrNumber);

    const task = this.getTaskByUUID(taskIdOrNumber);
    return task ? this.getLogs(task.task_number) : [];
  }

  /**
   * Clear logs for a task or all tasks
   */
  clearLogs(taskIdOrNumber?: string | number): number {
    if (taskIdOrNumber === undefined) {
      // Clear all logs
      const files = this.listFiles(this.tasksDir);
      let count = 0;
      for (const file of files) {
        if (!file.endsWith('.logs.json')) continue;
        const filePath = path.join(this.tasksDir, file);
        if (existsSync(filePath)) {
          fs.unlinkSync(filePath);
          count++;
        }
      }
      return -count;
    }

    // Clear logs for specific task
    let task: Task | undefined;
    if (typeof taskIdOrNumber === 'number') {
      task = this.getTaskByNumber(taskIdOrNumber);
    } else {
      task = this.getTaskByUUID(taskIdOrNumber);
    }

    if (!task) return 0;

    const logsFile = path.join(this.tasksDir, `${task.id}.logs.json`);
    if (existsSync(logsFile)) {
      fs.unlinkSync(logsFile);
    }
    return -1;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          CRITERIA OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add an acceptance criterion for a task
   */
  addAcceptanceCriterion(taskIdOrNumber: string | number, criterion: string): TaskCriterion {
    let task: Task | undefined;

    if (typeof taskIdOrNumber === 'number') {
      task = this.getTaskByNumber(taskIdOrNumber);
    } else {
      task = this.getTaskByUUID(taskIdOrNumber);
    }

    if (!task) {
      throw new Error('Task not found');
    }

    const now = this.now();
    
    // Get existing criteria to determine next ID
    let criteria: TaskCriterion[] = [];
    const criteriaFile = path.join(this.tasksDir, `${task.id}.criteria.json`);
    if (existsSync(criteriaFile)) {
      try {
        criteria = JSON.parse(fs.readFileSync(criteriaFile, 'utf-8')) as TaskCriterion[];
      } catch {}
    }

    const newId = criteria.length > 0 ? Math.max(...criteria.map(c => c.id)) + 1 : 1;
    
    const newCriterion: TaskCriterion = {
      id: newId,
      task_number: task.task_number,
      criterion,
      passed: null,
      created_at: now
    };

    criteria.push(newCriterion);
    fs.writeFileSync(criteriaFile, JSON.stringify(criteria, null, 2), 'utf-8');

    return newCriterion;
  }

  /**
   * Get criteria for a task by number
   */
  getCriteria(task_number?: number): TaskCriterion[] {
    if (task_number !== undefined) {
      // Find task by number
      const task = this.getTaskByNumber(task_number);
      if (!task) return [];

      const criteriaFile = path.join(this.tasksDir, `${task.id}.criteria.json`);
      if (!existsSync(criteriaFile)) return [];

      try {
        const criteria = JSON.parse(fs.readFileSync(criteriaFile, 'utf-8')) as TaskCriterion[];
        return criteria.sort((a, b) => a.id - b.id);
      } catch {
        return [];
      }
    }

    // Return all criteria from all tasks
    const allCriteria: TaskCriterion[] = [];
    const files = this.listFiles(this.tasksDir);
    for (const file of files) {
      if (!file.endsWith('.criteria.json')) continue;
      try {
        const criteria = JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), 'utf-8')) as TaskCriterion[];
        allCriteria.push(...criteria);
      } catch {}
    }
    return allCriteria.sort((a, b) => a.id - b.id);
  }

  /**
   * List criteria with flexible input
   */
  listCriteria(taskIdOrNumber?: string | number): TaskCriterion[] {
    if (taskIdOrNumber === undefined) return this.getCriteria();
    if (typeof taskIdOrNumber === 'number') return this.getCriteria(taskIdOrNumber);

    const task = this.getTaskByUUID(taskIdOrNumber);
    return task ? this.getCriteria(task.task_number) : [];
  }

  /**
   * Verify/update a criterion
   */
  verifyCriterion(criterionId: number, passed: boolean, note?: string): TaskCriterion | null {
    // Find the criterion across all tasks
    let foundTask: Task | undefined;
    let criteria: TaskCriterion[] = [];

    const files = this.listFiles(this.tasksDir);
    for (const file of files) {
      if (!file.endsWith('.criteria.json')) continue;

      try {
        criteria = JSON.parse(fs.readFileSync(path.join(this.tasksDir, file), 'utf-8')) as TaskCriterion[];
        const idx = criteria.findIndex(c => c.id === criterionId);
        if (idx !== -1) {
          // Find the task for this file
          const taskFile = file.replace('.criteria.json', '.json');
          foundTask = this.readJson<Task>(path.join(this.tasksDir, taskFile)) ?? undefined;
          break;
        }
      } catch {}
    }

    if (!foundTask) return null;

    // Update the criterion
    const idx = criteria.findIndex(c => c.id === criterionId);
    if (idx === -1) return null;

    criteria[idx] = {
      ...criteria[idx],
      passed: passed ? 1 : 0,
      note: note ?? undefined
    };

    const criteriaFile = path.join(this.tasksDir, `${foundTask.id}.criteria.json`);
    fs.writeFileSync(criteriaFile, JSON.stringify(criteria, null, 2), 'utf-8');

    return criteria[idx];
  }

  /**
   * Mark criterion as complete
   */
  markCriterionComplete(criterionId: string | number): TaskCriterion | null {
    return this.verifyCriterion(Number(criterionId), true);
  }

  /**
   * Mark criterion by task and ID
   */
  markCriterionCompleteByNumber(_taskId: string, criterionId: number, passed: boolean): TaskCriterion | null {
    return this.verifyCriterion(criterionId, passed);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //                          UTILITY METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * No-op for compatibility - JSON store doesn't need explicit save
   */
  save(): void {}

  /**
   * No-op for compatibility - JSON store doesn't need reload
   */
  async reload(): Promise<void> {}

  /**
   * Close - no-op for JSON store
   */
  close(): void {}
}

// Export singleton instance
export const store = new JsonStore();
