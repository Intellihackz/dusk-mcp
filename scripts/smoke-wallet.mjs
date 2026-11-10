// Wallet smoke test on testnet, using a throwaway wallet directory so it
// never touches real wallets. Run with `npm run build && npm run smoke:wallet`.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "dusk-mcp-wallet-"));
const client = new Client({ name: "smoke-wallet", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, DUSK_ENABLE_WALLET: "1", DUSK_NETWORK: "testnet", DUSK_WALLET_DIR: dir, DUSK_MAX_SEND_DUSK: "5" },
    stderr: "inherit",
  }),
);

let failed = 0;
function check(label, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `\n     ${detail}` : ""}`);
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { error: Boolean(res.isError), text, data };
}

const names = (await client.listTools()).tools.map((t) => t.name);
check("wallet tools are registered", ["dusk_wallet_list", "dusk_wallet_create", "dusk_wallet_import", "dusk_prepare_transfer", "dusk_send_transfer"].every((n) => names.includes(n)));

const a = await call("dusk_wallet_create", { name: "alice" });
check("create wallet", !a.error && a.data?.account?.length > 100, a.text.slice(0, 200).replace(/\s+/g, " "));
const phrase = (await readFile(a.data.recoveryPhraseFile, "utf8")).trim();
check("recovery phrase is 12 words on disk", phrase.split(" ").length === 12);
check("recovery phrase is not in tool output", !a.text.includes(phrase.split(" ").slice(0, 3).join(" ")));
check("backup file mode is 0600", ((await stat(a.data.recoveryPhraseFile)).mode & 0o777) === 0o600);
const store = await readFile(join(dir, "wallets.json"), "utf8");
check("keystore holds no plaintext phrase", !store.includes(phrase.split(" ")[0] + " " + phrase.split(" ")[1]));
check("keystore file mode is 0600", ((await stat(join(dir, "wallets.json"))).mode & 0o777) === 0o600);

const dup = await call("dusk_wallet_create", { name: "alice" });
check("duplicate name rejected", dup.error, dup.text);
const bad = await call("dusk_wallet_create", { name: "Bad Name!" });
check("invalid name rejected", bad.error, bad.text);
const imp = await call("dusk_wallet_import", { name: "alice2", recovery_phrase_file: a.data.recoveryPhraseFile });
check("re-import of same phrase rejected (same account derived)", imp.error && imp.text.includes("alice"), imp.text);

const b = await call("dusk_wallet_create", { name: "bob" });
check("create second wallet with a different account", !b.error && b.data.account !== a.data.account);

const list = await call("dusk_wallet_list");
check("list shows both wallets with balances", list.data?.wallets?.length === 2 && list.data.wallets[0].balanceDusk === "0", list.text.slice(0, 260).replace(/\s+/g, " "));

const poor = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1" });
check("unfunded transfer refused before signing", poor.error && poor.text.includes("Insufficient"), poor.text);
const cap = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "6" });
check("amount over the cap refused", cap.error && cap.text.includes("limit"), cap.text);
const main = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1", network: "mainnet" });
check("mainnet send refused by default", main.error && main.text.includes("Mainnet"), main.text);
const self = await call("dusk_prepare_transfer", { from: "alice", to: "alice", amount_dusk: "1" });
check("self transfer refused", self.error, self.text);
const junk = await call("dusk_prepare_transfer", { from: "alice", to: "not-an-account", amount_dusk: "1" });
check("invalid recipient refused", junk.error, junk.text);
const amt = await call("dusk_prepare_transfer", { from: "alice", to: "bob", amount_dusk: "1e3" });
check("malformed amount refused", amt.error, amt.text);
const ghost = await call("dusk_send_transfer", { transfer_id: "deadbeef" });
check("unknown transfer_id refused", ghost.error, ghost.text);

await client.close();
await rm(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\nall wallet checks passed");
process.exit(failed ? 1 : 0);
