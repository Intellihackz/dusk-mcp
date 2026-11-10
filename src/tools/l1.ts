import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveNetwork, STAKE_CONTRACT, TRANSFER_CONTRACT } from "../config.js";
import { graphql, rues } from "../http.js";
import { luxToDusk, networkArg, readTool } from "../util.js";

const contractId = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "contract ID must be 64 hex characters")
  .describe(
    `DuskVM contract ID, 64 hex chars. Genesis contracts: transfer = ${TRANSFER_CONTRACT}, stake = ${STAKE_CONTRACT}.`,
  );

const txHash = z.string().regex(/^[0-9a-fA-F]{64}$/, "hash must be 64 hex characters");

const account = z
  .string()
  .min(40)
  .describe("Moonlight (public) account: a base58-encoded BLS public key.");

/** GraphQL wraps some results as a `json` scalar that may arrive as a string. */
function unwrapJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const TX_SUMMARY = `id txType gasLimit gasPrice isDeploy memo callData { contractId fnName }`;

export function registerL1Tools(server: McpServer): void {
  readTool(
    server,
    "dusk_node_info",
    "Get Dusk L1 node info: Rusk version, chain ID, VM config, and active hard-fork feature heights.",
    { ...networkArg },
    async ({ network }) => rues(resolveNetwork(network), "/on/node/info"),
  );

  readTool(
    server,
    "dusk_network_stats",
    "Get L1 totals: finalized transaction count (public vs shielded), active public accounts, and current gas price statistics in LUX.",
    { ...networkArg },
    async ({ network }) => {
      const net = resolveNetwork(network);
      const [transactions, accounts, gasPrice, tip] = await Promise.all([
        rues(net, "/on/stats/tx_count").catch((e) => ({ error: (e as Error).message })),
        rues(net, "/on/stats/account_count").catch((e) => ({ error: (e as Error).message })),
        rues(net, "/on/blocks/gas-price"),
        graphql(net, `{ block(height: -1) { header { height hash timestamp } } }`),
      ]);
      return { network: net.name, tip: tip.block?.header, transactions, accounts, gasPriceLux: gasPrice };
    },
  );

  readTool(
    server,
    "dusk_provisioners",
    "List Dusk provisioners (stakers/validators) ranked by stake, with network-wide stake totals. Amounts are returned in DUSK.",
    {
      limit: z.number().int().min(1).max(200).default(20).describe("How many of the largest provisioners to return."),
      key: z.string().optional().describe("Return only the provisioner with this BLS public key (base58)."),
      ...networkArg,
    },
    async ({ limit, key, network }) => {
      const all = (await rues(resolveNetwork(network), "/on/node/provisioners")) as any[];
      const total = all.reduce((sum, p) => sum + BigInt(p.amount), 0n);
      const locked = all.reduce((sum, p) => sum + BigInt(p.locked_amt), 0n);
      const fmt = (p: any) => ({
        key: p.key,
        owner: p.owner,
        stakeDusk: luxToDusk(p.amount),
        lockedDusk: luxToDusk(p.locked_amt),
        rewardDusk: luxToDusk(p.reward),
        eligibleFromBlock: p.eligibility,
        faults: p.faults,
        hardFaults: p.hard_faults,
      });
      const rows = key
        ? all.filter((p) => p.key === key)
        : [...all].sort((a, b) => b.amount - a.amount).slice(0, limit);
      return {
        count: all.length,
        activeCount: all.filter((p) => p.amount > 0).length,
        totalStakeDusk: luxToDusk(total),
        totalLockedDusk: luxToDusk(locked),
        provisioners: rows.map(fmt),
      };
    },
  );

  readTool(
    server,
    "dusk_get_block",
    "Get an L1 block by height or hash, including header, status, fees, reward, and a summary of its transactions. Omit both arguments for the latest block.",
    {
      height: z.number().int().min(0).optional().describe("Block height. Omit for the latest block."),
      hash: z.string().optional().describe("Block hash (hex). Takes precedence over height."),
      ...networkArg,
    },
    async ({ height, hash, network }) => {
      const vars = hash ? { hash } : { height: height ?? -1 };
      const data = await graphql(
        resolveNetwork(network),
        `query ($height: Float, $hash: String) {
          block(height: $height, hash: $hash) {
            header { height hash prevBlockHash timestamp stateHash txRoot generatorBlsPubkey gasLimit iteration version }
            status reward fees gasSpent
            transactions { id gasSpent err tx { ${TX_SUMMARY} } }
          }
        }`,
        vars,
      );
      if (!data.block) throw new Error("Block not found.");
      return data.block;
    },
  );

  readTool(
    server,
    "dusk_latest_blocks",
    "List the most recent L1 blocks with height, hash, timestamp, generator, gas spent, and transaction count.",
    {
      count: z.number().int().min(1).max(50).default(10).describe("Number of recent blocks."),
      ...networkArg,
    },
    async ({ count, network }) => {
      const data = await graphql(
        resolveNetwork(network),
        `query ($n: Int) {
          blocks(last: $n) {
            header { height hash timestamp generatorBlsPubkey }
            status gasSpent fees reward
            transactions { id }
          }
        }`,
        { n: count },
      );
      return (data.blocks as any[]).map((b) => ({
        ...b.header,
        status: b.status,
        gasSpent: b.gasSpent,
        feesLux: b.fees,
        rewardLux: b.reward,
        txCount: b.transactions.length,
        txIds: b.transactions.map((t: any) => t.id),
      }));
    },
  );

  readTool(
    server,
    "dusk_get_transaction",
    "Look up an L1 transaction by hash. Returns execution result (block, gas spent, error) if it was included, or its pending state if it is still in this node's mempool.",
    { hash: txHash.describe("Transaction hash, 64 hex chars."), ...networkArg },
    async ({ hash, network }) => {
      const net = resolveNetwork(network);
      const data = await graphql(
        net,
        `query ($hash: String!) {
          tx(hash: $hash) {
            id blockHash blockHeight blockTimestamp gasSpent err
            tx { ${TX_SUMMARY} contractId blobHashes json }
          }
        }`,
        { hash },
      );
      if (data.tx) {
        const { json, ...summary } = data.tx.tx;
        return { state: "included", ...data.tx, tx: summary, details: unwrapJson(json) };
      }
      const pending = await graphql(
        net,
        `query ($hash: String!) { mempoolTx(hash: $hash) { ${TX_SUMMARY} contractId json } }`,
        { hash },
      );
      if (pending.mempoolTx) {
        const { json, ...summary } = pending.mempoolTx;
        return { state: "pending", tx: summary, details: unwrapJson(json) };
      }
      throw new Error(
        "Transaction not found in the chain or in this node's mempool. The mempool view is local to one node, not network-wide.",
      );
    },
  );

  readTool(
    server,
    "dusk_mempool",
    "List pending transactions in this node's local mempool, highest gas price first. This is one node's view, not the whole network.",
    { ...networkArg },
    async ({ network }) => {
      const data = await graphql(resolveNetwork(network), `{ mempoolTxs { ${TX_SUMMARY} } }`);
      return { count: data.mempoolTxs.length, transactions: data.mempoolTxs };
    },
  );

  readTool(
    server,
    "dusk_get_account",
    "Get the committed public (Moonlight) balance and nonce of a Dusk account. Shielded (Phoenix) balances are private and cannot be queried.",
    { account, ...networkArg },
    async ({ account, network }) => {
      const state = (await rues(resolveNetwork(network), `/on/contracts:${TRANSFER_CONTRACT}/account`, {
        body: JSON.stringify(account),
        json: true,
      })) as { nonce: string; balance: string };
      return {
        account,
        balanceDusk: luxToDusk(state.balance),
        balanceLux: state.balance,
        nonce: state.nonce,
        note: "Committed state only. Pending mempool transactions are not reflected in the nonce.",
      };
    },
  );

  readTool(
    server,
    "dusk_account_history",
    "Get the public (Moonlight) transfer history of an account from archive data: inflows and outflows per block. Requires an archive-enabled node.",
    {
      account,
      fromBlock: z.number().int().min(0).optional(),
      toBlock: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).default("desc").describe("Block order."),
      ...networkArg,
    },
    async ({ account, fromBlock, toBlock, order, network }) => {
      const data = await graphql(
        resolveNetwork(network),
        `query ($address: String!, $ord: String, $fromBlock: Int, $toBlock: Int) {
          fullMoonlightHistory(address: $address, ord: $ord, fromBlock: $fromBlock, toBlock: $toBlock) { json }
        }`,
        { address: account, ord: order, fromBlock, toBlock },
      );
      return unwrapJson(data.fullMoonlightHistory?.json) ?? [];
    },
  );

  readTool(
    server,
    "dusk_contract_metadata",
    "Get metadata for a DuskVM contract: owner, whether a data driver is available, and its balance in DUSK.",
    { contract_id: contractId, ...networkArg },
    async ({ contract_id, network }) => {
      const net = resolveNetwork(network);
      const [metadata, balance] = await Promise.all([
        rues(net, `/on/contract:${contract_id}/metadata`),
        rues(net, `/on/contracts:${TRANSFER_CONTRACT}/contract_balance`, {
          body: JSON.stringify(contract_id),
          json: true,
        }).catch(() => null),
      ]);
      return {
        contract_id,
        ...(metadata as object),
        balanceDusk: balance == null ? null : luxToDusk(String(balance)),
      };
    },
  );

  readTool(
    server,
    "dusk_contract_schema",
    "Get the ABI of a DuskVM contract from its data driver: function names with input/output types, and events. Call this before dusk_call_contract to learn the methods.",
    { contract_id: contractId, ...networkArg },
    async ({ contract_id, network }) =>
      rues(resolveNetwork(network), `/on/driver:${contract_id}/get_schema`),
  );

  readTool(
    server,
    "dusk_call_contract",
    "Run a read-only query against a DuskVM contract method. The node encodes the JSON input and decodes the output through the contract's data driver. This never submits a transaction or changes state.",
    {
      contract_id: contractId,
      method: z.string().regex(/^[A-Za-z0-9_]+$/).describe("Method name from dusk_contract_schema."),
      input: z
        .unknown()
        .optional()
        .describe("JSON input matching the method's input type. Omit for methods that take ()."),
      ...networkArg,
    },
    async ({ contract_id, method, input, network }) =>
      rues(resolveNetwork(network), `/on/contracts:${contract_id}/${method}`, {
        body: JSON.stringify(input ?? null),
        json: true,
      }),
  );

  readTool(
    server,
    "dusk_contract_events",
    "Get finalized events emitted by a DuskVM contract, paginated. Requires an archive-enabled node.",
    {
      contract_id: contractId,
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe("Pagination cursor from a previous call."),
      ...networkArg,
    },
    async ({ contract_id, limit, cursor, network }) => {
      const data = await graphql(
        resolveNetwork(network),
        `query ($contractId: String!, $limit: Int, $cursor: String) {
          finalizedEvents(contractId: $contractId, limit: $limit, cursor: $cursor) { json }
        }`,
        { contractId: contract_id, limit, cursor },
      );
      return unwrapJson(data.finalizedEvents?.json) ?? [];
    },
  );

  readTool(
    server,
    "dusk_check_transaction",
    "Dry-run an already-signed, serialized L1 transaction without broadcasting it. 'preverify' checks it would be accepted; 'simulate' executes it and reports gas and result. Nothing is submitted to the network.",
    {
      tx_hex: z.string().regex(/^(0x)?[0-9a-fA-F]+$/).describe("Serialized transaction as hex."),
      mode: z.enum(["preverify", "simulate"]).default("simulate"),
      ...networkArg,
    },
    async ({ tx_hex, mode, network }) => {
      const body = tx_hex.startsWith("0x") ? tx_hex : `0x${tx_hex}`;
      const result = await rues(resolveNetwork(network), `/on/transactions/${mode}`, { body });
      return { mode, result: result === "" ? "ok" : result };
    },
  );

  readTool(
    server,
    "dusk_graphql",
    "Run an arbitrary GraphQL query against the Dusk node for anything the other tools do not cover. Root fields: block, blocks, tx, transactions, blockTxs, mempoolTxs, mempoolTx, lastBlockPair, moonlightHistory, fullMoonlightHistory, transactionsByMemo, contractEvents, finalizedEvents, checkBlock, nextPhoenix. Introspection is enabled.",
    {
      query: z.string().describe("GraphQL query document."),
      variables: z.record(z.string(), z.unknown()).optional(),
      ...networkArg,
    },
    async ({ query, variables, network }) => {
      if (/^\s*(mutation|subscription)\b/i.test(query)) {
        throw new Error("Only GraphQL queries are supported.");
      }
      return graphql(resolveNetwork(network), query, variables);
    },
  );
}
