export interface BRSBytes extends Uint8Array {
  brsOffset: number;
}

type Modify<T, R> = Omit<T, keyof R> & R;

export type Bytes = Uint8Array | BRSBytes;
export type Uuid = string;

export type UnrealClass = string;
export type UnrealObject = string;
export type UnrealBoolean = boolean;
export type UnrealFloat = number;
export type UnrealColor = [number, number, number, number];
export type UnrealByte = number;
export type UnrealRotator = [number, number, number];
export type UnrealType =
  | UnrealClass
  | UnrealObject
  | UnrealBoolean
  | UnrealFloat
  | UnrealColor
  | UnrealByte
  | UnrealRotator;

export interface User {
  id: Uuid;
  name: string;
}

export interface Owner extends User {
  bricks: number;
}

export enum Direction {
  XPositive,
  XNegative,
  YPositive,
  YNegative,
  ZPositive,
  ZNegative,
}

export enum Rotation {
  Deg0,
  Deg90,
  Deg180,
  Deg270,
}

export type ColorRgb = [number, number, number];

export interface Collision {
  player: boolean;
  weapon: boolean;
  interaction: boolean;
  tool: boolean;
}

export interface AppliedComponent {
  [property: string]: UnrealType;
}

export interface DefinedComponents {
  [component_name: string]: {
    version: number;
    brick_indices: number[];
    properties: { [property: string]: string };
  };
}

export interface Components {
  [component_name: string]: AppliedComponent;
}

export type Vector = [number, number, number];

export interface BrickV1 {
  asset_name_index: number;
  size: Vector;
  position: Vector;
  direction: Direction;
  rotation: Rotation;
  collision: boolean;
  visibility: boolean;
  color: UnrealColor | number;
}

export interface BrickV2 extends BrickV1 {
  material_index: number;
}

export interface BrickV3 extends BrickV2 {
  owner_index: number;
}

export interface BrickV8 extends BrickV3 {
  components: Components;
}

export type BrickV9 = Modify<
  BrickV8,
  {
    physical_index: number;
    material_intensity: number;
    color: ColorRgb | number;
  }
>;

export type BrickV10 = Modify<
  BrickV9,
  {
    collision: Collision;
  }
>;

export interface BrsV1 {
  version: 1;
  map: string;
  author: User;
  description: string;
  brick_count: number;
  mods: string[];
  brick_assets: string[];
  colors: UnrealColor[];
  bricks: BrickV1[];
}

export type BrsV2 = Modify<
  BrsV1,
  {
    version: 2;
    materials: string[];
    bricks: BrickV2[];
  }
>;

export type BrsV3 = Modify<
  BrsV2,
  {
    version: 3;
    brick_owners: User[];
    bricks: BrickV3[];
  }
>;

export type BrsV4 = Modify<
  BrsV3,
  {
    version: 4;
    save_time: Uint8Array;
  }
>;

// not sure what part of 8 makes up 5-7 but nobody should have any saves in those versions

export type BrsV8 = Modify<
  BrsV4,
  {
    version: 8;
    host: User;
    brick_owners: Owner[];
    preview?: Bytes;
    game_version: number;
    bricks: BrickV8[];
    components: DefinedComponents;
  }
>;

export type BrsV9 = Modify<
  BrsV8,
  {
    version: 9;
    physical_materials: string[];
    bricks: BrickV9[];
  }
>;

export type BrsV10 = Modify<
  BrsV9,
  {
    version: 10;
    bricks: BrickV10[];
  }
>;

// a save read from a file
export type ReadSaveObject =
  | BrsV1
  | BrsV2
  | BrsV3
  | BrsV4
  | BrsV8
  | BrsV9
  | BrsV10;

// a brick a user provides
export interface Brick {
  asset_name_index?: number;
  size: Vector;
  position: Vector;
  direction?: Direction;
  rotation?: Rotation;
  collision?: boolean | Partial<Collision>;
  visibility?: boolean;
  material_index?: number;
  physical_index?: number;
  material_intensity?: number;
  color?: ColorRgb | number;
  owner_index?: number;
  components?: Components;
}

// save a user can write
export interface WriteSaveObject {
  game_version?: number;
  map?: string;
  description?: string;
  author?: Partial<User>;
  host?: Partial<User>;
  mods?: string[];
  brick_assets?: string[];
  colors?: UnrealColor[];
  materials?: string[];
  brick_owners?: Partial<Owner>[];
  physical_materials?: string[];
  preview?: Bytes;
  bricks: Brick[];
  save_time?: ArrayLike<number>;
  components?: DefinedComponents;
}

export interface ReadOptions {
  bricks?: boolean;
  preview?: boolean;
}

export interface WriteOptions {
  compress?: boolean;
}
