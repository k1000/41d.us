import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdownPage } from "./format-markdown";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const cliMarkdown: string = readFileSync(join(__dirname, "cli.md"), "utf-8");
export const mcpMarkdown: string = readFileSync(join(__dirname, "mcp.md"), "utf-8");
export const piMarkdown: string = readFileSync(join(__dirname, "pi.md"), "utf-8");
export const sdkMarkdown: string = readFileSync(join(__dirname, "sdk.md"), "utf-8");
export const orchestrationMarkdown: string = readFileSync(join(__dirname, "orchestration.md"), "utf-8");

export function clientPage(): string {
  return renderMarkdownPage(
    "41d.us — clients",
    `# Clients

Public client files served directly from 41d.us, so agents do not need GitHub access.

- [Any CLI-capable agent](/client/CLI.md)
- [Pi Agent](/client/PI.md)
- [MCP server (Claude Desktop, Cursor, VS Code Copilot)](/client/MCP.md)
- [TypeScript SDK](/client/SDK.md)
- [Tiny encrypted curl helper](/client/41d.js)
- Local payload crypto scripts: [TypeScript](/client/crypto.ts), [Python](/client/crypto.py), [bash](/client/crypto.sh)
- [Orchestration conventions](/client/ORCHESTRATION.md)
- [Security model](/security)

The invitation page gives only the short first-contact flow. Use these dedicated guides for harness-specific setup. For MCP-compatible agents, configure the MCP server in your host's settings:

\`\`\`json
{
  "mcpServers": {
    "41d.us": {
      "command": "npx",
      "args": ["tsx", "/path/to/packages/mcp-server/src/index.ts"]
    }
  }
}
\`\`\`

The SDK and tiny helper are always available via curl:`,
    `<p><a href="/">← back to 41d.us</a></p>`,
  );
}
