import { describe, expect, test } from 'vitest';
import {
  BASIC_BRICK_ASSETS,
  isProceduralAsset,
  PROCEDURAL_BRICK_ASSETS,
} from '../../src/brdb/catalog';
import { guidToUuid, PUBLIC_GUID, uuidToGuid } from '../../src/brdb/guid';

describe('guid <-> uuid (big-endian u32 quarters)', () => {
  test('PUBLIC sentinel', () => {
    expect(guidToUuid(PUBLIC_GUID)).toBe(
      'ffffffff-ffff-ffff-ffff-ffffffffffff'
    );
    expect(uuidToGuid('ffffffff-ffff-ffff-ffff-ffffffffffff')).toEqual(
      PUBLIC_GUID
    );
  });

  test('quarters split the uuid hex big-endian', () => {
    expect(uuidToGuid('a1b2c3d4-e5f6-4789-8abc-def012345678')).toEqual({
      A: 0xa1b2c3d4,
      B: 0xe5f64789,
      C: 0x8abcdef0,
      D: 0x12345678,
    });
    expect(
      guidToUuid({ A: 0xa1b2c3d4, B: 0xe5f64789, C: 0x8abcdef0, D: 0x12345678 })
    ).toBe('a1b2c3d4-e5f6-4789-8abc-def012345678');
  });

  test('zero uuid', () => {
    expect(uuidToGuid('00000000-0000-0000-0000-000000000000')).toEqual({
      A: 0,
      B: 0,
      C: 0,
      D: 0,
    });
  });
});

describe('brick asset catalog', () => {
  test('generated lists are populated', () => {
    expect(BASIC_BRICK_ASSETS.length).toBeGreaterThan(100); // 151 @ crate v0.5.0
    expect(PROCEDURAL_BRICK_ASSETS.length).toBeGreaterThan(30); // 38 @ crate v0.5.0
    expect(PROCEDURAL_BRICK_ASSETS).toContain('PB_DefaultBrick');
    expect(PROCEDURAL_BRICK_ASSETS).toContain('PB_DefaultTile');
    expect(BASIC_BRICK_ASSETS).toContain('B_2x2_Overhang');
    expect(BASIC_BRICK_ASSETS).toContain('B_1x1_Microchip');
  });

  test('classification: catalog first, prefix fallback second', () => {
    expect(isProceduralAsset('PB_DefaultBrick')).toBe(true);
    expect(isProceduralAsset('B_2x2_Overhang')).toBe(false);
    // unknown assets fall back to the PB_/BP_ prefix rule
    expect(isProceduralAsset('PB_SomeFutureBrick')).toBe(true);
    expect(isProceduralAsset('BP_SomeFutureBrick')).toBe(true);
    expect(isProceduralAsset('B_SomeFutureBrick')).toBe(false);
    expect(isProceduralAsset('WeirdAsset')).toBe(false);
  });
});
