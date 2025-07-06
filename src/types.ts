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
export type UnrealInteger = number;
export type UnrealInteger64 = number;
export type UnrealColor = [number, number, number, number];
export type UnrealByte = number;
export type UnrealRotator = [number, number, number];
export type UnrealString = string;
export type WireGraphVariant =
  | { number: number }
  | { integer: number }
  | { bool: boolean }
  | { exec: true }
  | { object: true };
export type UnrealType =
  | UnrealClass
  | UnrealObject
  | UnrealBoolean
  | UnrealFloat
  | UnrealColor
  | UnrealByte
  | UnrealRotator
  | UnrealString
  | WireGraphVariant
  | UnrealInteger64;

type UnrealTypeFromString<T> = T extends 'Class'
  ? UnrealClass
  : T extends 'Object'
  ? UnrealObject
  : T extends 'Boolean'
  ? UnrealBoolean
  : T extends 'Float'
  ? UnrealFloat
  : T extends 'Color'
  ? UnrealColor
  : T extends 'Byte'
  ? UnrealByte
  : T extends 'Rotator'
  ? UnrealRotator
  : T extends 'String'
  ? UnrealString
  : T extends 'WireGraphVariant'
  ? WireGraphVariant
  : T extends 'WireGraphPrimMathVariant'
  ? WireGraphVariant
  : T extends 'Integer'
  ? UnrealInteger
  : T extends 'Integer64'
  ? UnrealInteger64
  : UnrealType;

export interface User {
  id: Uuid;
  name: string;
}

export interface LegacyOwner extends User {
  bricks: number;
}

export interface Owner extends LegacyOwner {
  display_name: string;
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
  physics: boolean;
}

export interface AppliedComponent {
  [property: string]: UnrealType;
}

export interface UnknownComponents {
  [component_name: string]: {
    version: number;
    brick_indices?: number[];
    properties: { [property: string]: string };
  };
}

export type KnownComponents = {
  BCD_SpotLight: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Rotation: 'Rotator';
      InnerConeAngle: 'Float';
      OuterConeAngle: 'Float';
      Brightness: 'Float';
      Radius: 'Float';
      Color: 'Color';
      bUseBrickColor: 'Boolean';
      bCastShadows: 'Boolean';
    };
  };
  BCD_PointLight: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bMatchBrickShape: 'Boolean';
      Brightness: 'Float';
      Radius: 'Float';
      Color: 'Color';
      bUseBrickColor: 'Boolean';
      bCastShadows: 'Boolean';
    };
  };
  BCD_ItemSpawn: {
    version: 1;
    brick_indices?: number[];
    properties: {
      PickupClass: 'Class';
      bPickupEnabled: 'Boolean';
      bPickupRespawnOnMinigameReset: 'Boolean';
      PickupMinigameResetRespawnDelay: 'Float';
      bPickupAutoDisableOnPickup: 'Boolean';
      PickupRespawnTime: 'Float';
      PickupOffsetDirection: 'Byte';
      PickupOffsetDistance: 'Float';
      PickupRotation: 'Rotator';
      PickupScale: 'Float';
      bPickupAnimationEnabled: 'Boolean';
      PickupAnimationAxis: 'Byte';
      bPickupAnimationAxisLocal: 'Boolean';
      PickupSpinSpeed: 'Float';
      PickupBobSpeed: 'Float';
      PickupBobHeight: 'Float';
      PickupAnimationPhase: 'Float';
    };
  };
  BCD_Interact: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bPlayInteractSound: 'Boolean';
      Message: 'String';
      ConsoleTag: 'String';
    };
  };
  BCD_AudioEmitter: {
    version: 1;
    brick_indices?: number[];
    properties: {
      AudioDescriptor: 'Object';
      VolumeMultiplier: 'Float';
      PitchMultiplier: 'Float';
      InnerRadius: 'Float';
      MaxDistance: 'Float';
      bSpatialization: 'Boolean';
    };
  };
};

export interface DefinedComponents
  extends UnknownComponents,
    Partial<KnownComponents> {}

export type Components<C extends DefinedComponents> = {
  [T in keyof C]: {
    [V in keyof C[T]['properties']]: UnrealTypeFromString<
      C[T]['properties'][V]
    >;
  };
} & { [component_name: string]: AppliedComponent };

export type Vector = [number, number, number];

export type WirePort = {
  brick_index: number;
  component: string;
  port: string;
};

export type Wire = {
  source: WirePort;
  target: WirePort;
};

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
  components: Components<DefinedComponents>;
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
    brick_owners: LegacyOwner[];
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

export type BrsV14 = Modify<
  BrsV10,
  {
    version: 14;
    wires: Wire[];
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
  | BrsV10
  | BrsV14;

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
  color?: ColorRgb | number | UnrealColor | number[];
  owner_index?: number;
  components?: Components<DefinedComponents>;
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
  wires?: Wire[];
}

export interface ReadOptions {
  bricks?: boolean;
  preview?: boolean;
}

export interface WriteOptions {
  compress?: boolean;
}
