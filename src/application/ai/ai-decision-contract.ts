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
  | AiPlayMemberWithSingleRelayCandidateV2;

export interface AiMainActionDecisionWindowV2 {
  readonly kind: 'MAIN_ACTION';
  readonly minSelections: 1;
  readonly maxSelections: 1;
  readonly candidates: readonly AiMainActionCandidateV2[];
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

/**
 * 应用层先构建的稳定请求上下文；服务端对 frame.canonicalContext
 * 做 SHA-256 后，再通过 finalizeAiDecisionFrameV2 绑定到最终 wire request。
 */
export type AiDecisionRequestDraftV2 =
  AiMulliganDecisionRequestDraftV2 | AiMainActionDecisionRequestDraftV2;

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

export type AiDecisionV2 = AiMulliganDecisionV2 | AiMainActionDecisionV2;

export interface AiDecisionProviderV2 {
  decide(request: AiDecisionRequestV2, signal: AbortSignal): Promise<AiDecisionV2 | null>;
}
