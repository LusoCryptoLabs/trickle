// Provider side: release service in proportion to settled inbound value. fnn v0.8.1 gives the
// receiver no RPC view of an incoming keysend or its custom_records (get_payment is sender-only), so
// the signal is the provider's own settled inbound balance: release a unit of
// service for every `pricePerUnit` shannons that have landed. The payer's session enforces the cap;
// the provider never extends credit beyond one tick.
export interface MeterOptions {
  /** shannons (or token base units) per unit of service. */
  pricePerUnit: string | bigint;
  /** returns the provider's cumulative settled inbound for this session (e.g. channel local_balance). */
  balanceReader: () => Promise<bigint>;
}

export class SessionMeter {
  private base: bigint | null = null;

  constructor(private readonly opts: MeterOptions) {}

  /** Snapshot the baseline before the stream starts. */
  async start(): Promise<this> {
    this.base = await this.opts.balanceReader();
    return this;
  }

  /** Value received since start. */
  async receivedShannons(): Promise<bigint> {
    const cur = await this.opts.balanceReader();
    return cur - (this.base ?? cur);
  }

  /** Service units the provider may release given what has actually settled. */
  async releasedUnits(): Promise<number> {
    const recv = await this.receivedShannons();
    const price = BigInt(this.opts.pricePerUnit);
    return price > 0n ? Number(recv / price) : 0;
  }
}
