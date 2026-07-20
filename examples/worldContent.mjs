// Shared example helper: reduce a world to an order-independent content
// model — resolved names instead of table indices — so two archives can be
// compared semantically with assert.deepStrictEqual. Byte comparison is a
// non-starter for game-written files (the game's newer msgpack encoder
// shrinks scalars and duplicates one component array; Meta timestamps
// churn every write), so content comparison is the meaningful check.
import { lib } from './openWorld.mjs';

const { guidToUuid, isProceduralAsset } = lib.brdb;

const chunkKey = index => `${index.x},${index.y},${index.z}`;
const posKey = p => p.join(',');

/** One grid's bricks in chunk-stream order, plus each chunk's base offset
 * into that list — component and wire rows store chunk-local brick
 * indices, and base + local resolves them to a brick. */
export function gridBricks(reader, gridId) {
  const refs = reader.brickChunkIndex(gridId);
  const bricks = [...reader.bricks(gridId)];
  const base = new Map();
  let offset = 0;
  for (const ref of refs) {
    base.set(chunkKey(ref.index), offset);
    offset += ref.numBricks;
  }
  return { refs, bricks, base };
}

/** Content model of a world: per grid, bricks (with their components) and
 * wires, all indices resolved to names/positions; plus the external asset
 * table that component asset-reference fields index into and the prefab
 * paste metadata. Entities and the remaining Meta JSON are out of scope
 * (legacy mode does not carry them). */
export function canonicalWorld(reader) {
  const assets = reader.brickAssets();
  const materials = reader.materials();
  const owners = reader.owners();
  const owner = i => ({
    id: guidToUuid(owners.UserIds[i]),
    name: owners.UserNames[i],
    display: owners.DisplayNames[i],
  });

  // First pass: every grid's bricks, components attached.
  const perGrid = new Map();
  for (const gridId of reader.gridIds()) {
    const { refs, bricks, base } = gridBricks(reader, gridId);
    const canon = bricks.map(b => {
      const asset = assets[b.asset_name_index];
      return {
        asset,
        size: isProceduralAsset(asset) ? [...b.size] : null,
        position: [...b.position],
        direction: b.direction,
        rotation: b.rotation,
        // collision.tool is not stored in brdb; compare the stored four
        collision: {
          player: b.collision.player,
          weapon: b.collision.weapon,
          interaction: b.collision.interaction,
          physics: b.collision.physics,
        },
        visibility: b.visibility,
        material: materials[b.material_index],
        intensity: b.material_intensity,
        color: [...b.color],
        owner: owner(b.owner_index),
        components: [],
      };
    });
    for (const ref of refs) {
      if (ref.numComponents === 0) continue;
      const start = base.get(chunkKey(ref.index));
      for (const c of reader.componentChunk(gridId, ref.index).components)
        canon[start + c.brickIndex].components.push({
          type: c.typeName,
          data: c.data,
        });
    }
    for (const brick of canon)
      brick.components.sort((a, b) => a.type.localeCompare(b.type));
    perGrid.set(gridId, { refs, base, canon });
  }

  // Second pass: wires. A wire lives in its target's chunk; remote sources
  // name another grid+chunk, so this needs every grid's base map.
  const endpointAt = (gridId, key, local, end) => {
    const g = perGrid.get(gridId);
    return {
      grid: gridId,
      brick: posKey(g.canon[g.base.get(key) + local].position),
      component: end.componentType,
      port: end.port,
    };
  };
  const wires = [];
  for (const [gridId, g] of perGrid) {
    for (const ref of g.refs) {
      if (ref.numWires === 0) continue;
      const key = chunkKey(ref.index);
      const wc = reader.wireChunk(gridId, ref.index);
      for (const w of wc.local)
        wires.push({
          source: endpointAt(gridId, key, w.source.brickIndex, w.source),
          target: endpointAt(gridId, key, w.target.brickIndex, w.target),
        });
      for (const w of wc.remote)
        wires.push({
          source: endpointAt(
            w.source.gridId,
            chunkKey(w.source.chunk),
            w.source.brickIndex,
            w.source
          ),
          target: endpointAt(gridId, key, w.target.brickIndex, w.target),
        });
    }
  }

  // Deterministic order: bricks by position, wires by their JSON form.
  const byPosition = (a, b) =>
    a.position[0] - b.position[0] ||
    a.position[1] - b.position[1] ||
    a.position[2] - b.position[2];
  const grids = {};
  for (const [gridId, g] of perGrid)
    grids[gridId] = [...g.canon].sort(byPosition);
  wires.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    externalAssets: reader.externalAssets(),
    // paste pivots + global grid offset for prefab bundles (null for
    // world bundles) — losing this breaks clipboard paste positioning
    prefab: reader.prefabJson(),
    grids,
    wires,
  };
}

/** Count bricks and components (per type) for a one-line summary. */
export function summarize(canon) {
  let bricks = 0;
  const componentCounts = {};
  for (const grid of Object.values(canon.grids))
    for (const b of grid) {
      bricks += 1;
      for (const c of b.components)
        componentCounts[c.type] = (componentCounts[c.type] ?? 0) + 1;
    }
  const components = Object.entries(componentCounts)
    .map(([type, n]) => `${type} x${n}`)
    .join(', ');
  return `${bricks} brick(s), ${Object.values(componentCounts).reduce(
    (a, b) => a + b,
    0
  )} component(s)${components ? ` (${components})` : ''}, ${
    canon.wires.length
  } wire(s), ${canon.externalAssets.length} external asset(s)${
    canon.prefab ? ', prefab metadata' : ''
  }`;
}
