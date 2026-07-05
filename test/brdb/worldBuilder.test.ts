import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { Brdb } from '../../src/brdb/brdb';
import { BrzReader } from '../../src/brdb/brz';
import { COMPONENTS } from '../../src/brdb/componentDb';
import { WorldReader } from '../../src/brdb/reader';
import { World } from '../../src/brdb/world';

const hasFixtures = existsSync(new URL('../fixtures/brdb/', import.meta.url));
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../fixtures/brdb/${name}`, import.meta.url))
  );

const CHIP_IN = COMPONENTS.MicrochipInput.NAME;
const CHIP_OUT = COMPONENTS.MicrochipOutput.NAME;
const TARGET = COMPONENTS.Target;

describe('World builder', () => {
  test('microchip prefab: linked inner grid, cross-grid wires, prefab meta', () => {
    const w = new World();
    const { grid } = w.addMicrochip({ position: [0, 0, 2] });
    const input = w.addBrick(
      {
        asset: 'B_1x1_Gate_MicrochipInput',
        position: [0, 0, 2],
        components: [{ type: CHIP_IN, data: { PortLabel: 'In' } }],
      },
      grid
    );
    const output = w.addBrick(
      {
        asset: 'B_1x1_Gate_MicrochipOutput',
        position: [20, 0, 2],
        components: [{ type: CHIP_OUT, data: { PortLabel: 'Out' } }],
      },
      grid
    );
    w.addWire(
      { brick: input, component_type: CHIP_IN, port: 'RER_Output' },
      { brick: output, component_type: CHIP_OUT, port: 'RER_Input' }
    );
    // a main-grid component wired INTO the chip (remote source row)
    const sensor = w.addBrick({
      position: [20, 0, 6],
      components: [{ type: TARGET.NAME }],
    });
    w.addWire(
      {
        brick: sensor,
        component_type: TARGET.NAME,
        port: TARGET.PORTS.bJustHit,
      },
      { brick: input, component_type: CHIP_IN, port: 'RER_Input' }
    );
    w.makePrefab({ isMicrochipPrefab: true });
    const bytes = w.toBrz();

    const reader = WorldReader.from(bytes);
    expect(reader.gridIds()).toEqual([1, 2]);

    // the inner grid entity, linked from the shell brick's chunk
    const [entity] = [...reader.entities()];
    expect(entity.typeName).toBe('Entity_MicrochipDynamicBrickGrid');
    expect(entity.className).toBe('BP_MicrochipBrickGridDynamicActor_C');
    expect(entity.persistentIndex).toBe(2);
    expect(entity.location).toEqual({ X: 0, Y: 0, Z: 40 });
    expect(entity.data).toMatchObject({
      bCollapsed: true,
      PlaneCenter: { X: 0, Y: 0, Z: 0 },
      PlaneExtent: { X: 14, Y: 14, Z: 2 },
    });

    const { soa, components } = reader.componentChunk(1, { x: 0, y: 0, z: 0 });
    expect(components.map(c => c.typeName)).toEqual([
      'Component_Internal_Microchip',
      'Component_Target',
    ]);
    expect(soa.MicrochipBrickIndices).toEqual([0]);
    expect(soa.MicrochipBrickGridReferences).toEqual([2]);

    // chip contents are shifted to the chunk center on disk
    expect([...reader.bricks(2)].map(b => b.position)).toEqual([
      [-1024, -1024, -1022],
      [-1004, -1024, -1022],
    ]);

    // both wires land in the inner grid; the sensor wire is remote (grid 1)
    const wires = reader.wireChunk(2, { x: -1, y: -1, z: -1 });
    expect(wires.local).toEqual([
      {
        source: { brickIndex: 0, componentType: CHIP_IN, port: 'RER_Output' },
        target: { brickIndex: 1, componentType: CHIP_OUT, port: 'RER_Input' },
      },
    ]);
    expect(wires.remote).toEqual([
      {
        source: {
          gridId: 1,
          chunk: { x: 0, y: 0, z: 0 },
          brickIndex: 1,
          componentType: TARGET.NAME,
          port: TARGET.PORTS.bJustHit,
        },
        target: { brickIndex: 0, componentType: CHIP_IN, port: 'RER_Input' },
      },
    ]);

    // prefab meta replaces World.json
    const bz = BrzReader.from(bytes);
    expect(bz.listPaths()).toContain('Meta/Prefab.json');
    expect(bz.listPaths()).not.toContain('Meta/World.json');
    const utf8 = new TextDecoder();
    const bundle = JSON.parse(utf8.decode(bz.readFile('Meta/Bundle.json')));
    expect(bundle.type).toBe('Prefab');
    const prefab = JSON.parse(utf8.decode(bz.readFile('Meta/Prefab.json')));
    expect(prefab.bIsMicrochipPrefab).toBe(true);
    // main-grid bounds: shell (5,5,2 half) at [0,0,2] + sensor default
    // brick (5,5,6) at [20,0,6]
    expect(prefab.pivots.boundsPivot).toEqual({
      center: { x: 10, y: 0, z: 6 },
      halfExtent: { x: 15, y: 5, z: 6 },
    });
    expect(prefab.bIsPhysicsGrid).toBe(false);
  });

  test.skipIf(!hasFixtures)(
    'entities: World output matches the oracle fixture semantically',
    () => {
      // Mirror of the crate's entities_world() fixture: two main-grid
      // bricks plus a frozen dynamic sub-grid holding one brick.
      const w = new World();
      w.addBrick({ position: [0, 0, 6], color: [200, 50, 50] });
      w.addBrick({ position: [20, 0, 6], color: [50, 200, 50] });
      const grid = w.addBrickGrid({
        frozen: true,
        location: { X: 0, Y: 0, Z: 40 },
      });
      w.addBrick({ position: [0, 0, 3], color: [0, 255, 0] }, grid);

      const mine = WorldReader.from(w.toBrz());
      const oracle = WorldReader.from(fixture('entities_raw.brz'));
      expect(mine.gridIds()).toEqual(oracle.gridIds());
      expect(mine.entityChunkIndex()).toEqual(oracle.entityChunkIndex());
      expect([...mine.entities()]).toEqual([...oracle.entities()]);
      for (const g of [1, 2])
        expect([...mine.bricks(g)]).toEqual([...oracle.bricks(g)]);
    }
  );

  test('owner table counts entities; wires validate handles', () => {
    const w = new World();
    const owner = w.addOwner({ id: '6-0-0-0-0', name: 'cake' });
    w.addBrick({ position: [0, 0, 6], owner_index: owner });
    w.addEntity({ owner_index: owner, frozen: true });
    const reader = WorldReader.from(w.toBrz());
    expect(reader.owners().EntityCounts).toEqual([0, 1]);
    expect(reader.owners().BrickCounts).toEqual([0, 1]);
    const [entity] = [...reader.entities()];
    expect(entity.ownerIndex).toBe(1);
    expect(entity.frozen).toBe(true);

    const w2 = new World();
    const b = w2.addBrick({
      position: [0, 0, 6],
      components: [{ type: TARGET.NAME }],
    });
    w2.addWire(
      { brick: b, component_type: TARGET.NAME, port: TARGET.PORTS.bJustHit },
      {
        brick: { grid: 0, index: 5 },
        component_type: TARGET.NAME,
        port: TARGET.PORTS.bJustHit,
      }
    );
    expect(() => w2.toBrz()).toThrow(/brick_index 5 out of range/);
  });

  test('Brdb.save accepts a World instance', () => {
    const db = Brdb.init(new Database(':memory:'), 1000);
    const w = new World();
    const { grid } = w.addMicrochip({ position: [0, 0, 2] });
    w.addBrick({ position: [0, 0, 2] }, grid);
    db.save('world builder revision', w);
    const reader = db.worldReader();
    expect(reader.gridIds()).toEqual([1, 2]);
    expect([...reader.entities()].map(e => e.typeName)).toEqual([
      'Entity_MicrochipDynamicBrickGrid',
    ]);
    expect(db.revisions().map(r => r.description)).toEqual([
      'Initial Revision',
      'world builder revision',
    ]);
    db.close();
  });
});
