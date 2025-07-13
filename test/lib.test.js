const { read, write } = require('..');

// const uuid0 = '00000000-0000-0000-0000-000000000000';
const uuid0 = '12345678-4321-1234-4321-123456789012';
const save = {
  version: 14,
  map: 'Unknown',
  description: '',
  author: { id: uuid0, name: 'Test' },
  save_time: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  brick_count: 1,
  mods: [],
  preview: null,
  brick_assets: [],
  colors: [],
  components: {},
  game_version: 0,
  host: { id: uuid0, name: 'Test' },
  materials: ['BMC_Hologram', 'BMC_Plastic', 'BMC_Glow', 'BMC_Metallic'],
  physical_materials: ['BPMC_Default'],
  brick_owners: [{ id: uuid0, name: 'Test', bricks: 0, display_name: 'Test' }],
  bricks: [
    {
      asset_name_index: 1,
      size: [10, 10, 10],
      position: [0, 0, 0],
      components: {},
      direction: 4,
      owner_index: 1,
      rotation: 0,
      collision: {
        player: true,
        physics: true,
        interaction: true,
        tool: true,
        weapon: true,
      },
      visibility: true,
      material_index: 1,
      material_intensity: 5,
      physical_index: 0,
      color: [0, 0, 0],
    },
  ],
  wires: [],
};
test('creating a brs from thin air', () => {
  expect(read(write(save, { compress: false }))).toEqual(save);
});

test('reads no bricks when the option is passed in', () => {
  expect(read(write(save), { bricks: false })).toEqual({ ...save, bricks: [] });
});
