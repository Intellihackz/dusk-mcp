import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveNetwork } from "../config.js";
import { evmRpc } from "../http.js";
import { networkArg, readTool } from "../util.js";

/**
 * Allowlist, not a blocklist: a method that is not named here cannot be
 * reached, so new write methods added upstream never become callable by
 * accident.
 */
const READ_METHODS = [
  "eth_chainId",
  "eth_blockNumber",
  "eth_syncing",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBlockReceipts",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "net_version",
  "web3_clientVersion",
] as const;

const WEI_PER_DUSK = 10n ** 18n;

function weiToDusk(hex: string): string {
  const wei = BigInt(hex);
  const frac = (wei % WEI_PER_DUSK).toString().padStart(18, "0").replace(/0+$/, "");
  return `${wei / WEI_PER_DUSK}${frac ? `.${frac}` : ""}`;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address");

export function registerEvmTools(server: McpServer): void {
  readTool(
    server,
    "dusk_evm_info",
    "Get DuskEVM network details: chain ID, RPC and explorer URLs, latest block number, and current gas price. DuskEVM is the OP Stack based EVM layer that settles to the Dusk L1.",
    { ...networkArg },
    async ({ network }) => {
      const net = resolveNetwork(network);
      const [chainId, blockNumber, gasPrice] = await Promise.all([
        evmRpc(net, "eth_chainId", []),
        evmRpc(net, "eth_blockNumber", []),
        evmRpc(net, "eth_gasPrice", []),
      ]);
      return {
        network: net.name,
        expectedChainId: net.evmChainId,
        chainId: Number(chainId),
        blockNumber: Number(blockNumber),
        gasPriceWei: BigInt(gasPrice as string).toString(),
        gasToken: "DUSK (18 decimals)",
        rpc: net.evmRpc,
        explorer: net.evmExplorer,
      };
    },
  );

  readTool(
    server,
    "dusk_evm_get_account",
    "Get a DuskEVM address's DUSK balance, nonce, and whether it is a contract.",
    { address, ...networkArg },
    async ({ address, network }) => {
      const net = resolveNetwork(network);
      const [balance, nonce, code] = await Promise.all([
        evmRpc(net, "eth_getBalance", [address, "latest"]),
        evmRpc(net, "eth_getTransactionCount", [address, "latest"]),
        evmRpc(net, "eth_getCode", [address, "latest"]),
      ]);
      const bytecode = code as string;
      return {
        address,
        balanceDusk: weiToDusk(balance as string),
        balanceWei: BigInt(balance as string).toString(),
        nonce: Number(nonce),
        isContract: bytecode !== "0x",
        codeSizeBytes: (bytecode.length - 2) / 2,
        explorer: `${net.evmExplorer}/address/${address}`,
      };
    },
  );

  readTool(
    server,
    "dusk_evm_rpc",
    `Call a read-only DuskEVM JSON-RPC method. Allowed methods: ${READ_METHODS.join(", ")}. Methods that sign or broadcast are not available.`,
    {
      method: z.enum(READ_METHODS),
      params: z.array(z.unknown()).default([]).describe("Positional JSON-RPC params."),
      ...networkArg,
    },
    async ({ method, params, network }) => evmRpc(resolveNetwork(network), method, params),
  );
}
