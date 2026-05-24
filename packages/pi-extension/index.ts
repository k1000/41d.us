import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_HELPER_URL = "https://41d.us/client/41d.js";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("41d", {
    description: "Run the 41d.us encrypted room helper: create, join, doctor, send, read",
    handler: async (args, ctx) => {
      const argv = splitArgs(args || "");
      if (argv.length === 0) {
        ctx.ui.notify("Usage: /41d <create|join|doctor|send|read> ...", "info");
        return;
      }
      const output = await run41d(argv);
      ctx.ui.notify(output.slice(0, 4000), "info");
    },
  });

  pi.registerTool({
    name: "41d",
    label: "41d.us",
    description: "Use the 41d.us encrypted room helper. Args match /client/41d.js, e.g. ['read','docs-review.json','agent-b'] or ['send','docs-review.json','agent-b','all','{\"text\":\"hello\"}'].",
    parameters: Type.Object({
      args: Type.Array(Type.String(), { description: "Arguments for 41d.js: create|join|doctor|send|read ..." }),
    }),
    async execute(_toolCallId, params) {
      const output = await run41d(params.args);
      return {
        content: [{ type: "text", text: output }],
        details: { args: params.args },
      };
    },
  });
}

async function run41d(args: string[]): Promise<string> {
  const helperUrl = process.env.FORTY_ONE_D_HELPER_URL || DEFAULT_HELPER_URL;
  const response = await fetch(helperUrl);
  if (!response.ok) throw new Error(`failed to fetch ${helperUrl}: ${response.status}`);
  const script = await response.text();
  return runNodeScript(script, args);
}

function runNodeScript(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-", ...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (code === 0) resolve(output || "ok");
      else reject(new Error(output || `41d helper exited with code ${code}`));
    });
    child.stdin.end(script);
  });
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    args.push(unescapeArg(match[1] ?? match[2] ?? match[3] ?? ""));
  }
  return args;
}

function unescapeArg(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1");
}
