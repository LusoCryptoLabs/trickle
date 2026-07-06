import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Escrow, Hash256 } from "./types.js";

/**
 * Persistence for escrows and the merchant-held preimages. Two backends ship: an in-memory store
 * (tests / mock demos) and a JSON file store. Preimages live here, which is why MVP custody is
 * centralized; this is disclosed in the README and decentralized custody is roadmap.
 */
export interface EscrowStore {
  get(id: Hash256): Promise<Escrow | undefined>;
  put(escrow: Escrow): Promise<void>;
  list(): Promise<Escrow[]>;
  getPreimage(paymentHash: Hash256): Promise<Hash256 | undefined>;
  putPreimage(paymentHash: Hash256, preimage: Hash256): Promise<void>;
}

export class MemoryStore implements EscrowStore {
  private escrows = new Map<string, Escrow>();
  private preimages = new Map<string, string>();

  async get(id: Hash256) { return this.escrows.get(id.toLowerCase()); }
  async put(e: Escrow) { this.escrows.set(e.id.toLowerCase(), e); }
  async list() { return [...this.escrows.values()]; }
  async getPreimage(h: Hash256) { return this.preimages.get(h.toLowerCase()) as Hash256 | undefined; }
  async putPreimage(h: Hash256, p: Hash256) { this.preimages.set(h.toLowerCase(), p); }
}

interface JsonShape {
  escrows: Record<string, Escrow>;
  preimages: Record<string, string>;
}

export class JsonFileStore implements EscrowStore {
  constructor(private readonly path: string) {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      this.write({ escrows: {}, preimages: {} });
    }
  }

  private read(): JsonShape {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as JsonShape;
    } catch {
      return { escrows: {}, preimages: {} };
    }
  }
  private write(data: JsonShape) {
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  async get(id: Hash256) { return this.read().escrows[id.toLowerCase()]; }
  async put(e: Escrow) {
    const d = this.read();
    d.escrows[e.id.toLowerCase()] = e;
    this.write(d);
  }
  async list() { return Object.values(this.read().escrows); }
  async getPreimage(h: Hash256) { return this.read().preimages[h.toLowerCase()] as Hash256 | undefined; }
  async putPreimage(h: Hash256, p: Hash256) {
    const d = this.read();
    d.preimages[h.toLowerCase()] = p;
    this.write(d);
  }
}
