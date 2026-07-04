// brdb Guids are four u32s (A,B,C,D) = the uuid's u128 split into
// big-endian quarters. Flat-serialized as
// BRGuid { A,B,C,D: u32 } with each u32 little-endian on disk — the
// value walkers handle the LE part; this module only maps strings.
import { uuidParse, uuidStringify } from '../uuid';

export interface BrGuid {
  A: number;
  B: number;
  C: number;
  D: number;
}

/** Owner-table row 0 sentinel (the PUBLIC owner). */
export const PUBLIC_GUID: BrGuid = {
  A: 0xffffffff,
  B: 0xffffffff,
  C: 0xffffffff,
  D: 0xffffffff,
};

export function uuidToGuid(uuid: string): BrGuid {
  const bytes = uuidParse(uuid);
  const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
  return {
    A: view.getUint32(0, false),
    B: view.getUint32(4, false),
    C: view.getUint32(8, false),
    D: view.getUint32(12, false),
  };
}

export function guidToUuid(guid: BrGuid): string {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, guid.A, false);
  view.setUint32(4, guid.B, false);
  view.setUint32(8, guid.C, false);
  view.setUint32(12, guid.D, false);
  return uuidStringify(Array.from(bytes));
}
