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
export type Vector3d = Vector;
export type IntVector = Vector;
export type UnrealString = string;
export type WireGraphVariant =
  | { number: number }
  | { integer: number }
  | { bool: boolean }
  | { exec: true }
  | { object: true };
export type BRInventoryEntryPlan = string;
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
  | UnrealInteger64
  | Vector3d
  | IntVector
  | BRInventoryEntryPlan;

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
  : T extends 'Rotator3d'
  ? UnrealRotator
  : T extends 'Vector3d'
  ? Vector3d
  : T extends 'IntVector'
  ? IntVector
  : T extends 'String'
  ? UnrealString
  : T extends 'BRInventoryEntryPlan'
  ? BRInventoryEntryPlan
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
  Component_AudioEmitter: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      AudioDescriptor: 'Object';
      VolumeMultiplier: 'Float';
      PitchMultiplier: 'Float';
      InnerRadius: 'Float';
      MaxDistance: 'Float';
      bSpatialization: 'Boolean';
      FocusAzimuth: 'Float';
      NonFocusAzimuth: 'Float';
      NonFocusVolumeAttenuation: 'Float';
    };
  };
  Component_BotSpawn: {
    version: 1;
    brick_indices?: number[];
    properties: {
      RespawnTime: 'Float';
      CorpseTimeout: 'Float';
      GunSkill: 'Float';
      Agression: 'Float';
      ReactionTime: 'Float';
      MovementRandomness: 'Float';
      Jumpyness: 'Float';
      MovementAmount: 'Float';
      AttackMovementAmount: 'Float';
      AggroRange: 'Float';
      bCanJump: 'Boolean';
      bBackVision: 'Boolean';
      bVisionRaycasting: 'Boolean';
      bCanTargetPlayers: 'Boolean';
      bCanTargetBots: 'Boolean';
      MoveTarget: 'Vector3d';
      BotWeapon: 'Class';
    };
  };
  Component_CheckPoint: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bRotatePlayerGravityOnSpawn: 'Boolean';
    };
  };
  Component_Damage: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Message: 'String';
      ConsoleTag: 'String';
    };
  };
  Component_GoalPoint: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  Component_InputSplitter: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  Component_OneShotAudioEmitter: {
    version: 1;
    brick_indices?: number[];
    properties: {
      AudioDescriptor: 'Object';
      VolumeMultiplier: 'Float';
      PitchMultiplier: 'Float';
      InnerRadius: 'Float';
      MaxDistance: 'Float';
      bSpatialization: 'Boolean';
      bEnableRepeat: 'Boolean';
      RepeatTime: 'Float';
      RepeatVariance: 'Float';
    };
  };
  Component_SpawnPoint: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bRotatePlayerGravityOnSpawn: 'Boolean';
      bEnable: 'Boolean';
    };
  };
  Component_Target: {
    version: 1;
    brick_indices?: number[];
    properties: {
      OnTime: 'Float';
    };
  };
  Component_Internal_AnimatedButton: {
    version: 1;
    brick_indices?: number[];
    properties: {
      PressSound: 'Object';
      ReleaseSound: 'Object';
      bAllowNearbyInteraction: 'Boolean';
      bHiddenInteraction: 'Boolean';
      PromptCustomLabel: 'String';
    };
  };
  Component_Internal_AnimatedSwitch: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      InteractSound: 'Object';
      bAllowNearbyInteraction: 'Boolean';
      bHiddenInteraction: 'Boolean';
      PromptCustomLabel: 'String';
    };
  };
  Component_Internal_AttachedZone: {
    version: 1;
    brick_indices?: number[];
    properties: {
      ZoneStartDistance: 'Integer';
      ZoneEndDistance: 'Integer';
      bIsBuildingZone: 'Boolean';
      bIsLooseZone: 'Boolean';
      bIsShareZone: 'Boolean';
    };
  };
  Component_Internal_Bearing: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bLimitAngle: 'Boolean';
      LimitAngle: 'Float';
      Damping: 'Float';
    };
  };
  Component_Internal_Joint_Wheel: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      DriveSpeed: 'Float';
      DrivePower: 'Float';
      bSteerEnabled: 'Boolean';
      Steer: 'Float';
      SteerLimitDegree: 'Float';
      SteerPower: 'Float';
      bSuspensionEnabled: 'Boolean';
      SuspensionStiffness: 'Float';
      SuspensionDamping: 'Float';
      JointDistance: 'Integer';
      bDriveWhenNotAttachedToEngine: 'Boolean';
      bCanBrake: 'Boolean';
      bAllowEngineSteerCorrect: 'Boolean';
      Damping: 'Float';
    };
  };
  Component_Internal_Motor: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      Speed: 'Float';
      Power: 'Float';
      bLimitAngle: 'Boolean';
      LimitAngle: 'Float';
      Damping: 'Float';
    };
  };
  Component_Internal_MotorSlider: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      Speed: 'Float';
      Power: 'Float';
      bPositionsArePercentages: 'Boolean';
      Damping: 'Float';
    };
  };
  Component_Internal_Rerouter: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  Component_Internal_Seat: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bIsOccupied: 'Boolean';
      ExitOffset: 'IntVector';
      bAllowNearbyInteraction: 'Boolean';
      bHiddenInteraction: 'Boolean';
      PromptCustomLabel: 'String';
    };
  };
  Component_Internal_Servo: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      TargetAngle: 'Float';
      Power: 'Float';
      ActiveDamping: 'Float';
      ForceLimit: 'Float';
      bLimitAngle: 'Boolean';
      LimitAngle: 'Float';
      Damping: 'Float';
    };
  };
  Component_Internal_ServoSlider: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      TargetPosition: 'Float';
      Power: 'Float';
      TopSpeed: 'Float';
      Exponent: 'Float';
      bPositionsArePercentages: 'Boolean';
      Damping: 'Float';
    };
  };
  Component_Internal_Slider: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bPositionsArePercentages: 'Boolean';
      Damping: 'Float';
    };
  };
  Component_Internal_Socket: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  Component_Internal_WeightBrick: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Mass: 'Float';
      MassSize: 'IntVector';
      MassOffset: 'IntVector';
    };
  };
  Component_Internal_WheelEngine: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bEnabled: 'Boolean';
      bEnableManualControl: 'Boolean';
      ManualInput_Drive: 'Float';
      ManualInput_Steer: 'Float';
      bManualInput_Brake: 'Boolean';
      CustomMass: 'Float';
      CustomMassVerticalOffset: 'Float';
      DriveInterpSpeed: 'Float';
      DriveSpeed: 'Float';
      DriveAcceleratingPowerMultiplier: 'Float';
      DriveBrakingPowerMultiplier: 'Float';
      DriveDampingMultiplier: 'Float';
      SteerPowerMultiplier: 'Float';
      SteerInterpSpeed: 'Float';
      SteerLimitDegree: 'Float';
      CenterOfSteering: 'Float';
      bTankSteering: 'Boolean';
      TankSteerSpeedMultiplier: 'Float';
      WaterDriveForce: 'Float';
      WaterSteeringForce: 'Float';
      AudioDescriptor: 'Object';
    };
  };
  Component_WireGraph_PlayAudioAt: {
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
  Component_WireGraph_SetInventoryEntry: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Slot: 'Integer';
      EntryPlan: 'BRInventoryEntryPlan';
    };
  };
  BrickComponentType_Internal_CharacterZoneEvent_Entered: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_Internal_CharacterZoneEvent_Left: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_Internal_ReadBrickGrid: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_Internal_TeleportDestination: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_Internal_ZoneEvent_BrickChanged: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_Internal_ZoneEvent_BrickRemoved: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_WireGraphPseudo_BufferSeconds: {
    version: 1;
    brick_indices?: number[];
    properties: {
      SecondsToWait: 'Float';
      ZeroSecondsToWait: 'Float';
      CurrentTime: 'Float';
      Input: 'WireGraphVariant';
      Output: 'WireGraphVariant';
      Buffered: 'WireGraphVariant';
      Queued: 'WireGraphVariant';
      bHasQueued: 'Boolean';
    };
  };
  BrickComponentType_WireGraphPseudo_BufferTicks: {
    version: 1;
    brick_indices?: number[];
    properties: {
      TicksToWait: 'Integer';
      ZeroTicksToWait: 'Integer';
      CurrentTicks: 'Integer';
      Input: 'WireGraphVariant';
      Output: 'WireGraphVariant';
      Buffered: 'WireGraphVariant';
      Queued: 'WireGraphVariant';
      bHasQueued: 'Boolean';
    };
  };
  BrickComponentType_WireGraphPseudo_Var: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Value: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Exec_Branch: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_WireGraph_Exec_Character_SetTempPermission: {
    version: 1;
    brick_indices?: number[];
    properties: {
      PermissionTagStr: 'String';
      bPermissionEnable: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Exec_Character_ShowHint: {
    version: 1;
    brick_indices?: number[];
    properties: {
      HintTitle: 'String';
      HintText: 'String';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_AddLocationRotation: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Vector: 'Vector3d';
      Rotation: 'Rotator3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_AddVelocity: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Vector: 'Vector3d';
      Rotation: 'Vector3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_RelativeTeleport: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_WireGraph_Exec_Entity_SetGravityDirection: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Rotation: 'Rotator3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_SetLocation: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Vector: 'Vector3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_SetLocationRotation: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Vector: 'Vector3d';
      Rotation: 'Rotator3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_SetRotation: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Rotation: 'Rotator3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_SetVelocity: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Vector: 'Vector3d';
      Rotation: 'Vector3d';
    };
  };
  BrickComponentType_WireGraph_Exec_Entity_Teleport: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_WireGraph_Exec_Union: {
    version: 1;
    brick_indices?: number[];
    properties: {};
  };
  BrickComponentType_WireGraph_Exec_Var_Get: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Value: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Exec_Var_Increment: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Value: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Exec_Var_Set: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Value: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseAND: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseNAND: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseNOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseNOT: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Input: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseShiftLeft: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseShiftRight: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_BitwiseXOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'Integer64';
      InputB: 'Integer64';
    };
  };
  BrickComponentType_WireGraph_Expr_Ceil: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Input: 'Double';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareEqual: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphVariant';
      InputB: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareGreater: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareGreaterOrEqual: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareLess: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareLessOrEqual: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_CompareNotEqual: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphVariant';
      InputB: 'WireGraphVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_Floor: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Input: 'Double';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalAND: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInputA: 'Boolean';
      bInputB: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalNAND: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInputA: 'Boolean';
      bInputB: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalNOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInputA: 'Boolean';
      bInputB: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalNOT: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInput: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInputA: 'Boolean';
      bInputB: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_LogicalXOR: {
    version: 1;
    brick_indices?: number[];
    properties: {
      bInputA: 'Boolean';
      bInputB: 'Boolean';
    };
  };
  BrickComponentType_WireGraph_Expr_MathAdd: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathBlend: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Blend: 'Double';
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathDivide: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathModulo: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathModuloFloored: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathMultiply: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Expr_MathSubtract: {
    version: 1;
    brick_indices?: number[];
    properties: {
      InputA: 'WireGraphPrimMathVariant';
      InputB: 'WireGraphPrimMathVariant';
    };
  };
  BrickComponentType_WireGraph_Fake_Gamemode_RoundEndEvent: {
    version: 1;
    brick_indices?: number[];
    properties: {
      RoundNumber: 'Integer';
    };
  };
  BrickComponentType_WireGraph_Fake_Gamemode_RoundStartEvent: {
    version: 1;
    brick_indices?: number[];
    properties: {
      RoundNumber: 'Integer';
    };
  };
  BrickComponent_WireGraph_Expr_EdgeDetector: {
    version: 1;
    brick_indices?: number[];
    properties: {
      Input: 'Double';
      bPulseOnRisingEdge: 'Boolean';
      bPulseOnFallingEdge: 'Boolean';
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
