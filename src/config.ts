export const NETWORK_NAMES = ["mainnet", "testnet", "devnet"] as const;
export type NetworkName = (typeof NETWORK_NAMES)[number];

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
  devnet: {
    name: "devnet",
    node: "https://devnet.nodes.dusk.network",
    evmRpc: "https://rpc.devnet.evm.dusk.network",
    evmChainId: 310,
    evmExplorer: "https://explorer.devnet.evm.dusk.network",
  },
};

function readDefaultNetwork(): NetworkName {
  const raw = (process.env.DUSK_NETWORK ?? "mainnet").toLowerCase();
  if (!(NETWORK_NAMES as readonly string[]).includes(raw)) {
    throw new Error(`DUSK_NETWORK must be one of ${NETWORK_NAMES.join(", ")}, got "${raw}"`);
  }
  return raw as NetworkName;
}

/** The network the server started with (DUSK_NETWORK). Endpoint overrides apply to it. */
export const defaultNetwork: NetworkName = readDefaultNetwork();

/**
 * The network used when a tool call does not name one. It starts as the
 * default and can be switched for the rest of the session, so a user can say
 * "use testnet from now on" once instead of repeating it.
 */
let sessionNetwork: NetworkName = defaultNetwork;

export const getSessionNetwork = (): NetworkName => sessionNetwork;

export function setSessionNetwork(name: NetworkName): void {
  sessionNetwork = name;
}

const trim = (url: string) => url.replace(/\/+$/, "");

/**
 * Resolve a network by name. DUSK_NODE_URL and DUSK_EVM_RPC_URL override the
 * endpoints of the default network only, so a private node never silently
 * serves requests that were meant for the other network.
 */
export function resolveNetwork(name?: NetworkName): Network {
  const net = { ...NETWORKS[name ?? sessionNetwork] };
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
