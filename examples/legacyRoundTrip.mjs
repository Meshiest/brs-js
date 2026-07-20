// Round-trip a world/clipboard .brz through legacy mode: read it, convert
// to the legacy .brs-shaped save (modern component/wire arrays attached),
// write it back with writeBrzLegacy, and verify the rewritten archive has
// identical content — every brick, every component with its data, every
// wire, and the external asset table. Content is compared decoded (see
// worldContent.mjs for why byte parity with game files is impossible).
// Legacy mode covers the main grid only; worlds with entities or sub-grids
// (vehicles, physics grids) need the World builder instead.
// Usage: node examples/legacyRoundTrip.mjs <world.brz> [out.brz]
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { lib, openWorld } from './openWorld.mjs';
import { canonicalWorld, gridBricks, summarize } from './worldContent.mjs';

const { WorldReader, writeBrzLegacy } = lib;
const { guidToUuid, MAIN_GRID, PUBLIC_GUID } = lib.brdb;

/** Convert a read world into the legacy save shape writeBrzLegacy accepts. */
function toLegacySave(reader) {
  const gridIds = reader.gridIds();
  if (gridIds.length > 1 || gridIds[0] !== MAIN_GRID)
    throw new Error(
      `legacy mode only carries the main grid; found grids ${gridIds}`
    );
  let numEntities = 0;
  try {
    for (const c of reader.entityChunkIndex().chunks)
      numEntities += c.numEntities;
  } catch {
    // no Entities/ChunkIndex.mps at all — nothing to lose
  }
  if (numEntities > 0)
    throw new Error(
      `legacy mode drops entities (${numEntities} present); use the World builder`
    );

  // Legacy owner_index semantics: 0 = PUBLIC, 1.. = brick_owners rows. A
  // brs-js-written archive has the PUBLIC row at 0 already; game clipboard
  // exports omit it, so every stored owner index shifts up by one.
  const owners = reader.owners();
  const g0 = owners.UserIds[0];
  const hasPublicRow =
    g0 &&
    g0.A === PUBLIC_GUID.A &&
    g0.B === PUBLIC_GUID.B &&
    g0.C === PUBLIC_GUID.C &&
    g0.D === PUBLIC_GUID.D;
  const firstOwnerRow = hasPublicRow ? 1 : 0;
  const ownerShift = hasPublicRow ? 0 : 1;
  const brick_owners = owners.UserNames.slice(firstOwnerRow).map((name, i) => ({
    id: guidToUuid(owners.UserIds[firstOwnerRow + i]),
    name,
    display_name: owners.DisplayNames[firstOwnerRow + i],
  }));

  const assets = reader.brickAssets();
  const { refs, bricks, base } = gridBricks(reader, MAIN_GRID);
  const legacyBricks = bricks.map(b => ({
    asset_name_index: b.asset_name_index,
    size: b.size,
    position: b.position,
    direction: b.direction,
    rotation: b.rotation,
    collision: b.collision,
    visibility: b.visibility,
    material_index: b.material_index,
    material_intensity: b.material_intensity,
    color: b.color,
    owner_index: b.owner_index + ownerShift,
    components: [],
  }));

  // Components and wires store chunk-local brick indices; resolve them to
  // save-level indices through each chunk's base offset.
  const chunkKey = index => `${index.x},${index.y},${index.z}`;
  const wires = [];
  for (const ref of refs) {
    const start = base.get(chunkKey(ref.index));
    if (ref.numComponents > 0)
      for (const c of reader.componentChunk(MAIN_GRID, ref.index).components)
        legacyBricks[start + c.brickIndex].components.push({
          type: c.typeName,
          data: c.data ?? undefined,
        });
    if (ref.numWires > 0) {
      const wc = reader.wireChunk(MAIN_GRID, ref.index);
      const endpoint = (chunkStart, end) => ({
        brick_index: chunkStart + end.brickIndex,
        component_type: end.componentType,
        port: end.port,
      });
      for (const w of wc.local)
        wires.push({
          source: endpoint(start, w.source),
          target: endpoint(start, w.target),
        });
      for (const w of wc.remote) {
        if (w.source.gridId !== MAIN_GRID)
          throw new Error('legacy mode cannot wire across grids');
        wires.push({
          source: endpoint(base.get(chunkKey(w.source.chunk)), w.source),
          target: endpoint(start, w.target),
        });
      }
    }
  }

  return {
    save: {
      brick_assets: assets,
      materials: reader.materials(),
      brick_owners,
      bricks: legacyBricks,
      wires,
    },
    // Component asset-reference fields (e.g. Component_Interact's
    // InteractSound) are indices into the externalAssets table; carry it
    // verbatim so they keep resolving in the rewritten archive. Prefab
    // bundles (clipboard exports) carry paste pivots and the grid offset
    // in Meta/Prefab.json — pass it through or the rewrite pastes wrong.
    options: {
      externalAssets: reader.externalAssets(),
      prefab: reader.prefabJson() ?? undefined,
      thumbnail: reader.thumbnail() ?? undefined,
      screenshot: reader.screenshot() ?? undefined,
    },
  };
}

const [, , input, output = 'example_roundtrip.brz'] = process.argv;
const { reader } = await openWorld(
  input,
  'node examples/legacyRoundTrip.mjs <world.brz> [out.brz]'
);

const { save, options } = toLegacySave(reader);
const bytes = writeBrzLegacy(save, options);
writeFileSync(output, bytes);
console.log(`${output} written (${bytes.length} bytes)`);

const original = canonicalWorld(reader);
const rewritten = canonicalWorld(WorldReader.from(bytes));
console.log(`original:  ${summarize(original)}`);
console.log(`rewritten: ${summarize(rewritten)}`);
assert.deepStrictEqual(rewritten, original); // throws with a diff on loss
console.log('round trip verified: content identical');
