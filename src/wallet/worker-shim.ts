import { resolveObjectURL } from "node:buffer";
import { MessagePort, Worker as NodeWorker } from "node:worker_threads";

/**
 * W3sper runs its WASM driver inside a browser-style `new Worker(blobUrl)`.
 * Node has worker_threads but no global Worker and no blob: worker support,
 * so this adapts one to the other: it gives the worker script the `self`,
 * `addEventListener` and `postMessage` globals it expects, and wraps messages
 * in `{ data, ports }` events on both sides.
 */
const BOOTSTRAP = `
const { parentPort } = require("node:worker_threads");
const listeners = new Set();
globalThis.self = globalThis;
globalThis.addEventListener = (type, fn) => { if (type === "message") listeners.add(fn); };
globalThis.removeEventListener = (type, fn) => { listeners.delete(fn); };
globalThis.postMessage = (data, transfer) => parentPort.postMessage({ data }, transfer);
parentPort.once("message", ({ code }) => {
  (0, eval)(code);
  parentPort.on("message", ({ data, ports }) => {
    for (const fn of [...listeners]) fn({ data, ports });
  });
});
`;

export class BlobWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  #worker: NodeWorker;
  #ready: Promise<void>;

  constructor(url: string | URL) {
    const blob = resolveObjectURL(String(url));
    if (!blob) throw new Error("BlobWorker only supports blob: URLs");
    this.#worker = new NodeWorker(BOOTSTRAP, { eval: true });
    this.#worker.on("message", ({ data }) => this.onmessage?.({ data }));
    this.#worker.on("error", (err) => this.onmessage?.({ data: err }));
    this.#ready = blob.text().then((code) => this.#worker.postMessage({ code }));
  }

  postMessage(data: unknown, transfer: any[] = []): void {
    const ports = transfer.filter((t) => t instanceof MessagePort);
    void this.#ready.then(() => this.#worker.postMessage({ data, ports }, transfer));
  }

  terminate(): Promise<number> {
    return this.#worker.terminate();
  }
}
