import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveAccount } from "./signer.js";

export const WALLET_DIR = process.env.DUSK_WALLET_DIR ?? join(homedir(), ".dusk-mcp");
const STORE_FILE = join(WALLET_DIR, "wallets.json");
const BACKUP_DIR = join(WALLET_DIR, "backups");
/** Only read for wallets created before per-wallet passwords existed. */
const LEGACY_KEY_FILE = join(WALLET_DIR, "keyfile");

export const MIN_PASSWORD_LENGTH = 8;

/**
 * "password": encrypted with the wallet's own password, which is never stored.
 * "keyfile": legacy, encrypted with a key file beside the keystore. Such a
 * wallet must be given a password before it can sign.
 */
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
  hasPassword: boolean;
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

async function save(store: StoreFile): Promise<void> {
  await ensureDir(WALLET_DIR);
  await writePrivate(STORE_FILE, JSON.stringify(store, null, 2));
}

function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The wallet password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

/** AES-256-GCM with an scrypt-derived key and a fresh salt per wallet. */
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

/** GCM authenticates the ciphertext, so a wrong key fails here instead of yielding garbage. */
function open(wallet: StoredWallet, key: string): string | null {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    scryptSync(key, Buffer.from(wallet.salt, "hex"), 32),
    Buffer.from(wallet.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(wallet.tag, "hex"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(wallet.data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const publicInfo = ({ name, account, createdAt, secretSource }: StoredWallet): WalletInfo => ({
  name,
  account,
  createdAt,
  hasPassword: secretSource === "password",
});

function requireWallet(store: StoreFile, name: string): StoredWallet {
  const wallet = store.wallets.find((w) => w.name === name);
  if (!wallet) throw new Error(`No wallet named "${name}".`);
  return wallet;
}

export async function listWallets(): Promise<WalletInfo[]> {
  return (await load()).wallets.map(publicInfo);
}

export async function findWallet(nameOrAccount: string): Promise<WalletInfo | undefined> {
  return (await listWallets()).find((w) => w.name === nameOrAccount || w.account === nameOrAccount);
}

async function add(name: string, mnemonic: string, password: string): Promise<WalletInfo> {
  if (!NAME.test(name)) {
    throw new Error("Wallet name must be 1 to 32 characters: lowercase letters, digits, - or _.");
  }
  checkPassword(password);
  const store = await load();
  if (store.wallets.some((w) => w.name === name)) throw new Error(`A wallet named "${name}" already exists.`);
  const account = await deriveAccount(mnemonic);
  const existing = store.wallets.find((w) => w.account === account);
  if (existing) throw new Error(`That recovery phrase is already stored as wallet "${existing.name}".`);

  const wallet: StoredWallet = {
    name,
    account,
    createdAt: new Date().toISOString(),
    secretSource: "password",
    ...seal(mnemonic, password),
  };
  store.wallets.push(wallet);
  await save(store);
  return publicInfo(wallet);
}

/** Check a name before prompting for a password, so the user is not asked for nothing. */
export async function assertNameAvailable(name: string): Promise<void> {
  if (!NAME.test(name)) {
    throw new Error("Wallet name must be 1 to 32 characters: lowercase letters, digits, - or _.");
  }
  if ((await load()).wallets.some((w) => w.name === name)) {
    throw new Error(`A wallet named "${name}" already exists.`);
  }
}

/** Create a wallet. The recovery phrase goes to a private file, never to the caller. */
export async function createWallet(name: string, password: string): Promise<WalletInfo & { backupFile: string }> {
  const mnemonic = generateMnemonic(wordlist, 128);
  const info = await add(name, mnemonic, password);
  await ensureDir(BACKUP_DIR);
  const backupFile = join(BACKUP_DIR, `${name}.recovery-phrase.txt`);
  await writePrivate(backupFile, `${mnemonic}\n`);
  return { ...info, backupFile };
}

/** Import a wallet from a file holding a BIP39 recovery phrase. */
export async function importWallet(name: string, mnemonicFile: string, password: string): Promise<WalletInfo> {
  const mnemonic = (await readFile(mnemonicFile, "utf8")).trim().split(/\s+/).join(" ").toLowerCase();
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error("The file does not contain a valid BIP39 English recovery phrase.");
  }
  return add(name, mnemonic, password);
}

/** Decrypt a wallet's recovery phrase for signing. Callers must not return or log it. */
export async function unlock(name: string, password: string): Promise<string> {
  const wallet = requireWallet(await load(), name);
  if (wallet.secretSource !== "password") {
    throw new Error(`Wallet "${name}" has no password yet. Set one with dusk_wallet_set_password first.`);
  }
  const mnemonic = open(wallet, password);
  if (mnemonic === null) throw new Error(`Wrong password for wallet "${name}".`);
  return mnemonic;
}

/**
 * Set or change a wallet's password. A wallet that already has one needs the
 * current password. A legacy key-file wallet is converted, and the key file
 * is removed once no wallet depends on it.
 */
export async function setPassword(name: string, newPassword: string, currentPassword?: string): Promise<WalletInfo> {
  checkPassword(newPassword);
  const store = await load();
  const wallet = requireWallet(store, name);

  let mnemonic: string | null;
  if (wallet.secretSource === "password") {
    if (!currentPassword) throw new Error(`Wallet "${name}" already has a password. The current password is required to change it.`);
    mnemonic = open(wallet, currentPassword);
    if (mnemonic === null) throw new Error(`Wrong current password for wallet "${name}".`);
  } else {
    mnemonic = open(wallet, (await readFile(LEGACY_KEY_FILE, "utf8")).trim());
    if (mnemonic === null) throw new Error(`Could not read legacy wallet "${name}". Restore it from its recovery phrase.`);
  }

  Object.assign(wallet, seal(mnemonic, newPassword), { secretSource: "password" });
  await save(store);
  if (!store.wallets.some((w) => w.secretSource === "keyfile")) await rm(LEGACY_KEY_FILE, { force: true });
  return publicInfo(wallet);
}
