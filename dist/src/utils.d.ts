import { BRSBytes, Bytes, UnrealFloat, UnrealType, Uuid } from './types';
export declare const bgra: ([b, g, r, a]: number[]) => [
    number,
    number,
    number,
    number
];
export declare function isEqual<T>(arrA: Array<T>, arrB: Array<T>): boolean;
export declare function subarray(data: Bytes, len: number, isCopy?: boolean): BRSBytes;
export declare function chunk(arr: Bytes, size: number): BRSBytes[];
declare function read_u16(data: Bytes, littleEndian?: boolean): number;
declare function write_u16(num: number, littleEndian?: boolean): Uint8Array;
declare function read_i32(data: Bytes, littleEndian?: boolean): number;
declare function write_i32(num: number, littleEndian?: boolean): Uint8Array;
declare function read_compressed(data: Bytes): Bytes;
declare function write_uncompressed(...args: Uint8Array[]): Uint8Array;
declare function write_compressed(...args: Uint8Array[]): Uint8Array;
declare function read_string(data: Bytes): string;
declare function write_string(str: string): Uint8Array;
declare function read_uuid(data: Bytes): string;
declare function write_uuid(uuid: Uuid): Uint8Array;
declare function read_array<T>(data: Bytes, fn: (_: Bytes) => T): T[];
declare function read_each(data: Bytes, fn: (_: Bytes) => void): void;
declare function write_array<T>(arr: T[], fn: (_: T) => Uint8Array): Uint8Array;
declare class BitReader {
    buffer: Uint8Array;
    pos: number;
    constructor(data: Uint8Array);
    empty(): boolean;
    bit(): boolean;
    align(): void;
    int(max: number): number;
    uint_packed(): number;
    int_packed(): number;
    bits(num: number): number[];
    bytes(num: number): Uint8Array;
    bytesArr(num: number): number[];
    array<T>(fn: (_: BitReader) => T): T[];
    each(fn: (data: BitReader) => void): void;
    string(): string;
    float(): number;
    unreal(type: string): UnrealType;
}
declare class BitWriter {
    buffer: number[];
    cur: number;
    bitNum: number;
    bit(val: boolean): void;
    bits(src: number[] | Uint8Array, len: number): void;
    bytes(src: number[] | Uint8Array): void;
    align(): void;
    int(value: number, max: number): void;
    uint_packed(value: number): void;
    int_packed(value: number): void;
    finish(): Uint8Array;
    finishSection(): Uint8Array;
    string(str: string): void;
    float(num: UnrealFloat): void;
    self(fn: (this: BitWriter) => void): this;
    array<T>(arr: T[], fn: (this: BitWriter, item: T, index: number) => void): this;
    each<T>(arr: T[], fn: (this: BitWriter, item: T, index: number) => void): this;
    unreal(type: string, value: UnrealType): void;
}
export declare function concat(...arrays: Uint8Array[]): Uint8Array;
export declare const read: {
    bytes: typeof subarray;
    u16: typeof read_u16;
    i32: typeof read_i32;
    compressed: typeof read_compressed;
    string: typeof read_string;
    uuid: typeof read_uuid;
    array: typeof read_array;
    each: typeof read_each;
    bits: (data: Bytes) => BitReader;
};
export declare const write: {
    u16: typeof write_u16;
    i32: typeof write_i32;
    compressed: typeof write_compressed;
    uncompressed: typeof write_uncompressed;
    string: typeof write_string;
    uuid: typeof write_uuid;
    array: typeof write_array;
    bits: () => BitWriter;
};
export {};
