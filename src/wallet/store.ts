import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveAccount } from "./signer.js";

export const WALLET_DIR = process.env.DUSK_WALLET_DIR ?? join(homedir(), ".dusk-mcp");
const STORE_FILE = join(WALLET_DIR, "wallets.json");
const KEY_FILE = join(WALLET_DIR, "keyfile");
const BACKUP_DIR = join(WALLET_DIR, "backups");

type SecretSource = "password" | "keyfile";

interface StoredWallet {
  name: string;
  account: string;
  createdAt: string;
  secretSource: SecretSource;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

interface StoreFile {
  version: 1;
  wallets: StoredWallet[];
}

export interface WalletInfo {
  name: string;
  account: string;
  createdAt: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function writePrivate(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function load(): Promise<StoreFile> {
  try {
    return JSON.parse(await readFile(STORE_FILE, "utf8")) as StoreFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, wallets: [] };
    throw err;
  }
}

/**
 * The secret that protects recovery phrases at rest. A password from the
 * environment is the strong option. Without one, a random key file is created
 * next to the wallets: that stops casual reads and accidental leaks through
 * backups of a single file, but anyone who can read the whole directory can
 * decrypt the wallets.
 */
async function secret(source: SecretSource): Promise<string> {
  if (source === "password") {
    const password = process.env.DUSK_WALLET_PASSWORD;
    if (!password) {
      throw new Error("This wallet is protected by DUSK_WALLET_PASSWORD, which is not set for the server.");
    }
    return password;
  }
  try {
    return (await readFile(KEY_FILE, "utf8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const key = randomBytes(32).toString("hex");
    await ensureDir(WALLET_DIR);
    await writePrivate(KEY_FILE, key);
    return key;
  }
}

function seal(mnemonic: string, key: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(key, salt, 32), iv);
  const data = Buffer.concat([cipher.update(mnemonic, "utf8"), cipher.final()]);
  return {
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

function open(wallet: StoredWallet, key: string): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(key, Buffer.from(wallet.salt, "hex"), 32),
    Buffer.from(wallet.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(wallet.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(wallet.data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(`Could not decrypt wallet "${wallet.name}". The password or key file does not match.`);
  }
}

const publicInfo = ({ name, account, createdAt }: StoredWallet): WalletInfo => ({ name, account, createdAt });

export async function listWallets(): Promise<WalletInfo[]> {
  return (await load()).wallets.map(publicInfo);
}

export async function findWallet(nameOrAccount: string): Promise<WalletInfo | undefined> {
  return (await listWallets()).find((w) => w.name === nameOrAccount || w.account === nameOrAccount);
}

async function add(name: string, mnemonic: string): Promise<WalletInfo> {
  if (!NAME.test(name)) {
    throw new Error("Wallet name must be 1 to 32 characters: lowercase letters, digits, - or _.");
  }
  const store = await load();
  if (store.wallets.some((w) => w.name === name)) throw new Error(`A wallet named "${name}" already exists.`);
  const account = await deriveAccount(mnemonic);
  const existing = store.wallets.find((w) => w.account === account);
  if (existing) throw new Error(`That recovery phrase is already stored as wallet "${existing.name}".`);

  const secretSource: SecretSource = process.env.DUSK_WALLET_PASSWORD ? "password" : "keyfile";
  const wallet: StoredWallet = {
    name,
    account,
    createdAt: new Date().toISOString(),
    secretSource,
    ...seal(mnemonic, await secret(secretSource)),
  };
  store.wallets.push(wallet);
  await ensureDir(WALLET_DIR);
  await writePrivate(STORE_FILE, JSON.stringify(store, null, 2));
  return publicInfo(wallet);
}

/** Create a wallet. The recovery phrase goes to a private file, never to the caller. */
export async function createWallet(name: string): Promise<WalletInfo & { backupFile: string }> {
  const mnemonic = generateMnemonic(wordlist, 128);
  const info = await add(name, mnemonic);
  await ensureDir(BACKUP_DIR);
  const backupFile = join(BACKUP_DIR, `${name}.recovery-phrase.txt`);
  await writePrivate(backupFile, `${mnemonic}\n`);
  return { ...info, backupFile };
}

/** Import a wallet from a file holding a BIP39 recovery phrase. */
export async function importWallet(name: string, mnemonicFile: string): Promise<WalletInfo> {
  const mnemonic = (await readFile(mnemonicFile, "utf8")).trim().split(/\s+/).join(" ").toLowerCase();
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("The file does not contain a valid BIP39 English recovery phrase.");
  }
  return add(name, mnemonic);
}

/** Decrypt a wallet's recovery phrase for signing. Callers must not return or log it. */
export async function unlock(name: string): Promise<string> {
  const wallet = (await load()).wallets.find((w) => w.name === name);
  if (!wallet) throw new Error(`No wallet named "${name}".`);
  return open(wallet, await secret(wallet.secretSource));
}
