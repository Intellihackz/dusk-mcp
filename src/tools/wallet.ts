import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveNetwork, TRANSFER_CONTRACT, type Network, type NetworkName } from "../config.js";
import { graphql, rues } from "../http.js";
import { duskToLux, luxToDusk, networkArg, tool } from "../util.js";
import { accountKind, signTransfer } from "../wallet/signer.js";
import {
  assertNameAvailable,
  createWallet,
  findWallet,
  importWallet,
  listWallets,
  MIN_PASSWORD_LENGTH,
  setPassword,
  unlock,
  WALLET_DIR,
} from "../wallet/store.js";

/** A plain transfer spends about 1.85M gas on mainnet. Official wallets use this limit. */
const TRANSFER_GAS_LIMIT = 10_000_000n;
const PREPARED_TTL_MS = 5 * 60_000;

const mainnetAllowed = process.env.DUSK_ALLOW_MAINNET_SEND === "1";
/** Optional per-transfer cap. There is no limit unless DUSK_MAX_SEND_DUSK is set. */
const maxSendLux = process.env.DUSK_MAX_SEND_DUSK ? duskToLux(process.env.DUSK_MAX_SEND_DUSK) : null;

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
      "Mainnet transfers are disabled. This server only sends on testnet and devnet unless DUSK_ALLOW_MAINNET_SEND=1 is set in its environment.",
    );
  }
}

const passwordArg = (what: string) =>
  z
    .string()
    .optional()
    .describe(
      `${what} Leave this out: the server then asks the user for it directly, so it stays out of the conversation. Only pass it if the server reports that it cannot prompt, and never invent one.`,
    );

/**
 * Get a wallet password. Prefer asking the user directly through MCP
 * elicitation, so the password goes from the client's prompt to this process
 * without the model seeing it. Clients that cannot prompt fall back to the
 * tool argument, which the agent fills in after asking the user in chat.
 */
async function askPassword(
  server: McpServer,
  provided: string | undefined,
  message: string,
  opts: { confirm?: boolean; label?: string } = {},
): Promise<string> {
  if (provided) return provided;
  const label = opts.label ?? "Wallet password";
  const properties: Record<string, { type: "string"; title: string; minLength?: number }> = {
    password: { type: "string", title: label, minLength: opts.confirm ? MIN_PASSWORD_LENGTH : 1 },
  };
  if (opts.confirm) properties.confirm = { type: "string", title: `Repeat ${label.toLowerCase()}` };

  if (!server.server.getClientCapabilities()?.elicitation) {
    throw new Error(
      `${label} required. This client cannot show a password prompt, so ask the user for it and call this tool again with it as an argument.`,
    );
  }
  const answer = await server.server.elicitInput({
    message,
    requestedSchema: { type: "object", properties, required: Object.keys(properties) },
  });
  const content = (answer.content ?? {}) as Record<string, unknown>;
  if (answer.action !== "accept" || typeof content.password !== "string" || !content.password) {
    throw new Error("Password entry was cancelled. Nothing was done.");
  }
  if (opts.confirm && content.confirm !== content.password) {
    throw new Error("The two passwords did not match. Nothing was done.");
  }
  return content.password;
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
            password: w.hasPassword ? "set" : "NOT SET: run dusk_wallet_set_password before this wallet can send",
            createdAt: w.createdAt,
          };
        }),
      );
      return {
        network: net.name,
        walletDir: WALLET_DIR,
        sending: {
          testnet: "enabled",
          devnet: "enabled",
          mainnet: mainnetAllowed ? "enabled" : "disabled",
          maxPerTransferDusk: maxSendLux === null ? "no limit" : luxToDusk(maxSendLux),
        },
        wallets: rows,
      };
    },
  );

  tool(
    server,
    "dusk_wallet_create",
    "Create a new local Dusk wallet (public Moonlight account) protected by its own password. The user chooses the password and must enter it again for every transfer. The recovery phrase is written to a private file on disk and is never returned. Tell the user where the backup file is and that they should move it somewhere safe.",
    {
      name: z.string().describe("Short wallet name: lowercase letters, digits, - or _."),
      password: passwordArg(`New password for this wallet, at least ${MIN_PASSWORD_LENGTH} characters.`),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ name, password }) => {
      await assertNameAvailable(name);
      const chosen = await askPassword(
        server,
        password,
        `Choose a password for the new Dusk wallet "${name}" (at least ${MIN_PASSWORD_LENGTH} characters). You will need it for every transfer. It is not stored and cannot be recovered.`,
        { confirm: true },
      );
      const wallet = await createWallet(name, chosen);
      return {
        name: wallet.name,
        account: wallet.account,
        recoveryPhraseFile: wallet.backupFile,
        note: "The wallet password is not stored anywhere. If it is lost, the recovery phrase file is the only way back. Anyone who reads that file controls the wallet. The same account works on mainnet and testnet.",
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
      password: passwordArg(`New password for this wallet, at least ${MIN_PASSWORD_LENGTH} characters.`),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ name, recovery_phrase_file, password }) => {
      await assertNameAvailable(name);
      const chosen = await askPassword(
        server,
        password,
        `Choose a password for the imported Dusk wallet "${name}" (at least ${MIN_PASSWORD_LENGTH} characters). You will need it for every transfer.`,
        { confirm: true },
      );
      const wallet = await importWallet(name, recovery_phrase_file, chosen);
      return {
        ...wallet,
        note: "Imported. Consider deleting the source file now that the phrase is stored encrypted.",
      };
    },
  );

  tool(
    server,
    "dusk_wallet_set_password",
    "Set or change the password of a local Dusk wallet. Changing an existing password requires the current one. Use this for a wallet that reports its password as NOT SET.",
    {
      name: z.string().describe("Name of the local wallet."),
      current_password: passwordArg("Current password, if the wallet has one."),
      new_password: passwordArg(`New password, at least ${MIN_PASSWORD_LENGTH} characters.`),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ name, current_password, new_password }) => {
      const wallet = await findWallet(name);
      if (!wallet || wallet.name !== name) throw new Error(`No local wallet named "${name}". Use dusk_wallet_list.`);
      const current = wallet.hasPassword
        ? await askPassword(server, current_password, `Enter the CURRENT password for Dusk wallet "${name}".`, {
            label: "Current password",
          })
        : undefined;
      const next = await askPassword(
        server,
        new_password,
        `Choose a NEW password for Dusk wallet "${name}" (at least ${MIN_PASSWORD_LENGTH} characters). It is not stored and cannot be recovered.`,
        { confirm: true, label: "New password" },
      );
      const updated = await setPassword(name, next, current);
      return { name: updated.name, account: updated.account, password: "set" };
    },
  );

  tool(
    server,
    "dusk_prepare_transfer",
    "Prepare a public DUSK transfer on the Dusk L1 from a local wallet. The user must enter the sending wallet's password. This signs the transaction, checks balance and limits, and asks the node to preverify it, but does NOT broadcast. It returns a summary and a transfer_id. Show the summary to the user, then call dusk_send_transfer to broadcast.",
    {
      from: z.string().describe("Name of the local wallet to send from."),
      to: z.string().describe("Recipient: a Dusk account (base58 BLS public key) or the name of another local wallet."),
      amount_dusk: z.string().describe('Amount in DUSK as a decimal string, e.g. "1.5".'),
      memo: z.string().max(512).optional().describe("Optional public memo stored on-chain."),
      password: passwordArg("Password of the sending wallet."),
      ...networkArg,
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ from, to, amount_dusk, memo, password, network }) => {
      const net = resolveNetwork(network);
      assertSendAllowed(net);

      const sender = await findWallet(from);
      if (!sender) throw new Error(`No local wallet named "${from}". Use dusk_wallet_list.`);
      if (!sender.hasPassword) {
        throw new Error(`Wallet "${sender.name}" has no password yet. Set one with dusk_wallet_set_password first.`);
      }

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
      if (maxSendLux !== null && amountLux > maxSendLux) {
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

      // Ask only now, after every check has passed, so the user is never
      // prompted for a transfer that would be refused anyway.
      const entered = await askPassword(
        server,
        password,
        `Enter the password for Dusk wallet "${sender.name}" to sign: send ${luxToDusk(amountLux)} DUSK on ${net.name} to ${recipientWallet ? `wallet "${recipientWallet.name}"` : `${recipient.slice(0, 12)}...${recipient.slice(-8)}`}. This only prepares the transfer.`,
      );
      const signed = await signTransfer({
        mnemonic: await unlock(sender.name, entered),
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
