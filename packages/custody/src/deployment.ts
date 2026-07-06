// Live Pudge deployment of the custody lock (v5: WebAuthn + P-256 M-of-N), ported from ckb-smart-account.
export interface DepRef {
  txHash: string;
  index: number;
  depType: "code" | "depGroup";
}

export interface CustodyDeployment {
  network: string;
  lockVersion: string;
  lock: { codeHash: string; hashType: "type" | "data" | "data1"; dep: DepRef };
  authLibecc: { dataHash: string; hashType: "data1"; dep: DepRef };
  secpDep: DepRef;
}

/** The deployed M-of-N / WebAuthn custody lock on Pudge testnet. */
export const PUDGE_CUSTODY: CustodyDeployment = {
  network: "testnet",
  lockVersion: "v5-webauthn-uv",
  lock: {
    codeHash: "0x0dc8c2151bea1694af93dc241b6b6597b558bfa36cc624a4a7212f8e993da30e",
    hashType: "type",
    dep: { txHash: "0x81049b5f1289a1c55293c4ba0d15d7b4f6f7052577d4058a7083c0b7dacb6547", index: 0, depType: "code" },
  },
  authLibecc: {
    dataHash: "0x6f3863542799acc1aa858f51ceaa9019e916adc4920f6658d01fce29ce854454",
    hashType: "data1",
    dep: { txHash: "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586", index: 1, depType: "code" },
  },
  secpDep: { txHash: "0x98df7ead4a08964a086d07fe04ee93a2fb91670616e1b42ae9f405db358d3586", index: 2, depType: "code" },
};
