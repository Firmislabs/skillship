import { z } from "zod";

export const createIssueTool = {
  name: "create_issue",
  description: "Create a new issue in the repo",
  inputSchema: z.object({
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const listIssuesTool = {
  name: "list_issues",
  description: "List issues",
  inputSchema: z.object({ state: z.enum(["open", "closed"]).optional() }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const malformedTool = {
  name: "missing_schema",
  description: "Should be skipped because no inputSchema",
  annotations: { readOnlyHint: true },
};

const internalHelper = {
  name: "internal",
  description: "Not exported, must be skipped",
  inputSchema: z.object({}),
  annotations: {},
};

void internalHelper;
