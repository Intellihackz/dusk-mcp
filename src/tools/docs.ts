import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DOCS_ORIGIN } from "../config.js";
import { getText } from "../http.js";
import { readTool } from "../util.js";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** Reduce a docs page to readable text. Good enough for an LLM, not a full HTML parser. */
function htmlToText(html: string): string {
  const main = html.match(/<main[\s\S]*<\/main>/i)?.[0] ?? html;
  return main
    .replace(/<(script|style|svg|nav|button)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*sl-anchor-link[\s\S]*?<\/a>/gi, "")
    .replace(/<pre[^>]*>/gi, "\n```\n")
    .replace(/<\/pre>/gi, "\n```\n")
    .replace(/<h([1-6])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|ul|ol|table|section|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function registerDocsTools(server: McpServer): void {
  readTool(
    server,
    "dusk_docs_index",
    "Get the index of the official Dusk documentation: every page with its URL and a one-line summary. Use it to find the right page, then read it with dusk_read_doc.",
    {},
    async () => getText(`${DOCS_ORIGIN}/llms.txt`),
  );

  readTool(
    server,
    "dusk_read_doc",
    "Read one page of the official Dusk documentation as plain text. Accepts a docs.dusk.network URL or a path such as /developer/integrations/http-api/.",
    {
      page: z.string().describe("Docs URL or path, taken from dusk_docs_index."),
      max_chars: z.number().int().min(1000).max(60000).default(20000),
    },
    async ({ page, max_chars }) => {
      const url = new URL(page, DOCS_ORIGIN);
      if (url.origin !== DOCS_ORIGIN) {
        throw new Error(`Only pages on ${DOCS_ORIGIN} can be read.`);
      }
      const text = htmlToText(await getText(url.href));
      const body = text.length > max_chars ? `${text.slice(0, max_chars)}\n\n[truncated]` : text;
      return `Source: ${url.href}\n\n${body}`;
    },
  );
}
