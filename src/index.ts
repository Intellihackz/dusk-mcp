#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultNetwork, resolveNetwork } from "./config.js";
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
      `Default network: ${defaultNetwork}. Every tool accepts network: "mainnet" | "testnet" | "devnet".`,
    ].join("\n"),
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
