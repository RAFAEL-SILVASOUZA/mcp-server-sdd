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
import { store } from '../store/jsonStore.js';
import type { TaskStatus, SpecStatus } from '../types/sdd.js';

// ── Version check ─────────────────────────────────────────────────────────────

const __pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
const CURRENT_VERSION: string = JSON.parse(readFileSync(__pkgPath, 'utf-8')).version;
const PACKAGE_NAME = '@rafaelsouza-ai/mcp-server-sdd';

interface VersionInfo {
  current: string;
  latest: string | null;
  outdated: boolean;
  updateCommand: string;
}

let versionInfo: VersionInfo = {
  current: CURRENT_VERSION,
  latest: null,
  outdated: false,
  updateCommand: `npx -y ${PACKAGE_NAME}@latest`
};

function checkForUpdates(): void {
  const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  fetch(url, { signal: AbortSignal.timeout(8000) })
    .then(r => r.json())
    .then((data: any) => {
      const latest: string = data.version;
      const outdated = isNewerVersion(latest, CURRENT_VERSION);
      versionInfo = { current: CURRENT_VERSION, latest, outdated, updateCommand: `npx -y ${PACKAGE_NAME}@latest` };
      if (outdated) {
        console.error(`[SDD] Update available: ${CURRENT_VERSION} → ${latest}`);
      }
    })
    .catch(() => { /* registry unreachable — ignore */ });
}

function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

export function openBrowser(url: string): void {
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

  // Reload database from disk to pick up any changes made while MCP was offline
  await store.reload();

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
  function notifyDataUpdated() { broadcast({ type: 'data_updated' }); }

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
  app.post('/api/tasks', async (req: Request, res: Response) => {
    try {
      const { title, description, status, depends_on, inputs, expected_outputs, criteria, plan_number } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' }) as any;

      const task = await store.createTask(title, description, status, depends_on, inputs, expected_outputs, plan_number ?? undefined);

      if (Array.isArray(criteria)) {
        for (const c of criteria) {
          if (typeof c === 'string' && c.trim()) {
            await store.addAcceptanceCriterion(task.task_number, c.trim());
          }
        }
      }

      notifyUpdated();
      res.status(201).json(await store.getTaskWithEmbeds(task.task_number));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // PATCH /api/tasks/:taskNumber
  app.patch('/api/tasks/:taskNumber', async (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.taskNumber), 10);
      const { title, description, status, depends_on, inputs, expected_outputs, criteria, plan_number } = req.body;

      const updates: any = {};
      if (title              !== undefined) updates.title              = title;
      if (description        !== undefined) updates.description        = description;
      if (status             !== undefined) updates.status             = status;
      if (depends_on         !== undefined) updates.depends_on         = depends_on;
      if (inputs             !== undefined) updates.inputs             = inputs;
      if (expected_outputs   !== undefined) updates.expected_outputs   = expected_outputs;
      if (plan_number        !== undefined) updates.plan_number        = plan_number;

      const task = await store.updateTask(n, updates);
      if (!task) return res.status(404).json({ error: 'Task not found' }) as any;

      // Replace criteria when provided
      if (Array.isArray(criteria)) {
        // Delete existing, then re-insert
        // (simplest approach: delete all and re-add)
        const existing = await store.getCriteria(n);
        // We can't easily delete by task_number without a dedicated method — add one inline
        (store as any).db.prepare('DELETE FROM criteria WHERE task_number = ?').run(n);
        for (const c of criteria) {
          if (typeof c === 'string' && c.trim()) {
            await store.addAcceptanceCriterion(n, c.trim());
          }
        }
      }

      notifyUpdated();
      res.json(await store.getTaskWithEmbeds(n));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // DELETE /api/tasks/:taskNumber
  app.delete('/api/tasks/:taskNumber', async (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.taskNumber), 10);
      const deleted = await store.deleteTask(n);
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

  // ── REST — Specs ──────────────────────────────────────────────────────────

  // GET /api/specs
  app.get('/api/specs', async (req: Request, res: Response) => {
    try {
      const status = req.query.status as SpecStatus | undefined;
      const specs  = await store.listSpecs(status);
      const result = specs.map(s => ({ ...s, progress: store.getSpecProgress(s.spec_number) }));
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/specs/:specNumber
  app.get('/api/specs/:specNumber', async (req: Request, res: Response) => {
    try {
      const n    = parseInt(String(req.params.specNumber), 10);
      const spec = await store.getSpecByNumber(n);
      if (!spec) return res.status(404).json({ error: 'Spec not found' }) as any;
      const plans    = await store.listPlansBySpec(n);
      const progress = store.getSpecProgress(n);
      res.json({ ...spec, plans, progress });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/specs/:specNumber/hierarchy
  app.get('/api/specs/:specNumber/hierarchy', (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.specNumber), 10);
      const h = store.getSpecWithHierarchy(n);
      if (!h) return res.status(404).json({ error: 'Spec not found' }) as any;
      res.json(h);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/specs
  app.post('/api/specs', async (req: Request, res: Response) => {
    try {
      const { title, description, priority, estimated_hours } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' }) as any;
      const spec = await store.createSpec(title, description, priority ?? 1, estimated_hours);
      notifyDataUpdated();
      res.status(201).json({ ...spec, progress: store.getSpecProgress(spec.spec_number) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // PATCH /api/specs/:specNumber
  app.patch('/api/specs/:specNumber', async (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.specNumber), 10);
      const { title, description, status, priority, estimated_hours } = req.body;
      const updates: any = {};
      if (title           !== undefined) updates.title           = title;
      if (description     !== undefined) updates.description     = description;
      if (status          !== undefined) updates.status          = status;
      if (priority        !== undefined) updates.priority        = priority;
      if (estimated_hours !== undefined) updates.estimated_hours = estimated_hours;
      const spec = await store.updateSpec(n, updates);
      if (!spec) return res.status(404).json({ error: 'Spec not found' }) as any;
      notifyDataUpdated();
      res.json({ ...spec, progress: store.getSpecProgress(n) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // DELETE /api/specs/:specNumber
  app.delete('/api/specs/:specNumber', async (req: Request, res: Response) => {
    try {
      const n       = parseInt(String(req.params.specNumber), 10);
      const deleted = await store.deleteSpec(n);
      if (!deleted) return res.status(404).json({ error: 'Spec not found' }) as any;
      notifyDataUpdated();
      res.status(204).send();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── REST — Plans ──────────────────────────────────────────────────────────

  // GET /api/specs/:specNumber/plans
  app.get('/api/specs/:specNumber/plans', async (req: Request, res: Response) => {
    try {
      const n     = parseInt(String(req.params.specNumber), 10);
      const plans = await store.listPlansBySpec(n);
      res.json(plans);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // POST /api/specs/:specNumber/plans
  app.post('/api/specs/:specNumber/plans', async (req: Request, res: Response) => {
    try {
      const spec_number = parseInt(String(req.params.specNumber), 10);
      const { title, description, sort_order, estimated_hours } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' }) as any;
      if (!(await store.getSpecByNumber(spec_number))) return res.status(404).json({ error: 'Spec not found' }) as any;
      const plan = await store.createPlan(spec_number, title, description, sort_order, estimated_hours);
      notifyDataUpdated();
      res.status(201).json(plan);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/plans/:planNumber
  app.get('/api/plans/:planNumber', async (req: Request, res: Response) => {
    try {
      const n    = parseInt(String(req.params.planNumber), 10);
      const plan = await store.getPlanByNumber(n);
      if (!plan) return res.status(404).json({ error: 'Plan not found' }) as any;
      const tasks = await store.listTasksByPlanWithEmbeds(n);
      res.json({ ...plan, tasks });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // PATCH /api/plans/:planNumber
  app.patch('/api/plans/:planNumber', async (req: Request, res: Response) => {
    try {
      const n = parseInt(String(req.params.planNumber), 10);
      const { title, description, sort_order, estimated_hours } = req.body;
      const updates: any = {};
      if (title           !== undefined) updates.title           = title;
      if (description     !== undefined) updates.description     = description;
      if (sort_order      !== undefined) updates.sort_order      = sort_order;
      if (estimated_hours !== undefined) updates.estimated_hours = estimated_hours;
      const plan = await store.updatePlan(n, updates);
      if (!plan) return res.status(404).json({ error: 'Plan not found' }) as any;
      notifyDataUpdated();
      res.json(plan);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // DELETE /api/plans/:planNumber
  app.delete('/api/plans/:planNumber', async (req: Request, res: Response) => {
    try {
      const n       = parseInt(String(req.params.planNumber), 10);
      const deleted = await store.deletePlan(n);
      if (!deleted) return res.status(404).json({ error: 'Plan not found' }) as any;
      notifyDataUpdated();
      res.status(204).send();
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // GET /api/plans/:planNumber/tasks
  app.get('/api/plans/:planNumber/tasks', (req: Request, res: Response) => {
    try {
      const n     = parseInt(String(req.params.planNumber), 10);
      const tasks = store.listTasksByPlanWithEmbeds(n);
      res.json(tasks);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ── REST — Health & Version ───────────────────────────────────────────────

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.get('/api/version', (_req, res) => res.json(versionInfo));

  // ── Start ─────────────────────────────────────────────────────────────────

  await new Promise<void>(resolve => httpServer.listen(port, '127.0.0.1', resolve));

  const url = `http://localhost:${port}`;
  console.error(`🚀 SDD Dashboard  →  ${url}`);
  openBrowser(url);

  // Check for updates in background — non-blocking
  checkForUpdates();

  serverState = { httpServer, wsServer, port, clients, broadcast };
  return { port, url };
}

export function stopDashboardServer(): void {
  if (!serverState) {
    console.log('[SDD] Dashboard server already stopped');
    return;
  }

  const port = serverState.port;
  console.log(`[SDD] Stopping dashboard server on port ${port}...`);

  // Close all WebSocket connections
  serverState.clients.forEach(c => c.close());

  // Close WebSocket server
  serverState.wsServer.close();

  // Close HTTP server with timeout fallback
  let closed = false;
  const closeCallback = () => {
    if (!closed) {
      closed = true;
      console.log(`[SDD] Dashboard server stopped on port ${port}`);
      serverState = null;
    }
  };

  // Set timeout fallback for force cleanup
  const timeoutMs = 5000;
  const timeoutId = setTimeout(() => {
    if (!closed) {
      console.warn(`[SDD] Server close timed out after ${timeoutMs}ms, forcing reset`);
      resetServerState();
    }
  }, timeoutMs);

  serverState.httpServer.close(closeCallback);
}

/**
 * Forcefully resets the server state.
 * Use this when normal shutdown fails or for immediate cleanup during restarts.
 */
export function resetServerState(): void {
  if (!serverState) {
    console.log('[SDD] Server state already cleared');
    return;
  }

  const port = serverState.port;
  console.warn(`[SDD] Force resetting server state on port ${port}`);

  // Close all WebSocket connections forcefully
  serverState.clients.forEach(c => {
    try { c.terminate(); } catch {}
  });
  serverState.clients.clear();

  // Close servers without waiting for callbacks
  try { serverState.wsServer.close(); } catch {}
  try { serverState.httpServer.close(); } catch {}

  // Immediately clear state
  serverState = null;
  console.log(`[SDD] Server state forcefully reset on port ${port}`);
}

export function isServerRunning(): boolean { return serverState !== null; }

export function getServerPort(): number | null { return serverState?.port ?? null; }

export function broadcastToClients(message: unknown): void {
  serverState?.broadcast(message);
}

