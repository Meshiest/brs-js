import { describe, expect, it } from 'vitest';
import { BrdbValue, embeddedSchema } from '../../src/brdb/schema';

// Non-empty WireGraphMapVariant round-trip + byte-layout lock.
//
// brs-js serializes maps through the generic schema engine (BrdbSchema's
// `map` property kind), so a populated `WireGraphMapVariant` needs no
// hand-written path the way the Rust brdb crate's `write_map_values` does,
// but that means it can silently break if a schema re-sync or an engine
// change regresses the map path. These tests lock in that:
//   * int64- and string-keyed maps round-trip read<->write with entries;
//   * every value kind the compiler bakes (int64/double/bool/string) works;
//   * the emitted bytes match the game / Rust `write_map_values` layout
//     (nested key-tag + value-tag + a msgpack map of entries);
//   * object-keyed maps are the game's empty-struct form (no entries).
describe('WireGraphMapVariant (non-empty maps)', () => {
  const schema = embeddedSchema('BRSavedComponentChunkSoA_max');

  const intKeyed = (valueVariant: string, entries: [number, BrdbValue][]) => ({
    $variant: 'WireGraphMapKeyWrapper_int64',
    value: {
      Map: {
        $variant: valueVariant,
        value: { Values: { $map: entries } },
      },
    },
  });

  const roundTrips = (v: BrdbValue) => {
    const bytes = schema.encode('WireGraphMapVariant', v);
    expect(schema.decode(bytes, 'WireGraphMapVariant')).toEqual(v);
    return bytes;
  };

  it('int64 -> int64 round-trips and matches the write_map_values byte layout', () => {
    const v = intKeyed('WireGraphMap_int64_int64', [[1, 10], [2, 20]]);
    const bytes = roundTrips(v);
    // ...uint(keyTag) + uint(valueTag) + fixmap(2) + [1=>10, 2=>20].
    // The Values-map tail is byte-identical to the Rust writer's.
    expect([...bytes].slice(-5)).toEqual([0x82, 0x01, 0x0a, 0x02, 0x14]);
  });

  it('int64 -> double round-trips', () => {
    roundTrips(intKeyed('WireGraphMap_int64_double', [[1, 0.5], [2, 1.25]]));
  });

  it('int64 -> bool round-trips', () => {
    roundTrips(intKeyed('WireGraphMap_int64_bool', [[1, true], [2, false]]));
  });

  it('int64 -> string round-trips', () => {
    roundTrips(
      intKeyed('WireGraphMap_int64_FWireGraphString', [[1, 'red'], [2, 'blue']])
    );
  });

  it('string -> int64 round-trips', () => {
    roundTrips({
      $variant: 'WireGraphMapKeyWrapper_FWireGraphString',
      value: {
        Map: {
          $variant: 'WireGraphMap_FWireGraphString_int64',
          value: { Values: { $map: [['red', 1], ['blue', 2]] } },
        },
      },
    });
  });

  it('empty int64 map round-trips (map_len 0 tail)', () => {
    const bytes = roundTrips(intKeyed('WireGraphMap_int64_int64', []));
    expect([...bytes].slice(-1)).toEqual([0x80]); // fixmap(0)
  });

  it('full Pseudo_MapVar component data round-trips', () => {
    const data = { Value: intKeyed('WireGraphMap_int64_int64', [[1, 10]]) };
    const bytes = schema.encode('BrickComponentData_WireGraphPseudo_MapVar', data);
    expect(
      schema.decode(bytes, 'BrickComponentData_WireGraphPseudo_MapVar')
    ).toEqual(data);
  });

  it('object-keyed map is the game empty-struct form (carries no entries)', () => {
    // WireGraphMap_FWeakObjectPtr_int64 is `{}` in the schema (no Values
    // field), so an object-keyed map serializes with no entry map at all.
    const v = {
      $variant: 'WireGraphMapKeyWrapper_FWeakObjectPtr',
      value: {
        Map: { $variant: 'WireGraphMap_FWeakObjectPtr_int64', value: {} },
      },
    };
    roundTrips(v);
  });
});
