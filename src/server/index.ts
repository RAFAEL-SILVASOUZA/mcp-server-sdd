/**
 * Real-time Dashboard Server for SDD Project
 *
 * Serves the Kanban dashboard HTML and exposes a REST API that the dashboard JS consumes:
 *   GET  /api/tasks                    — all tasks with embedded logs + criteria
 *   GET  /api/tasks/:taskNumber        — single task with embeds
 *   POST /api/tasks                    — create task (+ optional criteria array)
 *   PATCH /api/tasks/:taskNumber       — update task fields + criteria
 *   DELETE /api/tasks/:taskNumber      — delete task
 *   POST /api/tasks/:taskNumber/verify — verify a criterion
 *   GET  /health
 *   WS   /ws                           — push "tasks_updated" on every mutation
 */

import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { store } from '../store/sqliteStore.js';
import type { TaskStatus } from '../types/sdd.js';

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error('Could not open browser:', err.message);
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dir      = dirname(__filename);

interface ServerState {
  httpServer: ReturnType<typeof createServer>;
  wsServer: WebSocketServer;
  port: number;
  clients: Set<WebSocket>;
  broadcast: (msg: unknown) => void;
}

let serverState: ServerState | null = null;

// ── Port discovery ────────────────────────────────────────────────────────────

function findAvailablePort(start = 3000, maxAttempts = 100): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const try_ = () => {
      const s = createServer();
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(port)));
      s.on('error', () => {
        if (++port > start + maxAttempts) reject(new Error('No available port'));
        else try_();
      });
    };
    try_();
  });
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────

function getDashboardHTML(): string {
  // dev (tsx):  __dir = src/server/  →  ../dashboard.html = src/dashboard.html
  // prod (tsc): __dir = dist/server/ →  ../dashboard.html = dist/dashboard.html
  return readFileSync(join(__dir, '../dashboard.html'), 'utf-8');
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

export async function startDashboardServer(customPort?: number): Promise<{ port: number; url: string }> {
  if (serverState) {
    return { port: serverState.port, url: `http://localhost:${serverState.port}` };
  }

  const app        = express();
  const httpServer = createServer(app);
  const wsServer   = new WebSocketServer({ server: httpServer });
  const port       = await findAvailablePort(customPort ?? 3000);
  const clients    = new Set<WebSocket>();

  app.use(express.json());

  // ── WebSocket ─────────────────────────────────────────────────────────────

  wsServer.on('connection', (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
  }

  function notifyUpdated() { broadcast({ type: 'tasks_updated' }); }

  // ── REST — Dashboard HTML ─────────────────────────────────────────────────

  app.get('/', (_req, res) => res.type('text/html').send(getDashboardHTML()));

  // ── REST — Tasks ──────────────────────────────────────────────────────────

  // GET /api/tasks
  app.get('/api/tasks', (req: Request, res: Response) => {
    try {
      const status = req.query.status as TaskStatus | undefined;
      res.json(store.listTasksWithEmbeds(status));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // GET /api/tasks/:taskNumber
  app.get('/api/tasks/:taskNumber', (req: Request, res: Response) => {
    try {
      const n    = parseInt(String(req.params.taskNumber), 10);
      const task = store.getTaskWithEmbeds(n);
      if (!task) return res.status(404).json({ error: 'Task not found' }) as any;
      res.json(task);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/tasks
  app.post('/api/tasks', (req: Request, res: Response) => {
    try {
      const { title, description, status, depends_on, inputs, expected_outputs, criteria } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' }) as any;

      const task = store.createTask(title, description, status, depends_on, inputs, expected_outputs);

      if (Array.isArray(criteria)) {
        for (const c of criteria) {
          if (typeof c === 'string' && c.trim()) {
            store.addAcceptanceCriterion(task.task_number, c.trim());
          }
        }
      }

      notifyUpdated();
      res.status(201).json(store.getTaskWithEmbeds(task.task_number));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/tasks/:taskNumber
  app.patch('/api/tasks/:taskNumber', (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.taskNumber), 10);
      const { title, description, status, depends_on, inputs, expected_outputs, criteria } = req.body;

      const updates: any = {};
      if (title              !== undefined) updates.title              = title;
      if (description        !== undefined) updates.description        = description;
      if (status             !== undefined) updates.status             = status;
      if (depends_on         !== undefined) updates.depends_on         = depends_on;
      if (inputs             !== undefined) updates.inputs             = inputs;
      if (expected_outputs   !== undefined) updates.expected_outputs   = expected_outputs;

      const task = store.updateTask(n, updates);
      if (!task) return res.status(404).json({ error: 'Task not found' }) as any;

      // Replace criteria when provided
      if (Array.isArray(criteria)) {
        // Delete existing, then re-insert
        // (simplest approach: delete all and re-add)
        const existing = store.getCriteria(n);
        // We can't easily delete by task_number without a dedicated method — add one inline
        (store as any).db.prepare('DELETE FROM criteria WHERE task_number = ?').run(n);
        for (const c of criteria) {
          if (typeof c === 'string' && c.trim()) {
            store.addAcceptanceCriterion(n, c.trim());
          }
        }
      }

      notifyUpdated();
      res.json(store.getTaskWithEmbeds(n));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/tasks/:taskNumber
  app.delete('/api/tasks/:taskNumber', (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.taskNumber), 10);
      const deleted = store.deleteTask(n);
      if (!deleted) return res.status(404).json({ error: 'Task not found' }) as any;
      notifyUpdated();
      res.status(204).send();
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // POST /api/tasks/:taskNumber/verify
  app.post('/api/tasks/:taskNumber/verify', (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.taskNumber), 10);
      const { criterionId, passed, note } = req.body;
      if (criterionId === undefined || passed === undefined) {
        return res.status(400).json({ error: 'criterionId and passed are required' }) as any;
      }

      const criterion = store.verifyCriterion(Number(criterionId), Boolean(passed), note);
      if (!criterion) return res.status(404).json({ error: 'Criterion not found' }) as any;

      // Add a log entry for the verification
      const verb = passed ? 'PASSED' : 'FAILED';
      store.addLog(n, `Criterion #${criterionId} ${verb}${note ? ': ' + note : ''}`, 'user');

      notifyUpdated();
      res.json(criterion);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── REST — Health ─────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // ── Start ─────────────────────────────────────────────────────────────────

  await new Promise<void>(resolve => httpServer.listen(port, '127.0.0.1', resolve));

  const url = `http://localhost:${port}`;
  console.error(`🚀 SDD Dashboard  →  ${url}`);
  openBrowser(url);

  serverState = { httpServer, wsServer, port, clients, broadcast };
  return { port, url };
}

export function stopDashboardServer(): void {
  if (!serverState) return;
  serverState.clients.forEach(c => c.close());
  serverState.wsServer.close();
  serverState.httpServer.close(() => { serverState = null; });
}

export function isServerRunning(): boolean { return serverState !== null; }

export function getServerPort(): number | null { return serverState?.port ?? null; }

export function broadcastToClients(message: unknown): void {
  serverState?.broadcast(message);
}
