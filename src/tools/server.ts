/**
 * Server Tools for SDD Dashboard
 */

import { z } from 'zod';
import {
  startDashboardServer,
  isServerRunning,
  getServerPort
} from '../server/index.js';

/**
 * start_server — launches the real-time dashboard server
 */
export const start_server = {
  schema: z.object({
    port: z.number().int().min(1).max(65535).optional()
      .describe('Port number to use (default: auto-discover from 3000)')
  }),

  handler: async (args?: { port?: number }): Promise<any> => {
    try {
      if (isServerRunning()) {
        const port = getServerPort();
        return {
          success: true,
          message: 'Dashboard already running',
          data: {
            port,
            url: `http://localhost:${port}`
          }
        };
      }

      const result = await startDashboardServer(args?.port);
      return {
        success: true,
        message: 'Dashboard server started. Open the URL in your browser to follow along in real-time.',
        data: {
          port: result.port,
          url: result.url
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
};

export const serverTools = { start_server };
