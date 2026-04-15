import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Task, TaskLog, TaskCriterion, TaskWithEmbeds, TaskStatus, Spec, SpecStatus, Plan, PlanStatus, PlanWithTasks, SpecWithHierarchy } from '../types/sdd.js';

export class SqliteStore {
  private db: Database.Database;

  constructor(workspacePath?: string) {
    const basePath = workspacePath || process.env.WORKSPACE_PATH || process.cwd();
    const dbPath = path.join(basePath, 'sdd.db');

    try {
      const dir = path.dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {}

    this.db = new Database(dbPath);
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.initTables();
  }

  // ── Migrations ───────────────────────────────────────────────────────────────
  private migrate(): void {
    // v1 → v2: tasks table without task_number — drop and recreate
    const hasTaskNumber = (this.db.prepare(
      `SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='task_number'`
    ).get() as any)?.c ?? 0;

    if (hasTaskNumber === 0) {
      this.db.exec('DROP TABLE IF EXISTS criteria');
      this.db.exec('DROP TABLE IF EXISTS logs');
      this.db.exec('DROP TABLE IF EXISTS tasks');
    }

    // v2 → v3: add plan_number column to tasks (non-destructive)
    const hasPlanNumber = (this.db.prepare(
      `SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='plan_number'`
    ).get() as any)?.c ?? 0;

    if (hasTaskNumber > 0 && hasPlanNumber === 0) {
      // tasks table exists but lacks plan_number — add it without FK constraint
      // (SQLite ALTER TABLE ADD COLUMN with FK on non-empty tables is unreliable)
      this.db.exec(`ALTER TABLE tasks ADD COLUMN plan_number INTEGER`);
    }
  }

  private initTables(): void {
    // ── Specs (PAI) ────────────────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS specs (
        spec_number      INTEGER PRIMARY KEY AUTOINCREMENT,
        id               TEXT    UNIQUE NOT NULL,
        title            TEXT    NOT NULL,
        description      TEXT,
        status           TEXT    NOT NULL DEFAULT 'draft',
        priority         INTEGER NOT NULL DEFAULT 1,
        estimated_hours  REAL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      )
    `);

    // ── Plans (FILHA de spec, PAI de tasks) ────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_number      INTEGER PRIMARY KEY AUTOINCREMENT,
        id               TEXT    UNIQUE NOT NULL,
        spec_number      INTEGER NOT NULL REFERENCES specs(spec_number) ON DELETE CASCADE,
        title            TEXT    NOT NULL,
        description      TEXT,
        sort_order       INTEGER NOT NULL DEFAULT 0,
        estimated_hours  REAL,
        created_at       TEXT    NOT NULL,
        updated_at       TEXT    NOT NULL
      )
    `);

    // ── Tasks (FILHA de plan) ─────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_number       INTEGER PRIMARY KEY AUTOINCREMENT,
        id                TEXT    UNIQUE NOT NULL,
        plan_number       INTEGER REFERENCES plans(plan_number) ON DELETE SET NULL,
        title             TEXT    NOT NULL,
        description       TEXT,
        status            TEXT    NOT NULL DEFAULT 'open',
        depends_on        INTEGER REFERENCES tasks(task_number) ON DELETE SET NULL,
        inputs            TEXT,
        expected_outputs  TEXT,
        sort_order        INTEGER DEFAULT 0,
        spec_locked_at    TEXT,
        evidence_summary  TEXT,
        git_diff_snapshot TEXT,
        test_output_snapshot TEXT,
        created_at        TEXT    NOT NULL,
        updated_at        TEXT    NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id          TEXT    PRIMARY KEY,
        task_number INTEGER NOT NULL REFERENCES tasks(task_number) ON DELETE CASCADE,
        message     TEXT    NOT NULL,
        created_by  TEXT    NOT NULL DEFAULT 'agent',
        created_at  TEXT    NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS criteria (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_number INTEGER NOT NULL REFERENCES tasks(task_number) ON DELETE CASCADE,
        criterion   TEXT    NOT NULL,
        passed      INTEGER,          -- NULL=pending, 1=passed, 0=failed
        note        TEXT,
        created_at  TEXT    NOT NULL
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_specs_status  ON specs(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_spec    ON plans(spec_number)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_plan    ON tasks(plan_number)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_tn       ON logs(task_number)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_criteria_tn   ON criteria(task_number)`);
  }

  // ── Mapping helpers ──────────────────────────────────────────────────────────

  private now(): string { return new Date().toISOString(); }

  private rowToSpec(row: any): Spec {
    return {
      spec_number:     row.spec_number,
      id:              row.id,
      title:           row.title,
      description:     row.description ?? undefined,
      status:          row.status as SpecStatus,
      priority:        row.priority ?? 1,
      estimated_hours: row.estimated_hours ?? undefined,
      created_at:      row.created_at,
      updated_at:      row.updated_at,
    };
  }

  private rowToPlan(row: any): Plan {
    return {
      plan_number:     row.plan_number,
      id:              row.id,
      spec_number:     row.spec_number,
      title:           row.title,
      description:     row.description ?? undefined,
      sort_order:      row.sort_order ?? 0,
      status:          'pending' as PlanStatus, // will be overwritten by computePlanStatus
      estimated_hours: row.estimated_hours ?? undefined,
      created_at:      row.created_at,
      updated_at:      row.updated_at,
    };
  }

  private rowToTask(row: any): Task {
    return {
      task_number:          row.task_number,
      id:                   row.id,
      plan_number:          row.plan_number ?? undefined,
      title:                row.title,
      description:          row.description ?? undefined,
      status:               row.status as TaskStatus,
      depends_on:           row.depends_on ?? undefined,
      inputs:               row.inputs ?? undefined,
      expected_outputs:     row.expected_outputs ?? undefined,
      sort_order:           row.sort_order ?? 0,
      spec_locked_at:       row.spec_locked_at ?? undefined,
      evidence_summary:     row.evidence_summary ?? undefined,
      git_diff_snapshot:    row.git_diff_snapshot ?? undefined,
      test_output_snapshot: row.test_output_snapshot ?? undefined,
      created_at:           row.created_at,
      updated_at:           row.updated_at,
    };
  }

  private rowToLog(row: any): TaskLog {
    return {
      id:          row.id,
      task_number: row.task_number,
      message:     row.message,
      created_by:  row.created_by as 'agent' | 'user',
      created_at:  row.created_at,
    };
  }

  private rowToCriterion(row: any): TaskCriterion {
    return {
      id:          row.id,
      task_number: row.task_number,
      criterion:   row.criterion,
      passed:      row.passed === null || row.passed === undefined ? null : (row.passed === 1 ? 1 : 0),
      note:        row.note ?? undefined,
      created_at:  row.created_at,
    };
  }

  // Resolve a string (UUID) or number (task_number) to a task_number
  private resolveTaskNumber(idOrNumber: string | number): number | undefined {
    if (typeof idOrNumber === 'number') return idOrNumber;
    const row = this.db.prepare('SELECT task_number FROM tasks WHERE id = ?').get(idOrNumber) as any;
    return row?.task_number;
  }

  // ── Spec CRUD ─────────────────────────────────────────────────────────────────

  createSpec(title: string, description?: string, priority: number = 1, estimated_hours?: number): Spec {
    const id  = uuidv4();
    const now = this.now();
    this.db.prepare(`
      INSERT INTO specs (id, title, description, status, priority, estimated_hours, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(id, title, description || null, priority, estimated_hours ?? null, now, now);
    return this.getSpecByUUID(id)!;
  }

  getSpecByUUID(id: string): Spec | undefined {
    const row = this.db.prepare('SELECT * FROM specs WHERE id = ?').get(id) as any;
    return row ? this.rowToSpec(row) : undefined;
  }

  getSpecByNumber(n: number): Spec | undefined {
    const row = this.db.prepare('SELECT * FROM specs WHERE spec_number = ?').get(n) as any;
    return row ? this.rowToSpec(row) : undefined;
  }

  listSpecs(status?: SpecStatus): Spec[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM specs WHERE status = ? ORDER BY priority DESC, spec_number ASC').all(status) as any[]
      : this.db.prepare('SELECT * FROM specs ORDER BY priority DESC, spec_number ASC').all() as any[];
    return rows.map(r => this.rowToSpec(r));
  }

  updateSpec(
    idOrNumber: string | number,
    updates: Partial<Omit<Spec, 'spec_number' | 'id' | 'created_at'>>
  ): Spec | null {
    let specNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      specNumber = idOrNumber;
    } else {
      specNumber = (this.db.prepare('SELECT spec_number FROM specs WHERE id = ?').get(idOrNumber) as any)?.spec_number;
    }
    if (!specNumber) return null;

    const fields: string[] = [];
    const values: any[] = [];
    const add = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };

    if (updates.title           !== undefined) add('title',           updates.title);
    if (updates.description     !== undefined) add('description',     updates.description || null);
    if (updates.status          !== undefined) add('status',          updates.status);
    if (updates.priority        !== undefined) add('priority',        updates.priority);
    if (updates.estimated_hours !== undefined) add('estimated_hours', updates.estimated_hours ?? null);

    if (fields.length === 0) return this.getSpecByNumber(specNumber) ?? null;

    add('updated_at', this.now());
    values.push(specNumber);
    this.db.prepare(`UPDATE specs SET ${fields.join(', ')} WHERE spec_number = ?`).run(...values);
    return this.getSpecByNumber(specNumber)!;
  }

  deleteSpec(idOrNumber: string | number): boolean {
    let specNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      specNumber = idOrNumber;
    } else {
      specNumber = (this.db.prepare('SELECT spec_number FROM specs WHERE id = ?').get(idOrNumber) as any)?.spec_number;
    }
    if (!specNumber) return false;

    // Application-level cascade: delete all tasks (+ their logs/criteria via FK CASCADE)
    // that belong to plans of this spec, before deleting the spec itself.
    // (tasks.plan_number is SET NULL when plans are deleted, so we must delete tasks first)
    this.db.transaction(() => {
      const planNumbers = (this.db.prepare(
        'SELECT plan_number FROM plans WHERE spec_number = ?'
      ).all(specNumber!) as any[]).map((r: any) => r.plan_number);

      for (const pn of planNumbers) {
        // Delete tasks linked to this plan (logs + criteria cascade via FK)
        this.db.prepare('DELETE FROM tasks WHERE plan_number = ?').run(pn);
      }

      // Now delete the spec — plans cascade via FK
      this.db.prepare('DELETE FROM specs WHERE spec_number = ?').run(specNumber!);
    })();

    return true;
  }

  // Compute spec progress (for dashboard display)
  getSpecProgress(spec_number: number): { total_plans: number; done_plans: number; total_tasks: number; done_tasks: number } {
    const plans = this.listPlansBySpec(spec_number);
    const total_plans = plans.length;
    const done_plans  = plans.filter(p => p.status === 'done').length;
    const allTasks    = plans.flatMap(p => this.listTasksByPlan(p.plan_number));
    return {
      total_plans,
      done_plans,
      total_tasks: allTasks.length,
      done_tasks:  allTasks.filter(t => t.status === 'done').length,
    };
  }

  // ── Plan CRUD ─────────────────────────────────────────────────────────────────

  computePlanStatus(plan_number: number): PlanStatus {
    const tasks = this.listTasksByPlan(plan_number);
    if (tasks.length === 0) return 'pending';
    if (tasks.every(t => t.status === 'done')) return 'done';
    if (tasks.some(t => t.status === 'error')) return 'blocked';
    if (tasks.some(t => t.status === 'in-progress' || t.status === 'pending-verification')) return 'in-progress';
    return 'pending';
  }

  createPlan(spec_number: number, title: string, description?: string, sort_order?: number, estimated_hours?: number): Plan {
    const id  = uuidv4();
    const now = this.now();

    const maxOrder = sort_order ?? ((this.db.prepare(
      'SELECT MAX(sort_order) as m FROM plans WHERE spec_number = ?'
    ).get(spec_number) as any)?.m ?? -1) + 1;

    this.db.prepare(`
      INSERT INTO plans (id, spec_number, title, description, sort_order, estimated_hours, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, spec_number, title, description || null, maxOrder, estimated_hours ?? null, now, now);

    return this.getPlanByUUID(id)!;
  }

  getPlanByUUID(id: string): Plan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as any;
    if (!row) return undefined;
    const plan = this.rowToPlan(row);
    plan.status = this.computePlanStatus(plan.plan_number);
    return plan;
  }

  getPlanByNumber(n: number): Plan | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_number = ?').get(n) as any;
    if (!row) return undefined;
    const plan = this.rowToPlan(row);
    plan.status = this.computePlanStatus(plan.plan_number);
    return plan;
  }

  listPlansBySpec(spec_number: number): Plan[] {
    const rows = this.db.prepare(
      'SELECT * FROM plans WHERE spec_number = ? ORDER BY sort_order ASC, plan_number ASC'
    ).all(spec_number) as any[];
    return rows.map(r => {
      const plan = this.rowToPlan(r);
      plan.status = this.computePlanStatus(plan.plan_number);
      return plan;
    });
  }

  updatePlan(
    idOrNumber: string | number,
    updates: Partial<Omit<Plan, 'plan_number' | 'id' | 'created_at' | 'status'>>
  ): Plan | null {
    let planNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      planNumber = idOrNumber;
    } else {
      planNumber = (this.db.prepare('SELECT plan_number FROM plans WHERE id = ?').get(idOrNumber) as any)?.plan_number;
    }
    if (!planNumber) return null;

    const fields: string[] = [];
    const values: any[] = [];
    const add = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };

    if (updates.title           !== undefined) add('title',           updates.title);
    if (updates.description     !== undefined) add('description',     updates.description || null);
    if (updates.sort_order      !== undefined) add('sort_order',      updates.sort_order);
    if (updates.estimated_hours !== undefined) add('estimated_hours', updates.estimated_hours ?? null);

    if (fields.length === 0) return this.getPlanByNumber(planNumber) ?? null;

    add('updated_at', this.now());
    values.push(planNumber);
    this.db.prepare(`UPDATE plans SET ${fields.join(', ')} WHERE plan_number = ?`).run(...values);
    return this.getPlanByNumber(planNumber)!;
  }

  deletePlan(idOrNumber: string | number): boolean {
    let planNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      planNumber = idOrNumber;
    } else {
      planNumber = (this.db.prepare('SELECT plan_number FROM plans WHERE id = ?').get(idOrNumber) as any)?.plan_number;
    }
    if (!planNumber) return false;
    return (this.db.prepare('DELETE FROM plans WHERE plan_number = ?').run(planNumber)).changes > 0;
  }

  getSpecWithHierarchy(spec_number: number): SpecWithHierarchy | undefined {
    const spec = this.getSpecByNumber(spec_number);
    if (!spec) return undefined;
    const plans = this.listPlansBySpec(spec_number);
    return {
      ...spec,
      plans: plans.map(p => ({
        ...p,
        tasks: this.listTasksByPlan(p.plan_number).map(t => ({
          ...t,
          logs:     this.getLogs(t.task_number),
          criteria: this.getCriteria(t.task_number),
        })),
      })),
    };
  }

  // ── Task CRUD ────────────────────────────────────────────────────────────────

  createTask(
    title: string,
    description?: string,
    status: TaskStatus = 'open',
    depends_on?: string | number,
    inputs?: string,
    expected_outputs?: string,
    plan_number?: number
  ): Task {
    const id  = uuidv4();
    const now = this.now();

    const dependsOnNumber = depends_on != null ? this.resolveTaskNumber(depends_on) ?? null : null;
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) as m FROM tasks').get() as any)?.m ?? -1;

    this.db.prepare(`
      INSERT INTO tasks (id, plan_number, title, description, status, depends_on, inputs, expected_outputs, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, plan_number ?? null, title, description || null, status, dependsOnNumber, inputs || null, expected_outputs || null, maxOrder + 1, now, now);

    return this.getTaskByUUID(id)!;
  }

  getTask(id: string): Task | undefined          { return this.getTaskByUUID(id); }
  readTask(id: string): Task | undefined         { return this.getTaskByUUID(id); }

  getTaskByUUID(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    return row ? this.rowToTask(row) : undefined;
  }

  getTaskByNumber(taskNumber: number): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_number = ?').get(taskNumber) as any;
    return row ? this.rowToTask(row) : undefined;
  }

  getTaskWithEmbeds(taskNumber: number): TaskWithEmbeds | undefined {
    const task = this.getTaskByNumber(taskNumber);
    if (!task) return undefined;
    return { ...task, logs: this.getLogs(taskNumber), criteria: this.getCriteria(taskNumber) };
  }

  listTasks(status?: TaskStatus): Task[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY sort_order ASC, task_number ASC').all(status) as any[]
      : this.db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, task_number ASC').all() as any[];
    return rows.map(r => this.rowToTask(r));
  }

  listTasksWithEmbeds(status?: TaskStatus): TaskWithEmbeds[] {
    return this.listTasks(status).map(t => ({
      ...t,
      logs:     this.getLogs(t.task_number),
      criteria: this.getCriteria(t.task_number),
    }));
  }

  listTasksByPlan(plan_number: number): Task[] {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE plan_number = ? ORDER BY sort_order ASC, task_number ASC'
    ).all(plan_number) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  listTasksByPlanWithEmbeds(plan_number: number): TaskWithEmbeds[] {
    return this.listTasksByPlan(plan_number).map(t => ({
      ...t,
      logs:     this.getLogs(t.task_number),
      criteria: this.getCriteria(t.task_number),
    }));
  }

  updateTask(
    idOrNumber: string | number,
    updates: Partial<Omit<Task, 'task_number' | 'id' | 'created_at'>>
  ): Task | null {
    const taskNumber = this.resolveTaskNumber(idOrNumber);
    if (!taskNumber) return null;

    const fields: string[] = [];
    const values: any[]   = [];

    const add = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };

    if (updates.title              !== undefined) add('title',              updates.title);
    if (updates.description        !== undefined) add('description',        updates.description || null);
    if (updates.status             !== undefined) add('status',             updates.status);
    if (updates.inputs             !== undefined) add('inputs',             updates.inputs || null);
    if (updates.expected_outputs   !== undefined) add('expected_outputs',   updates.expected_outputs || null);
    if (updates.sort_order         !== undefined) add('sort_order',         updates.sort_order);
    if (updates.plan_number        !== undefined) add('plan_number',        updates.plan_number ?? null);
    if (updates.spec_locked_at     !== undefined) add('spec_locked_at',     updates.spec_locked_at || null);
    if (updates.evidence_summary   !== undefined) add('evidence_summary',   updates.evidence_summary || null);
    if (updates.git_diff_snapshot  !== undefined) add('git_diff_snapshot',  updates.git_diff_snapshot || null);
    if (updates.test_output_snapshot !== undefined) add('test_output_snapshot', updates.test_output_snapshot || null);

    if ('depends_on' in updates) {
      const dep = updates.depends_on;
      if (dep == null) {
        add('depends_on', null);
      } else {
        add('depends_on', this.resolveTaskNumber(dep as any) ?? null);
      }
    }

    if (fields.length === 0) return this.getTaskByNumber(taskNumber) ?? null;

    add('updated_at', this.now());
    values.push(taskNumber);
    this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE task_number = ?`).run(...values);

    return this.getTaskByNumber(taskNumber)!;
  }

  updateTaskStatus(id: string, status: TaskStatus): Task | null {
    return this.updateTask(id, { status });
  }

  deleteTask(idOrNumber: string | number): boolean {
    const taskNumber = this.resolveTaskNumber(idOrNumber);
    if (!taskNumber) return false;
    return (this.db.prepare('DELETE FROM tasks WHERE task_number = ?').run(taskNumber)).changes > 0;
  }

  updateSortOrder(taskNumbers: number[]): void {
    const stmt = this.db.prepare('UPDATE tasks SET sort_order = ? WHERE task_number = ?');
    this.db.transaction(() => { taskNumbers.forEach((tn, i) => stmt.run(i, tn)); })();
  }

  // ── Log operations ───────────────────────────────────────────────────────────

  addLog(taskIdOrNumber: string | number, message: string, createdBy: string = 'agent'): TaskLog {
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) throw new Error('Task not found');

    const id  = uuidv4();
    const now = this.now();
    this.db.prepare('INSERT INTO logs (id, task_number, message, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
           .run(id, taskNumber, message, createdBy, now);

    return { id, task_number: taskNumber, message, created_by: createdBy as any, created_at: now };
  }

  getLogs(taskNumber?: number): TaskLog[] {
    const rows = taskNumber
      ? this.db.prepare('SELECT * FROM logs WHERE task_number = ? ORDER BY created_at ASC').all(taskNumber) as any[]
      : this.db.prepare('SELECT * FROM logs ORDER BY created_at ASC').all() as any[];
    return rows.map(r => this.rowToLog(r));
  }

  listLogs(taskIdOrNumber?: string | number): TaskLog[] {
    if (taskIdOrNumber === undefined) return this.getLogs();
    if (typeof taskIdOrNumber === 'number') return this.getLogs(taskIdOrNumber);
    const t = this.getTaskByUUID(taskIdOrNumber);
    return t ? this.getLogs(t.task_number) : [];
  }

  clearLogs(taskIdOrNumber?: string | number): number {
    if (taskIdOrNumber === undefined)
      return (this.db.prepare('DELETE FROM logs').run()).changes;
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) return 0;
    return (this.db.prepare('DELETE FROM logs WHERE task_number = ?').run(taskNumber)).changes;
  }

  // ── Criteria operations ──────────────────────────────────────────────────────

  addAcceptanceCriterion(taskIdOrNumber: string | number, criterion: string): TaskCriterion {
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) throw new Error('Task not found');

    const now    = this.now();
    const result = this.db.prepare('INSERT INTO criteria (task_number, criterion, created_at) VALUES (?, ?, ?)')
                          .run(taskNumber, criterion, now);

    return { id: result.lastInsertRowid as number, task_number: taskNumber, criterion, passed: null, created_at: now };
  }

  getCriteria(taskNumber?: number): TaskCriterion[] {
    const rows = taskNumber
      ? this.db.prepare('SELECT * FROM criteria WHERE task_number = ? ORDER BY id ASC').all(taskNumber) as any[]
      : this.db.prepare('SELECT * FROM criteria ORDER BY id ASC').all() as any[];
    return rows.map(r => this.rowToCriterion(r));
  }

  listCriteria(taskIdOrNumber?: string | number): TaskCriterion[] {
    if (taskIdOrNumber === undefined) return this.getCriteria();
    if (typeof taskIdOrNumber === 'number') return this.getCriteria(taskIdOrNumber);
    const t = this.getTaskByUUID(taskIdOrNumber);
    return t ? this.getCriteria(t.task_number) : [];
  }

  verifyCriterion(criterionId: number, passed: boolean, note?: string): TaskCriterion | null {
    this.db.prepare('UPDATE criteria SET passed = ?, note = ? WHERE id = ?')
           .run(passed ? 1 : 0, note || null, criterionId);
    const row = this.db.prepare('SELECT * FROM criteria WHERE id = ?').get(criterionId) as any;
    return row ? this.rowToCriterion(row) : null;
  }

  markCriterionComplete(criterionId: string | number): TaskCriterion | null {
    return this.verifyCriterion(Number(criterionId), true);
  }

  markCriterionCompleteByNumber(_taskId: string, criterionId: number, passed: boolean): TaskCriterion | null {
    return this.verifyCriterion(criterionId, passed);
  }

  // ── Utility ──────────────────────────────────────────────────────────────────

  close(): void { this.db.close(); }
}

export const store = new SqliteStore();
