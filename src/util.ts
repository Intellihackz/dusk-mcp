import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultNetwork, NETWORK_NAMES } from "./config.js";

const LUX_PER_DUSK = 1_000_000_000n;
const MAX_CHARS = 60_000;

/** Format a LUX amount (1 DUSK = 1e9 LUX) as a decimal DUSK string. */
export function luxToDusk(lux: bigint | number | string): string {
  const value = BigInt(lux);
  const abs = value < 0n ? -value : value;
  const frac = (abs % LUX_PER_DUSK).toString().padStart(9, "0").replace(/0+$/, "");
  return `${value < 0n ? "-" : ""}${abs / LUX_PER_DUSK}${frac ? `.${frac}` : ""}`;
}

/** Parse a decimal DUSK amount such as "1.5" into LUX. Strict: no signs, exponents or separators. */
export function duskToLux(amount: string): bigint {
  const match = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid DUSK amount "${amount}". Use a plain decimal with up to 9 decimals, e.g. "1.5".`);
  return BigInt(match[1]) * LUX_PER_DUSK + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
}

/** Shared optional argument: every tool can target either network. */
export const networkArg = {
  network: z
    .enum(NETWORK_NAMES)
    .optional()
    .describe(`Dusk network to query. Defaults to "${defaultNetwork}".`),
};

function render(data: unknown): string {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${text.length - MAX_CHARS} more characters. Narrow the request.]`;
}

export interface ToolHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

/** Register a read-only tool. */
export function readTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  tool(server, name, description, shape, { readOnlyHint: true }, handler);
}

/**
 * Register a tool. The handler returns plain data; this wrapper serializes
 * it, caps its size, and turns thrown errors into MCP tool errors so the
 * model sees the failure reason instead of the server crashing.
 */
export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  hints: ToolHints,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: shape,
      annotations: { ...hints, openWorldHint: true },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return { content: [{ type: "text" as const, text: render(await handler(args)) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (err as Error).message }],
        };
      }
    }) as any,
  );
}
