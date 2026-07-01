import { Uuid } from './types';

export const MAGIC = new Uint8Array([66, 82, 83]); // BRS
export const LATEST_VERSION = 14;
export const MAX_INT = ~(1 << 31);
export const DEFAULT_UUID: Uuid = '00000000-0000-0000-0000-000000000000';
