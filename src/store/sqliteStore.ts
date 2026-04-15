import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import type { Task, TaskLog, TaskCriterion, TaskWithEmbeds, TaskStatus } from '../types/sdd.js';

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

  // Drop old schema (id TEXT PRIMARY KEY without task_number) and recreate
  private migrate(): void {
    const hasTaskNumber = (this.db.prepare(
      `SELECT COUNT(*) as c FROM pragma_table_info('tasks') WHERE name='task_number'`
    ).get() as any)?.c ?? 0;

    if (hasTaskNumber === 0) {
      this.db.exec('DROP TABLE IF EXISTS criteria');
      this.db.exec('DROP TABLE IF EXISTS logs');
      this.db.exec('DROP TABLE IF EXISTS tasks');
    }
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_number       INTEGER PRIMARY KEY AUTOINCREMENT,
        id                TEXT    UNIQUE NOT NULL,
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

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_tn     ON logs(task_number)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_criteria_tn ON criteria(task_number)`);
  }

  // ── Mapping helpers ──────────────────────────────────────────────────────────

  private now(): string { return new Date().toISOString(); }

  private rowToTask(row: any): Task {
    return {
      task_number:          row.task_number,
      id:                   row.id,
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

  // ── Task CRUD ────────────────────────────────────────────────────────────────

  createTask(
    title: string,
    description?: string,
    status: TaskStatus = 'open',
    depends_on?: string | number,
    inputs?: string,
    expected_outputs?: string
  ): Task {
    const id  = uuidv4();
    const now = this.now();

    const dependsOnNumber = depends_on != null ? this.resolveTaskNumber(depends_on) ?? null : null;
    const maxOrder = (this.db.prepare('SELECT MAX(sort_order) as m FROM tasks').get() as any)?.m ?? -1;

    this.db.prepare(`
      INSERT INTO tasks (id, title, description, status, depends_on, inputs, expected_outputs, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, description || null, status, dependsOnNumber, inputs || null, expected_outputs || null, maxOrder + 1, now, now);

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
