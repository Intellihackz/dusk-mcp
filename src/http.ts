import { TIMEOUT_MS, type Network } from "./config.js";

async function request(url: string, init: RequestInit): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error).message;
    const tls = /CERT|SSL|TLS/i.test(String(detail))
      ? " The endpoint presented a TLS certificate that could not be verified, so the request was refused."
      : "";
    throw new Error(`Request to ${url} failed: ${detail}.${tls}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} from ${url}: ${text.slice(0, 500)}`);
  }
  return text;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Call a RUES-style route (`/on/<component>[:<entity>]/<topic>`).
 * With `json: true` the node uses the contract data driver to encode the
 * input and decode the output, so callers never touch raw bytes.
 */
export async function rues(
  net: Network,
  path: string,
  opts: { body?: string; json?: boolean } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (opts.json) headers["Content-Type"] = "application/json";
  const text = await request(`${net.node}${path}`, { method: "POST", headers, body: opts.body });
  return parse(text);
}

export async function graphql<T = Record<string, any>>(
  net: Network,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const text = await request(`${net.node}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data as T;
}

export async function evmRpc(net: Network, method: string, params: unknown[]): Promise<unknown> {
  const text = await request(net.evmRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = JSON.parse(text) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) throw new Error(`EVM RPC error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

export async function getText(url: string): Promise<string> {
  return request(url, { method: "GET" });
}
