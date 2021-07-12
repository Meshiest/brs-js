export interface BRSBytes extends Uint8Array {
    brsOffset: number;
}
declare type Modify<T, R> = Omit<T, keyof R> & R;
export declare type Bytes = Uint8Array | BRSBytes;
export declare type Uuid = string;
export declare type UnrealClass = string;
export declare type UnrealObject = string;
export declare type UnrealBoolean = boolean;
export declare type UnrealFloat = number;
export declare type UnrealColor = [number, number, number, number];
export declare type UnrealByte = number;
export declare type UnrealRotator = [number, number, number];
export declare type UnrealType = UnrealClass | UnrealObject | UnrealBoolean | UnrealFloat | UnrealColor | UnrealByte | UnrealRotator;
export interface User {
    id: Uuid;
    name: string;
}
export interface Owner extends User {
    bricks: number;
}
export declare enum Direction {
    XPositive = 0,
    XNegative = 1,
    YPositive = 2,
    YNegative = 3,
    ZPositive = 4,
    ZNegative = 5
}
export declare enum Rotation {
    Deg0 = 0,
    Deg90 = 1,
    Deg180 = 2,
    Deg270 = 3
}
export declare type ColorRgb = [number, number, number];
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
        properties: {
            [property: string]: string;
        };
    };
}
export interface Components {
    [component_name: string]: AppliedComponent;
}
export declare type Vector = [number, number, number];
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
export declare type BrickV9 = Modify<BrickV8, {
    physical_index: number;
    material_intensity: number;
    color: ColorRgb | number;
}>;
export declare type BrickV10 = Modify<BrickV9, {
    collision: Collision;
}>;
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
export declare type BrsV2 = Modify<BrsV1, {
    version: 2;
    materials: string[];
    bricks: BrickV2[];
}>;
export declare type BrsV3 = Modify<BrsV2, {
    version: 3;
    brick_owners: User[];
    bricks: BrickV3[];
}>;
export declare type BrsV4 = Modify<BrsV3, {
    version: 4;
    save_time: Uint8Array;
}>;
export declare type BrsV8 = Modify<BrsV4, {
    version: 8;
    host: User;
    brick_owners: Owner[];
    preview?: Bytes;
    game_version: number;
    bricks: BrickV8[];
    components: DefinedComponents;
}>;
export declare type BrsV9 = Modify<BrsV8, {
    version: 9;
    physical_materials: string[];
    bricks: BrickV9[];
}>;
export declare type BrsV10 = Modify<BrsV9, {
    version: 10;
    bricks: BrickV10[];
}>;
export declare type ReadSaveObject = BrsV1 | BrsV2 | BrsV3 | BrsV4 | BrsV8 | BrsV9 | BrsV10;
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
export {};
