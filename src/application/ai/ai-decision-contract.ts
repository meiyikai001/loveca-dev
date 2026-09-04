import type { Seat, ViewZoneKey, WindowStatus, PublicWindowType } from '../../online/types.js';
import type {
  BladeHeartEffect,
  CardType,
  HeartColor,
  OrientationState,
  SlotPosition,
} from '../../shared/types/enums.js';

export const AI_DECISION_SCHEMA_VERSION = 1 as const;
export const AI_DECISION_SCHEMA_VERSION_V2 = 2 as const;

export interface AiMatchObservation {
  readonly viewerSeat: Seat;
  readonly turnCount: number;
  readonly phase: string;
  readonly subPhase: string;
  readonly firstSeat: Seat;
  readonly activeSeat: Seat | null;
  readonly prioritySeat: Seat | null;
  readonly publicSequence: number;
  readonly window: {
    readonly windowType: PublicWindowType;
    readonly status: WindowStatus;
    readonly actingSeat?: Seat | null;
    readonly waitingSeats: readonly Seat[];
  } | null;
}

export interface AiZoneCountObservation {
  readonly zoneKey: ViewZoneKey;
  readonly zone: string;
  readonly ownerSeat?: Seat;
  readonly count: number;
}

export interface AiObservationV1 {
  readonly match: AiMatchObservation;
  /**
   * 只投影区域数量。牌库顺序、隐藏对象 ID 与 PlayerView 的稳定 objectId
   * 都不会进入 AI 决策边界。
   */
  readonly zoneCounts: readonly AiZoneCountObservation[];
}

/**
 * AI 协议专用的卡牌正面快照。它不复用 UI 投影类型，避免 UI 新增字段时
 * 未经安全审查就自动进入模型请求。
 */
export interface AiCardObservationV1 {
  readonly cardCode: string;
  readonly nameJp?: string;
  readonly nameCn?: string;
  readonly cardType: CardType;
  readonly cost?: number;
  readonly score?: number;
  readonly requiredHearts?: {
    readonly colorRequirements: Readonly<Partial<Record<HeartColor, number>>>;
    readonly totalRequired: number;
  };
  readonly hearts?: readonly {
    readonly color: HeartColor;
    readonly count: number;
  }[];
  readonly modifierDelta?: {
    readonly costDelta?: number;
    readonly bladeDelta?: number;
    readonly heartDeltas?: readonly {
      readonly color: HeartColor;
      readonly count: number;
    }[];
  };
  readonly bladeHearts?: readonly {
    readonly effect: BladeHeartEffect;
    readonly heartColor?: HeartColor;
  }[];
  readonly cardTextJp?: string;
  readonly cardTextCn?: string;
}

export interface AiMulliganCandidate {
  /** 仅在当前 decisionId 内有效，不编码卡牌实例 ID。 */
  readonly token: string;
  readonly card: AiCardObservationV1;
}

export interface AiMulliganDecisionWindow {
  readonly kind: 'MULLIGAN';
  readonly minSelections: 0;
  readonly maxSelections: number;
  readonly candidates: readonly AiMulliganCandidate[];
}

export interface AiDecisionRequestV1 {
  readonly schemaVersion: typeof AI_DECISION_SCHEMA_VERSION;
  /** 服务端生成的单次决策令牌；策略必须原样返回。 */
  readonly decisionId: string;
  readonly observation: AiObservationV1;
  readonly window: AiMulliganDecisionWindow;
}

export interface AiMulliganDecision {
  readonly schemaVersion: typeof AI_DECISION_SCHEMA_VERSION;
  readonly decisionId: string;
  readonly kind: 'MULLIGAN';
  readonly selectedCardTokens: readonly string[];
}

export type AiDecision = AiMulliganDecision;

export interface AiDecisionProvider {
  decide(request: AiDecisionRequestV1, signal: AbortSignal): Promise<AiDecision | null>;
}

/**
 * V2 只在新协议路径中使用。V1 的常量、类型和语义刻意保持不变，
 * 不会把 MAIN_ACTION 回填到 schemaVersion=1。
 */
export interface AiHandCardObservationV2 {
  /** 仅在当前 decisionId 内有效，不编码卡牌实例 ID。 */
  readonly handToken: string;
  readonly card: AiCardObservationV2;
}

export interface AiCardObservationV2 extends AiCardObservationV1 {
  /** 成员卡的印刷 BLADE；舞台有效值还需叠加 modifierDelta.bladeDelta。 */
  readonly blade?: number;
}

export interface AiStageMemberObservationV2 {
  readonly card: AiCardObservationV2;
  readonly orientation: OrientationState;
  readonly effectiveCost: number;
  readonly enteredStageThisTurn: boolean;
}

export interface AiStageSlotObservationV2 {
  readonly slot: SlotPosition;
  readonly member: AiStageMemberObservationV2 | null;
}

export interface AiSelfObservationV2 {
  readonly hand: readonly AiHandCardObservationV2[];
  /** 固定以 LEFT、CENTER、RIGHT 顺序输出。 */
  readonly stage: readonly AiStageSlotObservationV2[];
  readonly energy: {
    readonly activeCount: number;
    readonly totalCount: number;
  };
}

export interface AiMainActionObservationV2 extends AiObservationV1 {
  readonly self: AiSelfObservationV2;
}

export interface AiLiveCardObservationV2 {
  /** 决策内的区域位置标识，不编码实体 ID。 */
  readonly liveToken: string;
  readonly faceDown: boolean;
  /** 对手里侧 LIVE 卡始终为 null，不输出类型、判心或修正。 */
  readonly card: AiCardObservationV2 | null;
  readonly judgmentResult?: boolean;
  readonly scoreModifier?: number;
  readonly requirementReduction?: number;
  readonly requirementModifiers?: readonly {
    readonly color: HeartColor;
    readonly countDelta: number;
  }[];
}

export interface AiLiveContextV2 {
  readonly players: readonly {
    readonly seat: Seat;
    readonly stage: readonly AiStageSlotObservationV2[];
    readonly energy: AiSelfObservationV2['energy'];
    readonly liveCards: readonly AiLiveCardObservationV2[];
    readonly score: number;
    readonly scoreModifier: number;
    readonly heartBonuses: readonly { readonly color: HeartColor; readonly count: number }[];
  }[];
  readonly winnerSeats: readonly Seat[];
  readonly confirmedSeats: readonly Seat[];
}

export interface AiLiveActionObservationV2 extends AiMainActionObservationV2 {
  readonly live: AiLiveContextV2;
}

export interface AiMainActionPaymentObservationV2 {
  /** 应用当前登场费用修正后、换手减免前的费用。 */
  readonly modifiedCost: number;
  /** 该候选实际需横置的能量数。 */
  readonly energyCost: number;
  readonly relayDiscount: number;
}

export interface AiEndMainPhaseCandidateV2 {
  /** 仅在当前 decisionId 内有效，不编码命令参数。 */
  readonly actionToken: string;
  readonly kind: 'END_MAIN_PHASE';
}

export interface AiPlayMemberToEmptySlotCandidateV2 {
  readonly actionToken: string;
  readonly kind: 'PLAY_MEMBER_TO_EMPTY_SLOT';
  readonly sourceHandToken: string;
  readonly targetSlot: SlotPosition;
  readonly payment: AiMainActionPaymentObservationV2;
}

export interface AiPlayMemberWithSingleRelayCandidateV2 {
  readonly actionToken: string;
  readonly kind: 'PLAY_MEMBER_WITH_SINGLE_RELAY';
  readonly sourceHandToken: string;
  readonly targetSlot: SlotPosition;
  readonly payment: AiMainActionPaymentObservationV2;
}

export type AiMainActionCandidateV2 =
  | AiEndMainPhaseCandidateV2
  | AiPlayMemberToEmptySlotCandidateV2
  | AiPlayMemberWithSingleRelayCandidateV2
  | {
      readonly actionToken: string;
      readonly kind: 'ACTIVATE_ABILITY';
      /** 已通过来源/时点/次数校验，不保证费用、目标和后续选择均可执行。 */
      readonly legality: 'DECLARATION_ONLY';
      /** 来源卡面复用 self.stage；内部 abilityId 和实体 ID 不进入协议。 */
      readonly sourceSlot: SlotPosition;
      readonly abilityText: string;
    };

export interface AiMainActionDecisionWindowV2 {
  readonly kind: 'MAIN_ACTION';
  readonly minSelections: 1;
  readonly maxSelections: 1;
  readonly candidates: readonly AiMainActionCandidateV2[];
}

/** 每个候选绑定一次完整卡效确认；不会向 provider 暴露内部效果/选项 ID。 */
export type AiEffectStepCandidateV2 = { readonly actionToken: string } & (
  | { readonly kind: 'CONFIRM' | 'SKIP' }
  | {
      readonly kind: 'SELECT_CARD';
      readonly card: AiCardObservationV2;
      readonly ownerSeat: Seat;
    }
  | { readonly kind: 'SELECT_SLOT'; readonly targetSlot: SlotPosition }
  | { readonly kind: 'SELECT_OPTION' | 'SELECT_EFFECT_OPTION'; readonly label: string }
);

export interface AiEffectStepDecisionWindowV2 {
  readonly kind: 'EFFECT_STEP';
  readonly minSelections: 1;
  readonly maxSelections: 1;
  /** 来源目前不可见时不从权威卡库补出正面。 */
  readonly sourceCard: AiCardObservationV2 | null;
  /** 来源在本次效果中曾依法公开的卡号快照。 */
  readonly sourceCardDisplayCode?: string;
  readonly controllerSeat: Seat | null;
  readonly effectText: string;
  readonly stepText: string;
  readonly candidates: readonly AiEffectStepCandidateV2[];
}

/** 多选/排序声明，不枚举组合；额外组合费用等仍由原规则命令链判断。 */
export interface AiEffectCardSelectionWindowV2 {
  readonly kind: 'EFFECT_CARD_SELECTION';
  readonly legality: 'DECLARATION_ONLY';
  readonly minSelections: number;
  readonly maxSelections: number;
  /** 必须保留输入次序；ORDERED_MULTI 同时用于无序多选和真实牌库排序。 */
  readonly ordered: true;
  readonly canSkip: boolean;
  readonly sourceCard: AiCardObservationV2 | null;
  readonly sourceCardDisplayCode?: string;
  readonly controllerSeat: Seat | null;
  readonly effectText: string;
  readonly stepText: string;
  readonly candidates: readonly {
    readonly cardToken: string;
    readonly card: AiCardObservationV2;
    readonly ownerSeat: Seat;
  }[];
  readonly groups?: readonly {
    readonly candidateCardTokens: readonly string[];
    readonly minCount: number;
    readonly maxCount: number;
  }[];
  readonly distinctGroupAssignment: boolean;
  /** 仅当前权威局面实际执行失败的有序选择；不包含内部错误原因。 */
  readonly rejectedSelections: readonly (readonly string[])[];
}

/** 每个候选只绑定一条规则命令；AI 不提交判定布尔值或调整分数。 */
export type AiLiveActionCandidateV2 = { readonly actionToken: string } & (
  | { readonly kind: 'SET_LIVE_CARD'; readonly sourceHandToken: string }
  | {
      readonly kind: 'SELECT_SUCCESS_LIVE';
      readonly liveToken: string;
      readonly card: AiCardObservationV2;
    }
  | {
      readonly kind:
        | 'CONFIRM_LIVE_SET'
        | 'CONTINUE_LIVE_START'
        | 'SUBMIT_JUDGMENT'
        | 'CONFIRM_JUDGMENT'
        | 'SUBMIT_SCORE'
        | 'CONTINUE_SUCCESS_EFFECTS'
        | 'CONFIRM_RESULT_ANIMATION'
        | 'SKIP_SUCCESS_LIVE'
        | 'CONFIRM_RESULT_SETTLEMENT';
    }
);

export interface AiLiveActionDecisionWindowV2 {
  readonly kind: 'LIVE_ACTION';
  readonly minSelections: 1;
  readonly maxSelections: 1;
  readonly candidates: readonly AiLiveActionCandidateV2[];
}

interface AiDecisionRequestDraftBaseV2 {
  readonly schemaVersion: typeof AI_DECISION_SCHEMA_VERSION_V2;
  readonly decisionId: string;
}

export interface AiMulliganDecisionRequestDraftV2 extends AiDecisionRequestDraftBaseV2 {
  readonly observation: AiObservationV1;
  readonly window: AiMulliganDecisionWindow;
}

export interface AiMainActionDecisionRequestDraftV2 extends AiDecisionRequestDraftBaseV2 {
  readonly observation: AiMainActionObservationV2;
  readonly window: AiMainActionDecisionWindowV2;
}

export interface AiEffectStepDecisionRequestDraftV2 extends AiDecisionRequestDraftBaseV2 {
  readonly observation: AiMainActionObservationV2 | AiLiveActionObservationV2;
  readonly window: AiEffectStepDecisionWindowV2;
}

export interface AiLiveActionDecisionRequestDraftV2 extends AiDecisionRequestDraftBaseV2 {
  readonly observation: AiLiveActionObservationV2;
  readonly window: AiLiveActionDecisionWindowV2;
}

export interface AiEffectCardSelectionRequestDraftV2 extends AiDecisionRequestDraftBaseV2 {
  readonly observation: AiMainActionObservationV2 | AiLiveActionObservationV2;
  readonly window: AiEffectCardSelectionWindowV2;
}

/**
 * 应用层先构建的稳定请求上下文；服务端对 frame.canonicalContext
 * 做 SHA-256 后，再通过 finalizeAiDecisionFrameV2 绑定到最终 wire request。
 */
export type AiDecisionRequestDraftV2 =
  | AiMulliganDecisionRequestDraftV2
  | AiMainActionDecisionRequestDraftV2
  | AiEffectStepDecisionRequestDraftV2
  | AiEffectCardSelectionRequestDraftV2
  | AiLiveActionDecisionRequestDraftV2;

export type AiDecisionRequestV2 = AiDecisionRequestDraftV2 & {
  readonly contextDigest: string;
};

interface AiDecisionBaseV2 {
  readonly schemaVersion: typeof AI_DECISION_SCHEMA_VERSION_V2;
  readonly decisionId: string;
  /** 必须原样回传 request.contextDigest。 */
  readonly contextDigest: string;
}

export interface AiMulliganDecisionV2 extends AiDecisionBaseV2 {
  readonly kind: 'MULLIGAN';
  readonly selectedCardTokens: readonly string[];
}

export interface AiMainActionDecisionV2 extends AiDecisionBaseV2 {
  readonly kind: 'MAIN_ACTION';
  readonly selectedActionToken: string;
}

export interface AiEffectStepDecisionV2 extends AiDecisionBaseV2 {
  readonly kind: 'EFFECT_STEP';
  readonly selectedActionToken: string;
}

export interface AiLiveActionDecisionV2 extends AiDecisionBaseV2 {
  readonly kind: 'LIVE_ACTION';
  readonly selectedActionToken: string;
}

export type AiEffectCardSelectionDecisionV2 = AiDecisionBaseV2 & {
  readonly kind: 'EFFECT_CARD_SELECTION';
} & (
    | { readonly choice: 'SELECT'; readonly selectedCardTokens: readonly string[] }
    | { readonly choice: 'SKIP' }
  );

export type AiDecisionV2 =
  | AiMulliganDecisionV2
  | AiMainActionDecisionV2
  | AiEffectStepDecisionV2
  | AiLiveActionDecisionV2
  | AiEffectCardSelectionDecisionV2;

export interface AiDecisionProviderV2 {
  decide(request: AiDecisionRequestV2, signal: AbortSignal): Promise<AiDecisionV2 | null>;
}
