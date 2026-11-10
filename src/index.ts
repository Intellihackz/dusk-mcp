#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { defaultNetwork, getSessionNetwork, NETWORK_NAMES, resolveNetwork, setSessionNetwork } from "./config.js";
import { tool } from "./util.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerEvmTools } from "./tools/evm.js";
import { registerL1Tools } from "./tools/l1.js";

const server = new McpServer(
  { name: "dusk-mcp", version: "0.1.0" },
  {
    instructions: [
      process.env.DUSK_ENABLE_WALLET === "1"
        ? "Chain data tools are read-only. Wallet tools (dusk_wallet_*, dusk_prepare_transfer, dusk_send_transfer) hold keys locally and can move DUSK. Never send a transfer the user did not explicitly ask for, and show them the prepared summary before calling dusk_send_transfer. Each wallet has its own password that only the user knows. Do not pass password arguments unless a tool says it cannot prompt the user; then ask the user and pass exactly what they give. Never guess, generate, store or repeat a wallet password."
        : "Read-only access to the Dusk Network. Nothing here can sign or broadcast a transaction.",
      "Dusk has two layers. The L1 (DuskDS, node software Rusk) runs DuskVM Rust/WASM contracts and uses base58 BLS public keys as accounts, with amounts in LUX (1 DUSK = 1e9 LUX). DuskEVM is an OP Stack EVM layer with 0x addresses and 18-decimal DUSK.",
      "Use dusk_* tools for the L1 and dusk_evm_* tools for DuskEVM. For a DuskVM contract, call dusk_contract_schema before dusk_call_contract.",
      "Only public (Moonlight) balances and transfers are visible. Shielded (Phoenix) activity is private by design.",
      `Networks: mainnet, testnet, devnet. When the user names a network in a request ("on testnet", "on devnet"), pass it as that tool call's network argument. When they want to switch for everything that follows ("use testnet from now on", "switch to devnet"), call dusk_use_network. When they name none, omit the argument and the session network applies; it starts as ${defaultNetwork}. Always tell the user which network a transfer is on.`,
    ].join("\n"),
  },
);

tool(
  server,
  "dusk_use_network",
  "Show or switch the session network: the Dusk network used by every tool call that does not name one. Call with a network when the user wants to work on it from now on (\"switch to testnet\", \"use devnet\"). Call with no arguments to see the current one. A network named in a single request still overrides this.",
  { network: z.enum(NETWORK_NAMES).optional().describe("Network to switch to. Omit to only show the current one.") },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  async ({ network }) => {
    const previous = getSessionNetwork();
    if (network) setSessionNetwork(network);
    const net = resolveNetwork();
    return {
      sessionNetwork: net.name,
      changedFrom: network && network !== previous ? previous : undefined,
      node: net.node,
      evmRpc: net.evmRpc,
      note: "Applies to tool calls that do not name a network, until the server restarts.",
    };
  },
);

registerL1Tools(server);
registerEvmTools(server);
registerDocsTools(server);

// Wallet tools can move funds, so they only exist when explicitly enabled.
const walletEnabled = process.env.DUSK_ENABLE_WALLET === "1";
if (walletEnabled) {
  const { registerWalletTools } = await import("./tools/wallet.js");
  registerWalletTools(server);
}

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so diagnostics must go to stderr.
console.error(
  `dusk-mcp ready (${defaultNetwork}, node ${resolveNetwork().node}, wallet ${walletEnabled ? "on" : "off"})`,
);
