import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { existsSync, mkdirSync } from 'fs';
import type { Task, TaskLog, TaskCriterion, TaskWithEmbeds, TaskStatus, Spec, SpecStatus, Plan, PlanStatus, PlanWithTasks, SpecWithHierarchy } from '../types/sdd.js';

type SqlJsModule = {
  Database: new (data?: ArrayBuffer) => { exec(sql: string): any[]; export(): Uint8Array; close(): void; prepare(sql: string): { bind(params: any[]): void; step(): boolean; getAsArray(): any[]; free(): void } };
};

export class SqliteStore {
  private db: InstanceType<SqlJsModule['Database']> | null = null;
  private dbPath: string = '';
  private initPromise: Promise<void> | null = null;

  constructor(workspacePath?: string) {
    const basePath = workspacePath || process.env.WORKSPACE_PATH || process.cwd();
    this.dbPath = path.join(basePath, 'sdd.db');

    try {
      const dir = path.dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {}

    // Initialize sql.js asynchronously
    this.initPromise = (async () => {
      const initSqlJsFunc = await eval('import("sql.js")').then((m: any) => m.default);
      const SQLModule = await initSqlJsFunc({
        locateFile: (file: string) => {
          // Use local files from node_modules
          return path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file);
        }
      }) as SqlJsModule;
      this.db = new SQLModule.Database();

      this.initTables();
      this.migrate();

      // Load existing data from file if it exists
      if (fs.existsSync(this.dbPath)) {
        const fileBuffer = fs.readFileSync(this.dbPath);
        const existingDb = new SQLModule.Database(fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength));

        // Export all tables from existing DB and import to our DB
        const tables = ['specs', 'plans', 'tasks', 'logs', 'criteria'];
        for (const table of tables) {
          const rows = existingDb.exec(`SELECT * FROM ${table}`);
          if (rows.length > 0 && rows[0].values.length > 0) {
            const columns = rows[0].columns;
            const values = rows[0].values;

            // Insert each row
            const placeholders = columns.map(() => '?').join(',');
            const insertStmt = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`;
            const stmt = this.db!.prepare(insertStmt);

            for (const row of values) {
              stmt.bind(row);
              if (!stmt.step()) break;
              stmt.free();
            }
          }
        }
        existingDb.close();
      }
    })();
  }

  // Wait for initialization to complete
  private async ensureReady(): Promise<void> {
    if (this.db !== null) return;
    await this.initPromise!;
  }

  // ── Migrations ───────────────────────────────────────────────────────────────
  private migrate(): void {
    // v1 → v2: tasks table without task_number — drop and recreate
    const hasTaskNumberResult = this.db!.exec(
      `SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='task_number'`
    );
    const hasTaskNumber = (hasTaskNumberResult[0]?.values?.[0]?.[0] ?? 0) as number;

    if (hasTaskNumber === 0) {
      this.db!.exec('DROP TABLE IF EXISTS criteria');
      this.db!.exec('DROP TABLE IF EXISTS logs');
      this.db!.exec('DROP TABLE IF EXISTS tasks');
    }

    // v2 → v3: add plan_number column to tasks (non-destructive)
    const hasPlanNumberResult = this.db!.exec(
      `SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='plan_number'`
    );
    const hasPlanNumber = (hasPlanNumberResult[0]?.values?.[0]?.[0] ?? 0) as number;

    if (hasTaskNumber > 0 && hasPlanNumber === 0) {
      // tasks table exists but lacks plan_number — add it without FK constraint
      this.db!.exec(`ALTER TABLE tasks ADD COLUMN plan_number INTEGER`);
    }
  }

  private initTables(): void {
    // ── Specs (PAI) ────────────────────────────────────────────────────────────
    this.db!.exec(`
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
    this.db!.exec(`
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
    this.db!.exec(`
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

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id          TEXT    PRIMARY KEY,
        task_number INTEGER NOT NULL REFERENCES tasks(task_number) ON DELETE CASCADE,
        message     TEXT    NOT NULL,
        created_by  TEXT    NOT NULL DEFAULT 'agent',
        created_at  TEXT    NOT NULL
      )
    `);

    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS criteria (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_number INTEGER NOT NULL REFERENCES tasks(task_number) ON DELETE CASCADE,
        criterion   TEXT    NOT NULL,
        passed      INTEGER,          -- NULL=pending, 1=passed, 0=failed
        note        TEXT,
        created_at  TEXT    NOT NULL
      )
    `);

    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_specs_status  ON specs(status)`);
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_plans_spec    ON plans(spec_number)`);
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_plan    ON tasks(plan_number)`);
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_logs_tn       ON logs(task_number)`);
    this.db!.exec(`CREATE INDEX IF NOT EXISTS idx_criteria_tn   ON criteria(task_number)`);
  }

  // ── Mapping helpers ──────────────────────────────────────────────────────────

  private now(): string { return new Date().toISOString(); }

  private rowToSpec(row: any): Spec {
    const cols = ['spec_number', 'id', 'title', 'description', 'status', 'priority', 'estimated_hours', 'created_at', 'updated_at'];
    const values: any = {};
    for (let i = 0; i < cols.length; i++) {
      values[cols[i]] = row[i] ?? null;
    }
    return {
      spec_number:     values.spec_number,
      id:              values.id,
      title:           values.title,
      description:     values.description ?? undefined,
      status:          values.status as SpecStatus,
      priority:        values.priority ?? 1,
      estimated_hours: values.estimated_hours ?? undefined,
      created_at:      values.created_at,
      updated_at:      values.updated_at,
    };
  }

  private rowToPlan(row: any): Plan {
    const cols = ['plan_number', 'id', 'spec_number', 'title', 'description', 'sort_order', 'estimated_hours', 'created_at', 'updated_at'];
    const values: any = {};
    for (let i = 0; i < cols.length; i++) {
      values[cols[i]] = row[i] ?? null;
    }
    return {
      plan_number:     values.plan_number,
      id:              values.id,
      spec_number:     values.spec_number,
      title:           values.title,
      description:     values.description ?? undefined,
      sort_order:      values.sort_order ?? 0,
      status:          'pending' as PlanStatus, // will be overwritten by computePlanStatus
      estimated_hours: values.estimated_hours ?? undefined,
      created_at:      values.created_at,
      updated_at:      values.updated_at,
    };
  }

  private rowToTask(row: any): Task {
    const cols = ['task_number', 'id', 'plan_number', 'title', 'description', 'status', 'depends_on', 'inputs', 'expected_outputs', 'sort_order', 'spec_locked_at', 'evidence_summary', 'git_diff_snapshot', 'test_output_snapshot', 'created_at', 'updated_at'];
    const values: any = {};
    for (let i = 0; i < cols.length; i++) {
      values[cols[i]] = row[i] ?? null;
    }
    return {
      task_number:          values.task_number,
      id:                   values.id,
      plan_number:          values.plan_number ?? undefined,
      title:                values.title,
      description:          values.description ?? undefined,
      status:               values.status as TaskStatus,
      depends_on:           values.depends_on ?? undefined,
      inputs:               values.inputs ?? undefined,
      expected_outputs:     values.expected_outputs ?? undefined,
      sort_order:           values.sort_order ?? 0,
      spec_locked_at:       values.spec_locked_at ?? undefined,
      evidence_summary:     values.evidence_summary ?? undefined,
      git_diff_snapshot:    values.git_diff_snapshot ?? undefined,
      test_output_snapshot: values.test_output_snapshot ?? undefined,
      created_at:           values.created_at,
      updated_at:           values.updated_at,
    };
  }

  private rowToLog(row: any): TaskLog {
    const cols = ['id', 'task_number', 'message', 'created_by', 'created_at'];
    const values: any = {};
    for (let i = 0; i < cols.length; i++) {
      values[cols[i]] = row[i] ?? null;
    }
    return {
      id:          values.id,
      task_number: values.task_number,
      message:     values.message,
      created_by:  values.created_by as 'agent' | 'user',
      created_at:  values.created_at,
    };
  }

  private rowToCriterion(row: any): TaskCriterion {
    const cols = ['id', 'task_number', 'criterion', 'passed', 'note', 'created_at'];
    const values: any = {};
    for (let i = 0; i < cols.length; i++) {
      values[cols[i]] = row[i] ?? null;
    }
    return {
      id:          values.id,
      task_number: values.task_number,
      criterion:   values.criterion,
      passed:      values.passed === null || values.passed === undefined ? null : (values.passed === 1 ? 1 : 0),
      note:        values.note ?? undefined,
      created_at:  values.created_at,
    };
  }

  // Helper to execute query and return rows
  private execQuery(sql: string, params: any[] = []): any[][] {
    const stmt = this.db!.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }

    const results: any[][] = [];
    while (stmt.step()) {
      const row = stmt.getAsArray();
      results.push(row);
    }
    stmt.free();
    return results;
  }

  // Helper to execute a single statement with parameters
  private execStatement(sql: string, params: any[] = []): void {
    const stmt = this.db!.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.free();
  }

  // Resolve a string (UUID) or number (task_number) to a task_number
  private resolveTaskNumber(idOrNumber: string | number): number | undefined {
    if (typeof idOrNumber === 'number') return idOrNumber;
    const rows = this.execQuery('SELECT task_number FROM tasks WHERE id = ?', [idOrNumber]);
    return rows.length > 0 ? rows[0][0] : undefined;
  }

  // ── Spec CRUD ─────────────────────────────────────────────────────────────────

  createSpec(title: string, description?: string, priority: number = 1, estimated_hours?: number): Spec {
    const id  = uuidv4();
    const now = this.now();
    this.execStatement(
      `INSERT INTO specs (id, title, description, status, priority, estimated_hours, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [id, title, description || null, priority, estimated_hours ?? null, now, now]
    );
    return this.getSpecByUUID(id)!;
  }

  getSpecByUUID(id: string): Spec | undefined {
    const rows = this.execQuery('SELECT * FROM specs WHERE id = ?', [id]);
    return rows.length > 0 ? this.rowToSpec(rows[0]) : undefined;
  }

  getSpecByNumber(n: number): Spec | undefined {
    const rows = this.execQuery('SELECT * FROM specs WHERE spec_number = ?', [n]);
    return rows.length > 0 ? this.rowToSpec(rows[0]) : undefined;
  }

  listSpecs(status?: SpecStatus): Spec[] {
    if (status) {
      const rows = this.execQuery('SELECT * FROM specs WHERE status = ? ORDER BY priority DESC, spec_number ASC', [status]);
      return rows.map(r => this.rowToSpec(r));
    }
    const rows = this.execQuery('SELECT * FROM specs ORDER BY priority DESC, spec_number ASC');
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
      const rows = this.execQuery('SELECT spec_number FROM specs WHERE id = ?', [idOrNumber]);
      specNumber = rows.length > 0 ? rows[0][0] : undefined;
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
    this.execStatement(`UPDATE specs SET ${fields.join(', ')} WHERE spec_number = ?`, values);
    return this.getSpecByNumber(specNumber)!;
  }

  deleteSpec(idOrNumber: string | number): boolean {
    let specNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      specNumber = idOrNumber;
    } else {
      const rows = this.execQuery('SELECT spec_number FROM specs WHERE id = ?', [idOrNumber]);
      specNumber = rows.length > 0 ? rows[0][0] : undefined;
    }
    if (!specNumber) return false;

    // Application-level cascade: delete all tasks (+ their logs/criteria via FK CASCADE)
    // that belong to plans of this spec, before deleting the spec itself.
    const planRows = this.execQuery('SELECT plan_number FROM plans WHERE spec_number = ?', [specNumber]);
    const planNumbers = planRows.map((r: any) => r[0]);

    for (const pn of planNumbers) {
      // Delete tasks linked to this plan (logs + criteria cascade via FK)
      this.execStatement('DELETE FROM tasks WHERE plan_number = ?', [pn]);
    }

    // Now delete the spec — plans cascade via FK
    this.execStatement('DELETE FROM specs WHERE spec_number = ?', [specNumber]);

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

    const maxOrderResult = this.execQuery(
      'SELECT MAX(sort_order) as m FROM plans WHERE spec_number = ?', [spec_number]
    );
    const maxOrder = sort_order ?? ((maxOrderResult[0]?.[0] ?? -1) + 1);

    this.execStatement(
      `INSERT INTO plans (id, spec_number, title, description, sort_order, estimated_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, spec_number, title, description || null, maxOrder, estimated_hours ?? null, now, now]
    );

    return this.getPlanByUUID(id)!;
  }

  getPlanByUUID(id: string): Plan | undefined {
    const rows = this.execQuery('SELECT * FROM plans WHERE id = ?', [id]);
    if (rows.length === 0) return undefined;
    const plan = this.rowToPlan(rows[0]);
    plan.status = this.computePlanStatus(plan.plan_number);
    return plan;
  }

  getPlanByNumber(n: number): Plan | undefined {
    const rows = this.execQuery('SELECT * FROM plans WHERE plan_number = ?', [n]);
    if (rows.length === 0) return undefined;
    const plan = this.rowToPlan(rows[0]);
    plan.status = this.computePlanStatus(plan.plan_number);
    return plan;
  }

  listPlansBySpec(spec_number: number): Plan[] {
    const rows = this.execQuery(
      'SELECT * FROM plans WHERE spec_number = ? ORDER BY sort_order ASC, plan_number ASC',
      [spec_number]
    );
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
      const rows = this.execQuery('SELECT plan_number FROM plans WHERE id = ?', [idOrNumber]);
      planNumber = rows.length > 0 ? rows[0][0] : undefined;
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
    this.execStatement(`UPDATE plans SET ${fields.join(', ')} WHERE plan_number = ?`, values);
    return this.getPlanByNumber(planNumber)!;
  }

  deletePlan(idOrNumber: string | number): boolean {
    let planNumber: number | undefined;
    if (typeof idOrNumber === 'number') {
      planNumber = idOrNumber;
    } else {
      const rows = this.execQuery('SELECT plan_number FROM plans WHERE id = ?', [idOrNumber]);
      planNumber = rows.length > 0 ? rows[0][0] : undefined;
    }
    if (!planNumber) return false;
    this.execStatement('DELETE FROM plans WHERE plan_number = ?', [planNumber]);
    return true;
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
    const maxOrderResult = this.execQuery('SELECT MAX(sort_order) as m FROM tasks');
    const maxOrder = (maxOrderResult[0]?.[0] ?? -1);

    this.execStatement(
      `INSERT INTO tasks (id, plan_number, title, description, status, depends_on, inputs, expected_outputs, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, plan_number ?? null, title, description || null, status, dependsOnNumber, inputs || null, expected_outputs || null, maxOrder + 1, now, now]
    );

    return this.getTaskByUUID(id)!;
  }

  getTask(id: string): Task | undefined          { return this.getTaskByUUID(id); }
  readTask(id: string): Task | undefined         { return this.getTaskByUUID(id); }

  getTaskByUUID(id: string): Task | undefined {
    const rows = this.execQuery('SELECT * FROM tasks WHERE id = ?', [id]);
    return rows.length > 0 ? this.rowToTask(rows[0]) : undefined;
  }

  getTaskByNumber(taskNumber: number): Task | undefined {
    const rows = this.execQuery('SELECT * FROM tasks WHERE task_number = ?', [taskNumber]);
    return rows.length > 0 ? this.rowToTask(rows[0]) : undefined;
  }

  getTaskWithEmbeds(taskNumber: number): TaskWithEmbeds | undefined {
    const task = this.getTaskByNumber(taskNumber);
    if (!task) return undefined;
    return { ...task, logs: this.getLogs(taskNumber), criteria: this.getCriteria(taskNumber) };
  }

  listTasks(status?: TaskStatus): Task[] {
    if (status) {
      const rows = this.execQuery('SELECT * FROM tasks WHERE status = ? ORDER BY sort_order ASC, task_number ASC', [status]);
      return rows.map(r => this.rowToTask(r));
    }
    const rows = this.execQuery('SELECT * FROM tasks ORDER BY sort_order ASC, task_number ASC');
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
    const rows = this.execQuery(
      'SELECT * FROM tasks WHERE plan_number = ? ORDER BY sort_order ASC, task_number ASC',
      [plan_number]
    );
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
    this.execStatement(`UPDATE tasks SET ${fields.join(', ')} WHERE task_number = ?`, values);

    return this.getTaskByNumber(taskNumber)!;
  }

  updateTaskStatus(id: string, status: TaskStatus): Task | null {
    return this.updateTask(id, { status });
  }

  deleteTask(idOrNumber: string | number): boolean {
    const taskNumber = this.resolveTaskNumber(idOrNumber);
    if (!taskNumber) return false;
    this.execStatement('DELETE FROM tasks WHERE task_number = ?', [taskNumber]);
    return true;
  }

  updateSortOrder(taskNumbers: number[]): void {
    for (let i = 0; i < taskNumbers.length; i++) {
      this.execStatement('UPDATE tasks SET sort_order = ? WHERE task_number = ?', [i, taskNumbers[i]]);
    }
  }

  // ── Log operations ───────────────────────────────────────────────────────────

  addLog(taskIdOrNumber: string | number, message: string, createdBy: string = 'agent'): TaskLog {
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) throw new Error('Task not found');

    const id  = uuidv4();
    const now = this.now();
    this.execStatement(
      'INSERT INTO logs (id, task_number, message, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, taskNumber, message, createdBy, now]
    );

    return { id, task_number: taskNumber, message, created_by: createdBy as any, created_at: now };
  }

  getLogs(taskNumber?: number): TaskLog[] {
    if (taskNumber !== undefined) {
      const rows = this.execQuery('SELECT * FROM logs WHERE task_number = ? ORDER BY created_at ASC', [taskNumber]);
      return rows.map(r => this.rowToLog(r));
    }
    const rows = this.execQuery('SELECT * FROM logs ORDER BY created_at ASC');
    return rows.map(r => this.rowToLog(r));
  }

  listLogs(taskIdOrNumber?: string | number): TaskLog[] {
    if (taskIdOrNumber === undefined) return this.getLogs();
    if (typeof taskIdOrNumber === 'number') return this.getLogs(taskIdOrNumber);
    const t = this.getTaskByUUID(taskIdOrNumber);
    return t ? this.getLogs(t.task_number) : [];
  }

  clearLogs(taskIdOrNumber?: string | number): number {
    if (taskIdOrNumber === undefined) {
      this.execStatement('DELETE FROM logs');
      // sql.js doesn't provide changes() easily, so we return -1 to indicate all cleared
      return -1;
    }
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) return 0;
    this.execStatement('DELETE FROM logs WHERE task_number = ?', [taskNumber]);
    return -1;
  }

  // ── Criteria operations ──────────────────────────────────────────────────────

  addAcceptanceCriterion(taskIdOrNumber: string | number, criterion: string): TaskCriterion {
    const taskNumber = this.resolveTaskNumber(taskIdOrNumber);
    if (!taskNumber) throw new Error('Task not found');

    const now    = this.now();
    this.execStatement(
      'INSERT INTO criteria (task_number, criterion, created_at) VALUES (?, ?, ?)',
      [taskNumber, criterion, now]
    );

    // Get the last inserted row id
    const rows = this.execQuery('SELECT * FROM criteria WHERE task_number = ? ORDER BY id DESC LIMIT 1', [taskNumber]);
    if (rows.length === 0) throw new Error('Failed to insert criterion');

    return { id: rows[0][0], task_number: taskNumber, criterion, passed: null, created_at: now };
  }

  getCriteria(taskNumber?: number): TaskCriterion[] {
    if (taskNumber !== undefined) {
      const rows = this.execQuery('SELECT * FROM criteria WHERE task_number = ? ORDER BY id ASC', [taskNumber]);
      return rows.map(r => this.rowToCriterion(r));
    }
    const rows = this.execQuery('SELECT * FROM criteria ORDER BY id ASC');
    return rows.map(r => this.rowToCriterion(r));
  }

  listCriteria(taskIdOrNumber?: string | number): TaskCriterion[] {
    if (taskIdOrNumber === undefined) return this.getCriteria();
    if (typeof taskIdOrNumber === 'number') return this.getCriteria(taskIdOrNumber);
    const t = this.getTaskByUUID(taskIdOrNumber);
    return t ? this.getCriteria(t.task_number) : [];
  }

  verifyCriterion(criterionId: number, passed: boolean, note?: string): TaskCriterion | null {
    this.execStatement(
      'UPDATE criteria SET passed = ?, note = ? WHERE id = ?',
      [passed ? 1 : 0, note || null, criterionId]
    );
    const rows = this.execQuery('SELECT * FROM criteria WHERE id = ?', [criterionId]);
    return rows.length > 0 ? this.rowToCriterion(rows[0]) : null;
  }

  markCriterionComplete(criterionId: string | number): TaskCriterion | null {
    return this.verifyCriterion(Number(criterionId), true);
  }

  markCriterionCompleteByNumber(_taskId: string, criterionId: number, passed: boolean): TaskCriterion | null {
    return this.verifyCriterion(criterionId, passed);
  }

  // ── Utility ──────────────────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      // Save database to file before closing
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
      this.db.close();
    }
  }

  save(): void {
    if (this.db) {
      // Save database to file
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    }
  }
}

export const store = new SqliteStore();
