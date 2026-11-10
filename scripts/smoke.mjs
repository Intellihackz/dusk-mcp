// Live smoke test: spawns the built server over stdio and calls every tool
// against the real network. Run with `npm run build && npm run smoke`.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TRANSFER = "0100000000000000000000000000000000000000000000000000000000000000";
const preview = Number(process.env.PREVIEW ?? 260);

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env, stderr: "inherit" }),
);

const { tools } = await client.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}\n`);

let failed = 0;
async function call(name, args = {}, { expectError = false } = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  const ok = Boolean(res.isError) === expectError;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)}`);
  console.log(`     ${text.slice(0, preview).replace(/\s+/g, " ")}\n`);
  return text;
}
const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

await call("dusk_node_info");
await call("dusk_network_stats");
const prov = json(await call("dusk_provisioners", { limit: 2 }));
const account = prov?.provisioners?.[0]?.key;

await call("dusk_get_block");
const blocks = json(await call("dusk_latest_blocks", { count: 50 }));
const recent = json(await call("dusk_graphql", { query: "{ transactions(last: 1) { id } }" }));
const txId = blocks?.flatMap((b) => b.txIds)[0] ?? recent?.transactions?.[0]?.id;
if (txId) await call("dusk_get_transaction", { hash: txId });
else console.log("SKIP dusk_get_transaction (no recent tx found)\n");
await call("dusk_get_transaction", { hash: "00".repeat(32) }, { expectError: true });
await call("dusk_mempool");

if (account) {
  await call("dusk_get_account", { account });
  await call("dusk_account_history", { account });
}
await call("dusk_contract_metadata", { contract_id: TRANSFER });
await call("dusk_contract_schema", { contract_id: TRANSFER });
await call("dusk_call_contract", { contract_id: TRANSFER, method: "num_notes" });
await call("dusk_call_contract", { contract_id: TRANSFER, method: "chain_id" });
await call("dusk_contract_events", { contract_id: TRANSFER, limit: 2 });
await call("dusk_graphql", { query: "{ block(height: -1) { header { height } } }" });
await call("dusk_graphql", { query: "mutation { x }" }, { expectError: true });
await call("dusk_check_transaction", { tx_hex: "0x00", mode: "preverify" }, { expectError: true });

await call("dusk_node_info", { network: "testnet" });
await call("dusk_evm_info", { network: "testnet" });
await call("dusk_evm_get_account", { address: "0x4200000000000000000000000000000000000006", network: "testnet" });
await call("dusk_evm_rpc", { method: "eth_getBlockByNumber", params: ["latest", false], network: "testnet" });
await call("dusk_node_info", { network: "devnet" });
// Informational: these public DuskEVM endpoints have been unreachable
// (mainnet serves an unverifiable TLS certificate, devnet returns 503).
for (const network of ["mainnet", "devnet"]) {
  const failedBefore = failed;
  await call("dusk_evm_info", { network });
  if (failed > failedBefore) {
    failed = failedBefore;
    console.log(`WARN ${network} DuskEVM RPC is not reachable; not counted as a failure\n`);
  }
}

// Session network: an unnamed call follows the switch, a named call overrides it.
const chainOf = async (args) => json(await call("dusk_node_info", args))?.chain_id;
await call("dusk_use_network", { network: "testnet" });
const followed = (await chainOf({})) === 2;
const overridden = (await chainOf({ network: "devnet" })) === 3;
await call("dusk_use_network", { network: "mainnet" });
const restored = (await chainOf({})) === 1;
if (!(followed && overridden && restored)) failed++;
console.log(`${followed && overridden && restored ? "PASS" : "FAIL"} session network switch (follow=${followed} override=${overridden} restore=${restored})\n`);

await call("dusk_docs_index");
await call("dusk_read_doc", { page: "/developer/duskevm/reference/", max_chars: 1500 });
await call("dusk_read_doc", { page: "https://example.com/" }, { expectError: true });

await client.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
