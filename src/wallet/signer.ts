import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mnemonicToSeed } from "@scure/bip39";
import { BlobWorker } from "./worker-shim.js";

/**
 * The protocol driver is the WASM that derives keys and signs. It is vendored
 * and pinned by hash so a node can never hand this process different signing
 * code. Both public nodes served this exact file for W3sper 1.6.0.
 */
const DRIVER_FILE = new URL("../../assets/wallet-core-1.6.0.wasm", import.meta.url);
const DRIVER_SHA256 = "a20b7e34b5fe5b3fa4c9ed25a4881e7eba5eed0ba8b6befb48b4aaf4a4cf0680";

let sdkPromise: Promise<any> | undefined;

function sdk(): Promise<any> {
  sdkPromise ??= (async () => {
    (globalThis as any).Worker ??= BlobWorker;
    const w3 = await import("@jsr/dusk__w3sper");
    const driver = await readFile(DRIVER_FILE);
    const digest = createHash("sha256").update(driver).digest("hex");
    if (digest !== DRIVER_SHA256) {
      throw new Error("wallet-core driver hash mismatch. Refusing to load signing code.");
    }
    // Deliberately not awaited: the returned object is a thenable whose
    // `then` unloads the driver once it settles.
    w3.useAsProtocolDriver(driver);
    return w3;
  })();
  return sdkPromise;
}

async function profileFor(mnemonic: string, index: number): Promise<{ w3: any; profile: any }> {
  const w3 = await sdk();
  // Standard BIP39 seed with an empty passphrase, the same derivation
  // rusk-wallet uses, so a phrase is portable between the two.
  const seed = await mnemonicToSeed(mnemonic);
  const generator = new w3.ProfileGenerator(() => seed);
  let profile = await generator.default;
  for (let i = 0; i < index; i++) profile = await generator.next();
  return { w3, profile };
}

/** Public (Moonlight) account for a recovery phrase: a base58 BLS public key. */
export async function deriveAccount(mnemonic: string, index = 0): Promise<string> {
  const { profile } = await profileFor(mnemonic, index);
  return profile.account.toString();
}

export async function accountKind(value: string): Promise<"account" | "address" | "undefined"> {
  const w3 = await sdk();
  try {
    return w3.ProfileGenerator.typeOf(value);
  } catch {
    return "undefined";
  }
}

export interface TransferRequest {
  mnemonic: string;
  index?: number;
  to: string;
  amountLux: bigint;
  /** The sender's current committed nonce. The transaction uses nonce + 1. */
  currentNonce: bigint;
  chainId: number;
  gasLimit: bigint;
  gasPrice: bigint;
  memo?: string;
}

export interface SignedTransfer {
  hex: string;
  hash: string;
  nonce: bigint;
}

/** Build and sign a public transfer entirely offline. Nothing is broadcast. */
export async function signTransfer(req: TransferRequest): Promise<SignedTransfer> {
  const { w3, profile } = await profileFor(req.mnemonic, req.index ?? 0);
  let builder = new w3.Transfer(profile).amount(req.amountLux);
  if (req.memo) builder = builder.memo(req.memo);
  const tx = await builder
    .to(req.to)
    .nonce(req.currentNonce)
    .chain(req.chainId)
    .gas({ limit: req.gasLimit, price: req.gasPrice })
    .build();
  return {
    hex: `0x${Buffer.from(tx.buffer).toString("hex")}`,
    hash: tx.hash,
    nonce: tx.nonce,
  };
}
