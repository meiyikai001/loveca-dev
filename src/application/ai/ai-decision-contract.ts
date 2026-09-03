import type { Seat, ViewZoneKey, WindowStatus, PublicWindowType } from '../../online/types.js';
import type { BladeHeartEffect, CardType, HeartColor } from '../../shared/types/enums.js';

export const AI_DECISION_SCHEMA_VERSION = 1 as const;

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
