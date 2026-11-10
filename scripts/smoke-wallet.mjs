// Wallet smoke test on testnet, using a throwaway wallet directory so it
// never touches real wallets. Run with `npm run build && npm run smoke:wallet`.
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const dir = await mkdtemp(join(tmpdir(), "dusk-mcp-wallet-"));
const env = { ...process.env, DUSK_ENABLE_WALLET: "1", DUSK_NETWORK: "testnet", DUSK_WALLET_DIR: dir, DUSK_MAX_SEND_DUSK: "5" };
const PW = "smoke-test-pw-1";
const PW2 = "smoke-test-pw-2";

let failed = 0;
let passed = 0;
function check(label, ok, detail = "") {
  ok ? passed++ : failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${!ok && detail ? `\n     ${detail}` : ""}`);
}
const exists = (path) => access(path).then(() => true, () => false);

async function connect(capabilities = {}) {
  const client = new Client({ name: "smoke-wallet", version: "0.0.0" }, { capabilities });
  const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env, stderr: "ignore" });
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { error: Boolean(res.isError), text, data };
  };
  return { client, transport, call };
}

// ---------------------------------------------------------------------------
// Part 1: a client that cannot prompt, so passwords arrive as tool arguments.
// ---------------------------------------------------------------------------
console.log("\n# Part 1: password passed as an argument\n");
const plain = await connect();
await plain.client.connect(plain.transport);
const { call } = plain;

const names = (await plain.client.listTools()).tools.map((t) => t.name);
check("wallet tools are registered", ["dusk_wallet_list", "dusk_wallet_create", "dusk_wallet_import", "dusk_wallet_set_password", "dusk_prepare_transfer", "dusk_send_transfer"].every((n) => names.includes(n)));

const noPw = await call("dusk_wallet_create", { name: "alice" });
check("create without a password is refused when the client cannot prompt", noPw.error && noPw.text.includes("cannot show a password prompt"), noPw.text);
const shortPw = await call("dusk_wallet_create", { name: "alice", password: "short" });
check("short password rejected", shortPw.error && shortPw.text.includes("at least 8"), shortPw.text);
check("nothing was written by the refused attempts", !(await exists(join(dir, "wallets.json"))));

const a = await call("dusk_wallet_create", { name: "alice", password: PW });
check("create wallet with a password", !a.error && a.data?.account?.length > 100, a.text);
const phrase = (await readFile(a.data.recoveryPhraseFile, "utf8")).trim();
check("recovery phrase is 12 words on disk", phrase.split(" ").length === 12);
check("recovery phrase is not in tool output", !a.text.includes(phrase.split(" ").slice(0, 3).join(" ")));
check("password is not in tool output", !a.text.includes(PW));
check("backup file mode is 0600", ((await stat(a.data.recoveryPhraseFile)).mode & 0o777) === 0o600);
const stored = await readFile(join(dir, "wallets.json"), "utf8");
check("keystore holds no plaintext phrase or password", !stored.includes(phrase.split(" ").slice(0, 2).join(" ")) && !stored.includes(PW));
check("keystore file mode is 0600", ((await stat(join(dir, "wallets.json"))).mode & 0o777) === 0o600);
check("no key file is created", !(await exists(join(dir, "keyfile"))));

const dup = await call("dusk_wallet_create", { name: "alice", password: PW });
check("duplicate name rejected", dup.error, dup.text);
const bad = await call("dusk_wallet_create", { name: "Bad Name!", password: PW });
check("invalid name rejected", bad.error, bad.text);
const imp = await call("dusk_wallet_import", { name: "alice2", recovery_phrase_file: a.data.recoveryPhraseFile, password: PW });
check("re-import of same phrase rejected (same account derived)", imp.error && imp.text.includes("alice"), imp.text);
const b = await call("dusk_wallet_create", { name: "bob", password: PW2 });
check("second wallet gets a different account", !b.error && b.data.account !== a.data.account);

const list = await call("dusk_wallet_list");
check("list shows both wallets with password set", list.data?.wallets?.length === 2 && list.data.wallets.every((w) => w.password === "set" && w.balanceDusk === "0"), list.text);

const poor = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1", password: PW });
check("unfunded transfer refused", poor.error && poor.text.includes("Insufficient"), poor.text);
const cap = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "6", password: PW });
check("amount over the cap refused", cap.error && cap.text.includes("limit"), cap.text);
const main = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1", network: "mainnet", password: PW });
check("mainnet send refused by default", main.error && main.text.includes("Mainnet"), main.text);
const self = await call("dusk_prepare_transfer", { from: "alice", to: "alice", amount_dusk: "1", password: PW });
check("self transfer refused", self.error, self.text);
const junk = await call("dusk_prepare_transfer", { from: "alice", to: "not-an-account", amount_dusk: "1", password: PW });
check("invalid recipient refused", junk.error, junk.text);
const amt = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1e3", password: PW });
check("malformed amount refused", amt.error, amt.text);
const ghost = await call("dusk_send_transfer", { transfer_id: "deadbeef" });
check("unknown transfer_id refused", ghost.error, ghost.text);

const chWrong = await call("dusk_wallet_set_password", { name: "alice", current_password: "not-the-password", new_password: PW2 });
check("password change with wrong current password refused", chWrong.error && chWrong.text.includes("Wrong current password"), chWrong.text);
const chOk = await call("dusk_wallet_set_password", { name: "alice", current_password: PW, new_password: PW2 });
check("password change with correct current password works", !chOk.error && chOk.data?.password === "set", chOk.text);

// A real testnet transfer sent by this project, with a text memo.
const memoTx = await call("dusk_get_transaction", { hash: "07b625934a58c16f7a0bf613757d1da66d8042b09cd742cfdf47b06f94b5b41f" });
if (memoTx.error) console.log("WARN reference memo transaction not found (testnet may have been reset)");
else check("memo is decoded to text", memoTx.data?.tx?.memoText === "dusk-mcp first transfer");
await plain.client.close();

// ---------------------------------------------------------------------------
// Part 2: the keystore itself. Each wallet opens only with its own password.
// ---------------------------------------------------------------------------
console.log("\n# Part 2: keystore\n");
process.env.DUSK_WALLET_DIR = dir;
const keystore = await import("../dist/wallet/store.js");
const reason = (promise) => promise.then(() => null, (e) => e.message);
check("wallet opens with its new password", (await keystore.unlock("alice", PW2)) === phrase);
check("old password no longer works", (await reason(keystore.unlock("alice", PW)))?.includes("Wrong password"));
check("empty password is rejected", (await reason(keystore.unlock("alice", "")))?.includes("Wrong password"));

// A wallet from before per-wallet passwords: encrypted with a key file.
const legacyKey = randomBytes(32).toString("hex");
await writeFile(join(dir, "keyfile"), legacyKey, { mode: 0o600 });
const salt = randomBytes(16);
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", scryptSync(legacyKey, salt, 32), iv);
const legacyPhrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const data = Buffer.concat([cipher.update(legacyPhrase, "utf8"), cipher.final()]);
const file = JSON.parse(await readFile(join(dir, "wallets.json"), "utf8"));
file.wallets.push({ name: "old", account: "legacy-account-placeholder", createdAt: new Date().toISOString(), secretSource: "keyfile", salt: salt.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") });
await writeFile(join(dir, "wallets.json"), JSON.stringify(file), { mode: 0o600 });

check("legacy wallet reports no password", (await keystore.findWallet("old"))?.hasPassword === false);
check("legacy wallet cannot sign until it has a password", (await reason(keystore.unlock("old", PW)))?.includes("has no password yet"));
await keystore.setPassword("old", PW);
check("legacy wallet opens with its new password", (await keystore.unlock("old", PW)) === legacyPhrase);
check("legacy key file is deleted once unused", !(await exists(join(dir, "keyfile"))));

// ---------------------------------------------------------------------------
// Part 3: a client that can prompt. The server asks the user directly and the
// password never appears in a tool call.
// ---------------------------------------------------------------------------
console.log("\n# Part 3: server prompts the user\n");
const prompting = await connect({ elicitation: {} });
let nextAnswer = null;
const prompts = [];
prompting.client.setRequestHandler(ElicitRequestSchema, async (request) => {
  prompts.push(request.params);
  return nextAnswer;
});
await prompting.client.connect(prompting.transport);

nextAnswer = { action: "accept", content: { password: PW, confirm: PW } };
const c = await prompting.call("dusk_wallet_create", { name: "carol" });
check("create prompts the user and succeeds with no password argument", !c.error && c.data?.name === "carol" && prompts.length === 1, c.text);
check("prompt names the wallet and asks for password twice", prompts[0]?.message.includes('"carol"') && Object.keys(prompts[0].requestedSchema.properties).join() === "password,confirm");
check("prompted wallet opens with the entered password", (await keystore.unlock("carol", PW)).split(" ").length === 12);

nextAnswer = { action: "accept", content: { password: PW, confirm: "something-else" } };
const mismatch = await prompting.call("dusk_wallet_create", { name: "dave" });
check("mismatched confirmation is refused", mismatch.error && mismatch.text.includes("did not match"), mismatch.text);
nextAnswer = { action: "cancel" };
const cancelled = await prompting.call("dusk_wallet_create", { name: "dave" });
check("cancelled prompt is refused", cancelled.error && cancelled.text.includes("cancelled"), cancelled.text);
check("no wallet was created by refused prompts", !(await keystore.findWallet("dave")));

const before = prompts.length;
const early = await prompting.call("dusk_prepare_transfer", { from: "carol", to: "bob", amount_dusk: "1" });
check("unfunded transfer is refused before any password prompt", early.error && early.text.includes("Insufficient") && prompts.length === before, early.text);
await prompting.client.close();

await rm(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed, ${passed} passed` : `\nall ${passed} wallet checks passed`);
process.exit(failed ? 1 : 0);
