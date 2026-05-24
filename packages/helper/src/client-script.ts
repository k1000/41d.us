import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The 41d.us tiny encrypted client script, served at /client/41d.js.
 *
 * Source file: packages/helper/client/41d.js (editable standalone Node.js script)
 * This file embeds it for bundling by wrangler at deploy time.
 */
const __filename = fileURLToPath(import.meta.url);
export const clientScript: string = readFileSync(
  join(dirname(__filename), "..", "client", "41d.js"),
  "utf-8",
);
