import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { sddTools } from "./tools/sddTools.js";
import { serverTools } from "./tools/server.js";
import { sddDocsTools } from "./tools/sddDocs.js";

type ToolRegistry = typeof serverTools & typeof sddDocsTools & typeof sddTools;

const tools: ToolRegistry = {
  ...serverTools,
  ...sddDocsTools,
  ...sddTools
};

const server = new Server(
  {
    name: "mcp-server-sdd",
    version: "1.0.0"
  },
  {
    capabilities: { tools: {} }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.entries(tools).map(([name, tool]) => ({
      name,
      description: getToolDescription(name),
      inputSchema: {
        type: "object" as const,
        properties: parseZodSchema(tool.schema),
        required: getRequiredFields(tool.schema)
      }
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  if (!tools[name as keyof typeof tools]) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };
  }  try {
    const result = await (tools[name as keyof typeof tools]).handler(args as any);
    return {
      content: [{ type: "text", text: JSON.stringify(result, (_, value) => 
        typeof value === "object" && value instanceof Date ? value.toISOString() : value, 2)
      }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true
    };
  }
});

function getToolDescription(name: string): string {
  const descriptions: Record<string, string> = {
    // Server
    start_server: "⚠️ MANDATORY FIRST TOOL — call this before ANY other SDD tool, no exceptions. Starts the dashboard server and automatically opens it in the browser. Safe to call multiple times — returns the existing URL if already running. Do NOT create tasks, read tasks, or do anything else before calling this.",
    // Docs
    sdd_docs: "Returns the complete SDD methodology guide: workflow, rules, tool usage, valid status transitions and a well-formed create_task example. Call this whenever unsure about the correct process.",
    // SDD Tools
    create_task: "Create a new SDD task. ALL fields are required: title, description (what and why), inputs (context the agent needs), expected_outputs (what will be produced), acceptance_criteria (min 1 — how to verify it is done). Do NOT create without a complete spec.",
    read_task: "Read full details of a task by ID including logs and criteria",
    update_task: "Update task fields (title, description, status) or add log entry",
    list_tasks: "List all tasks, optionally filtered by status",
    delete_task: "Delete a task (only if status is 'open')",
    add_task_log: "Add a log entry to track progress for a task",
    read_task_logs: "Read the full history log of a task",
    submit_task_evidence: "Signal execution complete, moves task to pending-verification",
    verify_task_criterion: "Record pass/fail verdict for an acceptance criterion by criterion_id (get it from read_task or list_criteria)",
    list_criteria: "List all acceptance criteria for a task",
    add_acceptance_criterion: "Add a new acceptance criterion to a task"
  };
  return descriptions[name] || "";
}

function unwrapZod(value: any): any {
  // Unwrap ZodOptional and ZodDefault to reach the inner type
  const name = value?._def?.typeName;
  if (name === "ZodOptional" || name === "ZodDefault") {
    return unwrapZod(value._def.innerType);
  }
  return value;
}

function parseZodSchema(schema: any): Record<string, any> {
  const props: Record<string, any> = {};
  if (schema._def?.shape) {
    Object.entries(schema._def.shape()).forEach(([key, value]: [string, any]) => {
      const inner = unwrapZod(value);
      const typeName = inner?._def?.typeName;

      if (typeName === "ZodString") {
        props[key] = { type: "string" };
      } else if (typeName === "ZodEnum") {
        props[key] = { type: "string", enum: inner._def.values };
      } else if (typeName === "ZodArray") {
        const itemType = unwrapZod(inner._def.type);
        props[key] = {
          type: "array",
          items: itemType?._def?.typeName === "ZodString" ? { type: "string" } : {}
        };
      } else if (typeName === "ZodNumber") {
        props[key] = { type: "number" };
      } else if (typeName === "ZodBoolean") {
        props[key] = { type: "boolean" };
      }
    });
  }
  return props;
}

function getRequiredFields(schema: any): string[] {
  const required: string[] = [];
  if (schema._def?.shape) {
    Object.entries(schema._def.shape()).forEach(([key, value]: [string, any]) => {
      // Campo é obrigatório se não for optional() e não tiver default()
      const isOptional = (value as any)?._def?.innerType !== undefined;
      const hasDefault = (value as any)?._def?.defaultValue !== undefined;
      if (!isOptional && !hasDefault) {
        required.push(key);
      }
    });
  }
  return required;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP SDD Server running on stdio");
}

main().catch(console.error);
