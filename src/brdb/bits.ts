// SoA bit-flag helpers. Boolean columns in chunk SoAs are packed as
// { Flags: byte[] } with bit i stored at byte i >> 3, bit position i & 7.
// Exposed so consumers can build their own SoA readers and writers.
import type { BrdbValue } from './schema';

/** Read bit i of a packed { Flags } column. Bytes past the end read as 0. */
export const bit = (flags: { Flags: number[] }, i: number): boolean =>
  (((flags.Flags[i >> 3] ?? 0) >> (i & 7)) & 1) === 1;

/** Accumulate booleans into a packed { Flags } column. */
export class BitFlags {
  bytes: number[] = [];
  private bits = 0;
  push(v: boolean) {
    if (this.bits >= this.bytes.length * 8) this.bytes.push(0);
    if (v) this.bytes[this.bits >> 3] |= 1 << (this.bits & 7);
    this.bits += 1;
  }
  toValue(): BrdbValue {
    return { Flags: this.bytes };
  }
}
