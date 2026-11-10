import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveNetwork, TRANSFER_CONTRACT, type Network, type NetworkName } from "../config.js";
import { graphql, rues } from "../http.js";
import { duskToLux, luxToDusk, networkArg, tool } from "../util.js";
import { accountKind, signTransfer } from "../wallet/signer.js";
import { createWallet, findWallet, importWallet, listWallets, unlock, WALLET_DIR } from "../wallet/store.js";

/** A plain transfer spends about 1.85M gas on mainnet. Official wallets use this limit. */
const TRANSFER_GAS_LIMIT = 10_000_000n;
const PREPARED_TTL_MS = 5 * 60_000;

const mainnetAllowed = process.env.DUSK_ALLOW_MAINNET_SEND === "1";
const maxSendLux = duskToLux(process.env.DUSK_MAX_SEND_DUSK ?? "100");

interface Prepared {
  network: NetworkName;
  hex: string;
  hash: string;
  account: string;
  nonce: bigint;
  expiresAt: number;
  summary: Record<string, unknown>;
}

/** Signed transfers waiting for an explicit send. Held in memory only. */
const prepared = new Map<string, Prepared>();
/** Last nonce this process broadcast per network and account, with its tx hash. */
const lastSent = new Map<string, { nonce: bigint; hash: string }>();

async function accountState(net: Network, account: string): Promise<{ balance: bigint; nonce: bigint }> {
  const state = (await rues(net, `/on/contracts:${TRANSFER_CONTRACT}/account`, {
    body: JSON.stringify(account),
    json: true,
  })) as { balance: string; nonce: string };
  return { balance: BigInt(state.balance), nonce: BigInt(state.nonce) };
}

/**
 * The node only reports the committed nonce. If this process already sent a
 * transaction that is still pending, build on top of it so two quick
 * transfers do not collide on the same nonce.
 */
async function nonceBase(net: Network, account: string, committed: bigint): Promise<bigint> {
  const key = `${net.name}:${account}`;
  const last = lastSent.get(key);
  if (!last || last.nonce <= committed) return committed;
  const pending = await graphql(net, `query ($hash: String!) { mempoolTx(hash: $hash) { id } }`, {
    hash: last.hash,
  });
  if (pending.mempoolTx) return last.nonce;
  lastSent.delete(key);
  return committed;
}

function assertSendAllowed(net: Network): void {
  if (net.name === "mainnet" && !mainnetAllowed) {
    throw new Error(
      "Mainnet transfers are disabled. This server only sends on testnet unless DUSK_ALLOW_MAINNET_SEND=1 is set in its environment.",
    );
  }
}

export function registerWalletTools(server: McpServer): void {
  tool(
    server,
    "dusk_wallet_list",
    "List the local Dusk wallets held by this server with their public account and DUSK balance. Never returns keys or recovery phrases.",
    { ...networkArg },
    { readOnlyHint: true },
    async ({ network }) => {
      const net = resolveNetwork(network);
      const wallets = await listWallets();
      const rows = await Promise.all(
        wallets.map(async (w) => {
          const state = await accountState(net, w.account).catch(() => null);
          return {
            name: w.name,
            account: w.account,
            balanceDusk: state ? luxToDusk(state.balance) : "unavailable",
            nonce: state ? state.nonce.toString() : null,
            createdAt: w.createdAt,
          };
        }),
      );
      return {
        network: net.name,
        walletDir: WALLET_DIR,
        sending: {
          testnet: "enabled",
          mainnet: mainnetAllowed ? "enabled" : "disabled",
          maxPerTransferDusk: luxToDusk(maxSendLux),
        },
        wallets: rows,
      };
    },
  );

  tool(
    server,
    "dusk_wallet_create",
    "Create a new local Dusk wallet (public Moonlight account). The recovery phrase is written to a private file on disk and is never returned. Tell the user where the backup file is and that they should move it somewhere safe.",
    { name: z.string().describe("Short wallet name: lowercase letters, digits, - or _.") },
    { readOnlyHint: false, destructiveHint: false },
    async ({ name }) => {
      const wallet = await createWallet(name);
      return {
        name: wallet.name,
        account: wallet.account,
        recoveryPhraseFile: wallet.backupFile,
        note: "The recovery phrase file is the only backup. Anyone who reads it controls the wallet. The same account works on mainnet and testnet.",
      };
    },
  );

  tool(
    server,
    "dusk_wallet_import",
    "Import an existing Dusk wallet from a file that contains its BIP39 recovery phrase. Pass the file path, never the phrase itself: phrases must not appear in the conversation.",
    {
      name: z.string().describe("Short wallet name: lowercase letters, digits, - or _."),
      recovery_phrase_file: z.string().describe("Absolute path to a text file holding the recovery phrase."),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ name, recovery_phrase_file }) => {
      const wallet = await importWallet(name, recovery_phrase_file);
      return {
        ...wallet,
        note: "Imported. Consider deleting the source file now that the phrase is stored encrypted.",
      };
    },
  );

  tool(
    server,
    "dusk_prepare_transfer",
    "Prepare a public DUSK transfer on the Dusk L1 from a local wallet. This signs the transaction, checks balance and limits, and asks the node to preverify it, but does NOT broadcast. It returns a summary and a transfer_id. Show the summary to the user, then call dusk_send_transfer to broadcast.",
    {
      from: z.string().describe("Name of the local wallet to send from."),
      to: z.string().describe("Recipient: a Dusk account (base58 BLS public key) or the name of another local wallet."),
      amount_dusk: z.string().describe('Amount in DUSK as a decimal string, e.g. "1.5".'),
      memo: z.string().max(512).optional().describe("Optional public memo stored on-chain."),
      ...networkArg,
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ from, to, amount_dusk, memo, network }) => {
      const net = resolveNetwork(network);
      assertSendAllowed(net);

      const sender = await findWallet(from);
      if (!sender) throw new Error(`No local wallet named "${from}". Use dusk_wallet_list.`);

      const recipientWallet = await findWallet(to);
      const recipient = recipientWallet?.account ?? to;
      const kind = await accountKind(recipient);
      if (kind === "address") {
        throw new Error("That is a shielded (Phoenix) address. This server only sends to public accounts.");
      }
      if (kind !== "account") throw new Error("Recipient is not a valid Dusk account or local wallet name.");
      if (recipient === sender.account) throw new Error("Sender and recipient are the same account.");

      const amountLux = duskToLux(amount_dusk);
      if (amountLux <= 0n) throw new Error("Amount must be greater than zero.");
      if (amountLux > maxSendLux) {
        throw new Error(
          `Amount exceeds the per-transfer limit of ${luxToDusk(maxSendLux)} DUSK (DUSK_MAX_SEND_DUSK).`,
        );
      }

      const [state, info, gasStats] = await Promise.all([
        accountState(net, sender.account),
        rues(net, "/on/node/info") as Promise<{ chain_id: number }>,
        rues(net, "/on/blocks/gas-price") as Promise<{ median: number }>,
      ]);
      const gasPrice = BigInt(Math.max(1, Math.ceil(gasStats.median ?? 1)));
      const maxFeeLux = TRANSFER_GAS_LIMIT * gasPrice;
      if (state.balance < amountLux + maxFeeLux) {
        throw new Error(
          `Insufficient balance on ${net.name}: wallet "${sender.name}" has ${luxToDusk(state.balance)} DUSK, needs ${luxToDusk(amountLux + maxFeeLux)} DUSK (amount plus up to ${luxToDusk(maxFeeLux)} fee).`,
        );
      }

      const signed = await signTransfer({
        mnemonic: await unlock(sender.name),
        to: recipient,
        amountLux,
        currentNonce: await nonceBase(net, sender.account, state.nonce),
        chainId: info.chain_id,
        gasLimit: TRANSFER_GAS_LIMIT,
        gasPrice,
        memo,
      });
      await rues(net, "/on/transactions/preverify", { body: signed.hex });

      const now = Date.now();
      for (const [id, p] of prepared) if (p.expiresAt < now) prepared.delete(id);

      const transferId = randomBytes(6).toString("hex");
      const summary = {
        network: net.name,
        from: { wallet: sender.name, account: sender.account },
        to: { wallet: recipientWallet?.name ?? null, account: recipient },
        amountDusk: luxToDusk(amountLux),
        maxFeeDusk: luxToDusk(maxFeeLux),
        memo: memo ?? null,
        nonce: signed.nonce.toString(),
        txHash: signed.hash,
        balanceBeforeDusk: luxToDusk(state.balance),
      };
      prepared.set(transferId, {
        network: net.name,
        hex: signed.hex,
        hash: signed.hash,
        account: sender.account,
        nonce: signed.nonce,
        expiresAt: now + PREPARED_TTL_MS,
        summary,
      });
      return {
        status: "prepared, NOT sent",
        transfer_id: transferId,
        expiresInSeconds: PREPARED_TTL_MS / 1000,
        ...summary,
        next: "Confirm these details with the user, then call dusk_send_transfer with this transfer_id.",
      };
    },
  );

  tool(
    server,
    "dusk_send_transfer",
    "Broadcast a transfer that was prepared with dusk_prepare_transfer. This moves real funds and cannot be undone. Only call it after the user has confirmed the prepared summary.",
    { transfer_id: z.string().describe("The transfer_id returned by dusk_prepare_transfer.") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async ({ transfer_id }) => {
      const item = prepared.get(transfer_id);
      if (!item) throw new Error("Unknown transfer_id. Prepare the transfer again.");
      prepared.delete(transfer_id);
      if (item.expiresAt < Date.now()) throw new Error("This prepared transfer expired. Prepare it again.");

      const net = resolveNetwork(item.network);
      assertSendAllowed(net);
      await rues(net, "/on/transactions/propagate", { body: item.hex });
      lastSent.set(`${net.name}:${item.account}`, { nonce: item.nonce, hash: item.hash });
      return {
        status: "submitted",
        ...item.summary,
        note: "Accepted by the node for routing. This is not finality. Check it with dusk_get_transaction using txHash.",
      };
    },
  );
}
