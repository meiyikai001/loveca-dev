import { GameCommandType } from '../game-commands.js';
import type { PlayerViewState, ViewFrontCardInfo, ViewZoneKey } from '../../online/types.js';
import { HeartColor } from '../../shared/types/enums.js';
import {
  AI_DECISION_SCHEMA_VERSION,
  type AiCardObservationV1,
  type AiDecisionRequestV1,
  type AiMulliganCandidate,
  type AiObservationV1,
} from './ai-decision-contract.js';

const PUBLIC_OBJECT_ID_PREFIX = 'obj_';
const MAX_DECISION_ID_LENGTH = 256;
const MAX_CANDIDATE_TOKEN_LENGTH = 128;
const AI_HEART_COLORS = [
  HeartColor.PINK,
  HeartColor.RED,
  HeartColor.YELLOW,
  HeartColor.GREEN,
  HeartColor.BLUE,
  HeartColor.PURPLE,
  HeartColor.ORANGE,
  HeartColor.GRAY,
  HeartColor.RAINBOW,
] as const;
const AI_OWNED_ZONE_SUFFIXES = [
  'HAND',
  'MAIN_DECK',
  'ENERGY_DECK',
  'MEMBER_LEFT',
  'MEMBER_CENTER',
  'MEMBER_RIGHT',
  'ENERGY_ZONE',
  'LIVE_ZONE',
  'EXILE_ZONE',
  'SUCCESS_ZONE',
  'WAITING_ROOM',
  'INSPECTION_ZONE',
] as const;
const AI_ZONE_KEYS: readonly ViewZoneKey[] = [
  ...(['FIRST', 'SECOND'] as const).flatMap((seat) =>
    AI_OWNED_ZONE_SUFFIXES.map((suffix) => `${seat}_${suffix}` as ViewZoneKey)
  ),
  'SHARED_RESOLUTION_ZONE',
];

export interface AiDecisionFrame {
  readonly request: AiDecisionRequestV1;
  /** 受信任执行侧专用；不得传给 AiDecisionProvider。 */
  readonly mulliganCardIdByToken: ReadonlyMap<string, string>;
}

export type AiDecisionFrameBuildResult =
  | { readonly ok: true; readonly frame: AiDecisionFrame }
  | { readonly ok: false; readonly reason: string };

export type AiDecisionResolution =
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.MULLIGAN;
      readonly cardIdsToMulligan: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/**
 * 从玩家投影建立当前支持的 AI 决策窗口。
 *
 * v0 只支持换牌。这里刻意不透传完整 PlayerViewState，避免己方牌库中
 * 稳定但里侧的 publicObjectId 被策略用于追踪牌序。
 */
export function buildAiDecisionFrame(
  view: PlayerViewState,
  decisionId: string
): AiDecisionFrameBuildResult {
  const mulliganHint = view.permissions.availableCommands.find(
    (hint) => hint.command === GameCommandType.MULLIGAN && hint.enabled
  );
  if (!mulliganHint) {
    return { ok: false, reason: '当前没有可用的换牌决策窗口' };
  }

  const handZoneKey = `${view.match.viewerSeat}_HAND` as ViewZoneKey;
  const handZone = view.table.zones[handZoneKey];
  if (!handZone?.objectIds || handZone.objectIds.length !== handZone.count) {
    return { ok: false, reason: '己方手牌投影不完整' };
  }

  const mulliganCardIdByToken = new Map<string, string>();
  const candidates: AiMulliganCandidate[] = [];
  for (const [index, publicObjectId] of handZone.objectIds.entries()) {
    const object = view.objects[publicObjectId];
    const cardId = decodePublicObjectId(publicObjectId);
    if (!object?.frontInfo || object.ownerSeat !== view.match.viewerSeat || !cardId) {
      return { ok: false, reason: '己方换牌候选缺少正面卡牌信息' };
    }

    const token = `hand-${index + 1}`;
    mulliganCardIdByToken.set(token, cardId);
    candidates.push({
      token,
      card: buildAiCardObservation(object.frontInfo),
    });
  }

  const request: AiDecisionRequestV1 = {
    schemaVersion: AI_DECISION_SCHEMA_VERSION,
    decisionId,
    observation: buildObservation(view),
    window: {
      kind: 'MULLIGAN',
      minSelections: 0,
      maxSelections: candidates.length,
      candidates,
    },
  };

  return {
    ok: true,
    frame: {
      request,
      mulliganCardIdByToken,
    },
  };
}

export function resolveAiDecision(frame: AiDecisionFrame, decision: unknown): AiDecisionResolution {
  if (!isRecord(decision)) {
    return { ok: false, reason: 'AI 决策不是有效对象' };
  }
  if (decision.schemaVersion !== AI_DECISION_SCHEMA_VERSION) {
    return { ok: false, reason: 'AI 决策协议版本不支持' };
  }
  if (
    typeof decision.decisionId !== 'string' ||
    decision.decisionId.length === 0 ||
    decision.decisionId.length > MAX_DECISION_ID_LENGTH
  ) {
    return { ok: false, reason: 'AI 决策令牌格式无效' };
  }
  if (decision.decisionId !== frame.request.decisionId) {
    return { ok: false, reason: '决策令牌与当前窗口不一致' };
  }
  if (decision.kind !== frame.request.window.kind) {
    return { ok: false, reason: '决策类型与当前窗口不一致' };
  }

  if (!Array.isArray(decision.selectedCardTokens)) {
    return { ok: false, reason: '换牌选择必须是候选令牌数组' };
  }
  if (
    decision.selectedCardTokens.length < frame.request.window.minSelections ||
    decision.selectedCardTokens.length > frame.request.window.maxSelections
  ) {
    return { ok: false, reason: '换牌选择数量不符合当前窗口约束' };
  }

  const selectedTokens: string[] = [];
  for (const token of decision.selectedCardTokens) {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > MAX_CANDIDATE_TOKEN_LENGTH
    ) {
      return { ok: false, reason: '换牌选择包含格式无效的候选令牌' };
    }
    selectedTokens.push(token);
  }
  if (new Set(selectedTokens).size !== selectedTokens.length) {
    return { ok: false, reason: '换牌选择包含重复候选' };
  }

  const cardIdsToMulligan: string[] = [];
  for (const token of selectedTokens) {
    const cardId = frame.mulliganCardIdByToken.get(token);
    if (!cardId) {
      return { ok: false, reason: '换牌选择包含未知候选' };
    }
    cardIdsToMulligan.push(cardId);
  }

  return {
    ok: true,
    commandType: GameCommandType.MULLIGAN,
    cardIdsToMulligan,
  };
}

function buildObservation(view: PlayerViewState): AiObservationV1 {
  return {
    match: {
      viewerSeat: view.match.viewerSeat,
      turnCount: view.match.turnCount,
      phase: view.match.phase,
      subPhase: view.match.subPhase,
      firstSeat: view.match.firstSeat,
      activeSeat: view.match.activeSeat,
      prioritySeat: view.match.prioritySeat,
      publicSequence: view.match.seq,
      window: view.match.window
        ? {
            windowType: view.match.window.windowType,
            status: view.match.window.status,
            actingSeat: view.match.window.actingSeat,
            waitingSeats: [...view.match.window.waitingSeats],
          }
        : null,
    },
    zoneCounts: AI_ZONE_KEYS.flatMap((zoneKey) => {
      const zone = view.table.zones[zoneKey];
      return zone
        ? [
            {
              zoneKey,
              zone: zone.zone,
              ownerSeat: zone.ownerSeat,
              count: zone.count,
            },
          ]
        : [];
    }).sort((left, right) => left.zoneKey.localeCompare(right.zoneKey)),
  };
}

function decodePublicObjectId(publicObjectId: string): string | null {
  if (!publicObjectId.startsWith(PUBLIC_OBJECT_ID_PREFIX)) {
    return null;
  }
  const cardId = publicObjectId.slice(PUBLIC_OBJECT_ID_PREFIX.length);
  return cardId.length > 0 ? cardId : null;
}

function buildAiCardObservation(frontInfo: ViewFrontCardInfo): AiCardObservationV1 {
  return {
    cardCode: frontInfo.cardCode,
    nameJp: frontInfo.nameJp,
    nameCn: frontInfo.nameCn,
    cardType: frontInfo.cardType,
    cost: frontInfo.cost,
    score: frontInfo.score,
    requiredHearts: frontInfo.requiredHearts
      ? {
          colorRequirements: Object.fromEntries(
            AI_HEART_COLORS.flatMap((color) => {
              const count = frontInfo.requiredHearts?.colorRequirements[color];
              return count === undefined ? [] : [[color, count]];
            })
          ),
          totalRequired: frontInfo.requiredHearts.totalRequired,
        }
      : undefined,
    hearts: frontInfo.hearts?.map((heart) => ({
      color: heart.color,
      count: heart.count,
    })),
    modifierDelta: frontInfo.modifierDelta
      ? {
          costDelta: frontInfo.modifierDelta.costDelta,
          bladeDelta: frontInfo.modifierDelta.bladeDelta,
          heartDeltas: frontInfo.modifierDelta.heartDeltas?.map((heart) => ({
            color: heart.color,
            count: heart.count,
          })),
        }
      : undefined,
    bladeHearts: frontInfo.bladeHearts?.map((item) => ({
      effect: item.effect,
      heartColor: item.heartColor,
    })),
    cardTextJp: frontInfo.cardTextJp,
    cardTextCn: frontInfo.cardTextCn,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
