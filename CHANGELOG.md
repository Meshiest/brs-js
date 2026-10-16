# Changelog

All notable changes to `brs-js` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 4.0.1 - 2026-10-15

### Added

- `handleStruct(ty)`, the struct a handle type is stored as.

### Fixed

- `brick_handle` and `component_handle` values are now read and written (as
  `BRSavedBrickRef` / `BRSavedComponentRef` objects), so saves with populated
  component arrays decode. Mirrors `brdb` 1.0.1. An `ArrayVar`'s `Value` is a
  plain `dynamic_array`, e.g. `{ $elementType: 'brick_handle', $array: [ref] }`;
  an array of arrays is a `component_handle` array of refs to other
  `ArrayVar`s. Refs are stored as given; write them relative to the array, as
  the game does.

## 4.0.0 - 2026-10-15

> **This release contains breaking changes to the `brdb` API** (`.brz` /
> `.brdb` worlds). The legacy `.brs` reader and writer are unchanged.

Brickadia's current game builds rewrote the wire and component system. Saves
written by those builds use a new schema container, a new wire value type and
renamed component types. This release targets those builds, mirroring
`brdb` 1.0.0:

- **brs-js now speaks only the current ("Latest") vocabulary.** `COMPONENTS`,
  the component tables, the brick catalog and the embedded schemas all
  describe current game builds.
- **EA3 saves are migrated on read.** EA3 is the format of retail EA3 builds
  and of every save written before the rewrite. `openLatest()` upgrades an
  EA3 world into a Latest world the same way the game does when it loads one,
  so your code only has to handle one format.
- **Writing EA3 worlds is no longer supported.** To write worlds for retail
  EA3 builds, keep using brs-js 3.8.

### Reading EA3 saves

`openLatest()` takes any `WorldReader` and returns a reader over the same
world in the Latest format. A Latest world is copied as is, so you can call
it on every world you open:

```js
import { readFileSync } from 'node:fs';
import { brdb } from 'brs-js';

const original = brdb.WorldReader.from(readFileSync('old.brz'));
const world = brdb.openLatest(original);
world.componentChunk(1, { x: 0, y: 0, z: 0 }); // current type names and data
```

What the migration changes:

- **Names:** component types and data structs get their current names (for
  example `BrickComponentType_WireGraph_Expr_LogicalAND` →
  `BrickComponentType_Expr_LogicalAND`, `WireGraphPseudo_Timer` →
  `Stopwatch`).
- **Gate bricks:** gate bricks are renamed to their current assets. Gates that
  became procedural (queues, custom events, function calls, …) become their
  `PB_Gate_*` brick at the largest size, which exposes every port.
- **Wire values:** EA3 wire arrays become `{ $elementType, $array }`, wire
  maps become `{ $keyType, $valueType, $map }`, and enums become
  `{ $enum, value }`.
- **Everything else** keeps its EA3 encoding, which every game build reads.

The result is identical to brdb's migration, and both were checked against
the game's own upgrade of an EA3 world containing every component. A few
things differ from the game on purpose, because the migration is lossless
where the game drops data on load. It keeps:

- wires to ports that no longer exist;
- components on bricks that no longer allow them;
- gate output values, which the game resets to their typed default;
- the bot `bColorsAreLinear` flag, which the game normalises.

Data with no place in the current format is dropped, as the game drops it:
data fields a step removes, and the data of component types the game no
longer has (their components are kept, without data).

Lower-level pieces, if you need them:

- `toLatest(reader)` returns the migrated world as a pending tree, ready for
  `writeBrzContainer`. `examples/migrateWorld.mjs` converts a save file this
  way.
- `needsMigration(reader)` tells you whether a world is in an older format,
  and `pendingSteps(reader)` lists the steps it needs.
- `migrateComponentType(name)` and `migrateBrickAsset(name)` map single
  older names.
- `migrateValue(value)` reshapes a single decoded older value.

Migrations are data. Each breaking game update is one step, listed in
`MIGRATION_STEPS` and generated from the brdb crate's `migrations.json`. A
step says how to recognise a save from before that update, and lists the
component types, bricks and data fields it renames, plus any value
conversions it needs. A world runs the first step that recognises it and
every step after it, so a save from several updates ago upgrades in one go.
Both libraries migrate from the same data.

The plain `WorldReader` still returns a save exactly as stored.

### Wire values

Latest wire values decode to `{ $variant, value }`. The members are `Bool`,
`i64`, `f64`, `LinearColor`, `Vector`, `Rotator`, `Quat`, `Str`,
`dynamic_enum`, `weak_object`, `BRSavedBrickRef`, `BRSavedComponentRef` and
`WireGraphExec`. Object references (`weak_object`) are always `null`.
`dynamic_array`, `dynamic_map` and `dynamic_enum` fields decode to
`{ $elementType, $array }`, `{ $keyType, $valueType, $map }` and
`{ $enum, value }`.

### Migrating from 3.8

Most `COMPONENTS` keys stayed the same, but their `NAME` is now the current
type name. Code that compares `NAME` with type names read from a save should
open the save with `openLatest()` first.

These `COMPONENTS` keys were renamed:

| Removed | Now |
|---|---|
| `CustomEvent`, `CustomEvent_Global` | `Event_Custom`, `Event_CustomGlobal` |
| `SendCustomEvent`, `SendCustomEvent_Global` | `Exec_SendCustomEvent`, `Exec_SendCustomEventGlobal` |
| `Exec_ChatCommand`, `Exec_WholeGridInteracted`, `Exec_WholeGridTargeted` | `Event_ChatCommand`, `Event_WholeGridInteracted`, `Event_WholeGridTargeted` |
| `Fake_Gamemode_<Name>Event` (10 gates) | `Event_Gamemode_<Name>` |
| `DeltaTime`, `FormatDate`, `GetUnixEpoch`, `ServerUptime` | `Expr_DeltaTime`, `Expr_FormatDate`, `Expr_GetUnixEpoch`, `Expr_ServerUptime` |
| `FindPlayer` | `Exec_FindPlayer` |
| `Timer` | `Stopwatch` |
| `Internal_AerodynamicSurface` | `AerodynamicSurfaceBase` |

The brick catalog also follows the current build, so gate bricks such as
`B_1x1_Gate_Pseudo_BufferTicks` are gone.

### Added

- Migration: `openLatest`, `toLatest`, `needsMigration`, `pendingSteps`,
  `migrateValue`, `migrateComponentType`, `migrateBrickAsset`,
  `MIGRATION_STEPS` and the `BrickMigration` / `MigrationStep` types.
- `SchemaFormat` (`'Auto' | 'EA3' | 'Latest'`), the `ConcreteSchemaFormat`
  type, and `WriteBrzOptions.schemaFormat` (for `World.toBrz`,
  `World.toPendingFs`, `writeBrzLegacy` and `Brdb.save`). `'Latest'` (the
  default) writes every schema in the map form; `'EA3'` throws.
- `BrdbSchema` members `sourceFormat`, `types`, `format()`, `isLatest()`,
  `setFormat()`, `withFormat()`, `needsLatestForm()`, `resolveFormat()` and
  `typeIndex()`. `toBinary(format?)` takes an optional format.
- Procedural gate bricks (`PB_Gate_*`, whose brick size selects which ports
  are on the brick): `PROCEDURAL_GATES`, `proceduralGateForComponent`,
  `smallestGateVariant` and the `ProceduralGate` / `GateVariant` types.
- Types for Latest values: `BrdbDynamicArray`, `BrdbDynamicMap`,
  `BrdbDynamicEnum` and `FlatLayout`.
- Plaintext schemas accept a `types { … }` block (`SchemaData.types`).
- Latest-only save data is written: the GlobalData
  `PrefabSpawnInstanceIndices` / `PrefabSpawnInstanceParentIndices` tables and
  the per-entity `PrefabSpawnInstanceIndices`.

### Changed

- Worlds are written with every schema in the map form, as the game writes
  them (`schemaFormat` defaults to `'Latest'`). Before, they used the array
  form wherever a schema allowed it. `'Auto'` still writes that way, but a
  world written so without components reads as an EA3 save to
  `needsMigration()`.
- Component tables, `componentTypes`, the brick catalog, brick sizes and the
  embedded schemas are regenerated from a current game build.
- Number decoding is more lenient. `f32` / `f64` fields accept any integer or
  float tag (a float 64 read into an `f32` is rounded), and unsigned fields
  accept signed tags that carry a non-negative value.

### Fixed

- The `legacyRoundTrip` and `readWorld` examples handle EA3 saves and prefab
  bundles.
- Dynamic grid entities written with unset fields got zero mass, no gravity
  and no visibility. Unset `BrickGridDynamicActor` fields now take the game's
  defaults (`MassScale: 1`, `BouyancyScale: 0.2`, `bEnableGravity`,
  `bUseNewMassCalculation`, `bReceivesDecals`, `bVisible`).

### Known gaps

- The `Bool` and `Str` wire value members are assumed to encode like `bool`
  and `str`; no saved instance has been seen yet.
- `brick_handle` and `component_handle` values have no known encoding.
  Reading or writing one throws.

## Earlier releases

Releases up to 3.8.0 were not tracked in a changelog; see `git log`.
