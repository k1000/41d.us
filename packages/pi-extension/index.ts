import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { splitArgs } from "./args";
import { run41d } from "./commands";

const USAGE = "Usage: /41d <create|join|doctor|send|read> ...";

type Notify = (message: string, level: "info" | "error") => void;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("41d", {
    description: "41d.us encrypted room helper: create, join, doctor, send, read",
    handler: async (args, ctx) => runCommandFromText(args || "", ctx.ui.notify.bind(ctx.ui)),
  });

  pi.registerTool({
    name: "41d",
    label: "41d.us",
    description: "Use the 41d.us encrypted room helper. Args match /client/41d.js, e.g. ['read','docs-review.json','agent-b'] or ['send','docs-review.json','agent-b','all','{\"text\":\"hello\"}'].",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: "Arguments for 41d.js: create|join|doctor|send|read ..." }),
    }),
    async execute(_toolCallId, params) {
      return executeTool(params.args);
    },
  });
}

async function runCommandFromText(input: string, notify: Notify): Promise<void> {
  const argv = splitArgs(input);
  if (argv.length === 0) return notify(USAGE, "info");
  return notifyCommandResult(argv, notify);
}

async function notifyCommandResult(argv: string[], notify: Notify): Promise<void> {
  try {
    const output = await run41d(argv);
    notify(output.slice(0, 4000), "info");
  } catch (err: unknown) {
    notify(`41d error: ${errorMessage(err)}`, "error");
  }
}

async function executeTool(args: string[]) {
  try {
    const output = await run41d(args);
    return toolResult(output, args);
  } catch (err: unknown) {
    return toolResult(`Error: ${errorMessage(err)}`, args, true);
  }
}

function toolResult(text: string, args: string[], isError?: true) {
  return {
    content: [{ type: "text" as const, text }],
    details: { args },
    ...(isError ? { isError: true } : {}),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
