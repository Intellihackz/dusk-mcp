# dusk-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the [Dusk Network](https://docs.dusk.network/). It lets an AI agent inspect the Dusk L1, query DuskVM contracts, read DuskEVM state, and look things up in the official docs.

By default it is read-only: no keys, and nothing can be signed or broadcast. An optional wallet module, off unless you enable it, adds local wallets and public DUSK transfers.

## Tools

**Dusk L1 (Rusk node)**

| Tool | What it does |
|---|---|
| `dusk_node_info` | Rusk version, chain ID, VM config, hard-fork heights |
| `dusk_network_stats` | Tip, transaction totals, account count, gas price |
| `dusk_provisioners` | Stakers ranked by stake, with network totals |
| `dusk_get_block` | Block by height or hash, latest by default |
| `dusk_latest_blocks` | Recent blocks with transaction IDs |
| `dusk_get_transaction` | Included or pending transaction by hash |
| `dusk_mempool` | This node's local mempool |
| `dusk_get_account` | Public (Moonlight) balance and nonce |
| `dusk_account_history` | Public transfer history (archive data) |
| `dusk_check_transaction` | Preverify or simulate a signed transaction without sending it |
| `dusk_graphql` | Any GraphQL query against the node |

**DuskVM contracts**

| Tool | What it does |
|---|---|
| `dusk_contract_metadata` | Owner, driver availability, balance |
| `dusk_contract_schema` | ABI from the contract's data driver |
| `dusk_call_contract` | Read-only method query with JSON in and out |
| `dusk_contract_events` | Finalized events, paginated (archive data) |

**DuskEVM**

| Tool | What it does |
|---|---|
| `dusk_evm_info` | Chain ID, block number, gas price, RPC and explorer URLs |
| `dusk_evm_get_account` | Balance, nonce, contract check |
| `dusk_evm_rpc` | Allowlisted read-only JSON-RPC methods |

**Docs**

| Tool | What it does |
|---|---|
| `dusk_docs_index` | Index of docs.dusk.network pages |
| `dusk_read_doc` | One docs page as plain text |

**Wallet (only when `DUSK_ENABLE_WALLET=1`)**

| Tool | What it does |
|---|---|
| `dusk_wallet_list` | Local wallets with public account and balance |
| `dusk_wallet_create` | New wallet; recovery phrase goes to a private file |
| `dusk_wallet_import` | Import from a file holding a BIP39 recovery phrase |
| `dusk_prepare_transfer` | Sign and preverify a public DUSK transfer, without sending |
| `dusk_send_transfer` | Broadcast a prepared transfer |

Every network tool takes an optional `network` argument: `"mainnet"` or `"testnet"`.

## Wallet module

Enable it by setting `DUSK_ENABLE_WALLET=1` in the server's environment. Without that the five wallet tools do not exist.

How funds are protected:

- **Recovery phrases never reach the model.** Create writes the phrase to `~/.dusk-mcp/backups/<name>.recovery-phrase.txt` (mode 0600) and returns only the public account. Import takes a file path, not the phrase.
- **Encrypted at rest.** Phrases are stored in `~/.dusk-mcp/wallets.json` with AES-256-GCM and an scrypt-derived key. Set `DUSK_WALLET_PASSWORD` for real protection. Without it a random key file is created beside the wallets, which only protects against casual reads.
- **Two steps to send.** `dusk_prepare_transfer` signs, checks balance and limits, and has the node preverify. `dusk_send_transfer` broadcasts exactly that signed transaction. Prepared transfers live in memory for 5 minutes.
- **Testnet only by default.** Mainnet sends need `DUSK_ALLOW_MAINNET_SEND=1`.
- **Per-transfer cap.** `DUSK_MAX_SEND_DUSK`, default 100.
- **Pinned signing code.** The `wallet-core` WASM driver is vendored in `assets/` and checked against a SHA-256 before use.

Wallets are public (Moonlight) accounts derived from a standard BIP39 seed at profile index 0, the same scheme `rusk-wallet` uses. The same account is valid on mainnet and testnet.

```bash
npm run smoke:wallet
```

That test runs on testnet in a throwaway directory and covers creation, storage, and every refusal path. It does not broadcast a transfer, because that needs testnet DUSK.

## Setup

```bash
npm install
```

```bash
npm run build
```

```bash
npm run smoke
```

`smoke` starts the built server and calls every tool against the live network.

## Use it from a client

Claude Code:

```bash
claude mcp add dusk -- node /absolute/path/to/dusk-mcp/dist/index.js
```

Claude Desktop, Cursor, and other clients that read an `mcpServers` block:

```json
{
  "mcpServers": {
    "dusk": {
      "command": "node",
      "args": ["/absolute/path/to/dusk-mcp/dist/index.js"],
      "env": { "DUSK_NETWORK": "mainnet" }
    }
  }
}
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DUSK_NETWORK` | `mainnet` | Default network: `mainnet` or `testnet` |
| `DUSK_NODE_URL` | public Dusk node | Override the Rusk node URL for the default network |
| `DUSK_EVM_RPC_URL` | public DuskEVM RPC | Override the EVM RPC URL for the default network |
| `DUSK_TIMEOUT_MS` | `20000` | Per-request timeout |
| `DUSK_ENABLE_WALLET` | off | Set to `1` to register the wallet tools |
| `DUSK_WALLET_PASSWORD` | none | Password that encrypts recovery phrases |
| `DUSK_WALLET_DIR` | `~/.dusk-mcp` | Where wallets and backups are stored |
| `DUSK_ALLOW_MAINNET_SEND` | off | Set to `1` to allow mainnet transfers |
| `DUSK_MAX_SEND_DUSK` | `100` | Largest amount one transfer may send |

## Known limits

- **A real transfer has not been broadcast yet.** A signed transfer from an unfunded wallet is parsed by the testnet node and rejected only for lack of balance, but the full send path needs a funded testnet wallet to confirm.
- **Shielded activity is invisible.** Phoenix balances and transfers are private by design. Only public (Moonlight) state can be queried.
- **Archive tools need an archive node.** `dusk_account_history` and `dusk_contract_events` work against the public nodes today. A private non-archive node will reject them.
- **Mainnet DuskEVM RPC.** At the time of writing, `https://rpc.evm.dusk.network` serves a TLS certificate that cannot be verified, so mainnet `dusk_evm_*` calls fail. Testnet works. This server does not skip certificate checks. Set `DUSK_EVM_RPC_URL` if you have another endpoint.
- **Large numbers.** Node responses are parsed as JSON numbers, so integers above 2^53 lose precision. Stake totals are summed with BigInt to avoid this.
- **The mempool is one node's view**, not the whole network.

## Layout

```
src/
  index.ts        server entry, stdio transport
  config.ts       networks, env overrides, genesis contract IDs
  http.ts         RUES, GraphQL, EVM JSON-RPC and docs fetchers
  util.ts         tool wrappers, DUSK and LUX conversion
  tools/
    l1.ts         Dusk L1 and DuskVM contract tools
    evm.ts        DuskEVM tools
    docs.ts       docs tools
    wallet.ts     wallet and transfer tools
  wallet/
    store.ts      encrypted keystore and backups
    signer.ts     key derivation and offline signing via W3sper
    worker-shim.ts  lets W3sper's browser-style worker run on Node
assets/           pinned wallet-core WASM driver
scripts/          live smoke tests
```

## Not built yet

- Shielded (Phoenix) transfers, shielding and unshielding
- Staking, unstaking and reward withdrawal
- State-changing DuskVM contract calls
- DuskEVM wallets and transfers
- Removing or renaming a wallet (delete it from `wallets.json` by hand)
