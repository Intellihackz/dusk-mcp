export type NetworkName = "mainnet" | "testnet";

export interface Network {
  name: NetworkName;
  /** Rusk node base URL (GraphQL + RUES /on/... routes). */
  node: string;
  /** DuskEVM JSON-RPC endpoint. */
  evmRpc: string;
  evmChainId: number;
  evmExplorer: string;
}

const NETWORKS: Record<NetworkName, Network> = {
  mainnet: {
    name: "mainnet",
    node: "https://nodes.dusk.network",
    evmRpc: "https://rpc.evm.dusk.network",
    evmChainId: 744,
    evmExplorer: "https://explorer.evm.dusk.network",
  },
  testnet: {
    name: "testnet",
    node: "https://testnet.nodes.dusk.network",
    evmRpc: "https://rpc.testnet.evm.dusk.network",
    evmChainId: 745,
    evmExplorer: "https://explorer.testnet.evm.dusk.network",
  },
};

function readDefaultNetwork(): NetworkName {
  const raw = (process.env.DUSK_NETWORK ?? "mainnet").toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`DUSK_NETWORK must be "mainnet" or "testnet", got "${raw}"`);
  }
  return raw;
}

export const defaultNetwork: NetworkName = readDefaultNetwork();

const trim = (url: string) => url.replace(/\/+$/, "");

/**
 * Resolve a network by name. DUSK_NODE_URL and DUSK_EVM_RPC_URL override the
 * endpoints of the default network only, so a private node never silently
 * serves requests that were meant for the other network.
 */
export function resolveNetwork(name?: NetworkName): Network {
  const net = { ...NETWORKS[name ?? defaultNetwork] };
  if (net.name === defaultNetwork) {
    if (process.env.DUSK_NODE_URL) net.node = trim(process.env.DUSK_NODE_URL);
    if (process.env.DUSK_EVM_RPC_URL) net.evmRpc = trim(process.env.DUSK_EVM_RPC_URL);
  }
  return net;
}

export const TIMEOUT_MS = Number(process.env.DUSK_TIMEOUT_MS ?? 20_000);

/** Genesis contract IDs on the Dusk L1. */
export const TRANSFER_CONTRACT = "0100000000000000000000000000000000000000000000000000000000000000";
export const STAKE_CONTRACT = "0200000000000000000000000000000000000000000000000000000000000000";

export const DOCS_ORIGIN = "https://docs.dusk.network";
