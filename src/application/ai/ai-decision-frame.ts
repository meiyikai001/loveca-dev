import { GameCommandType } from '../game-commands.js';
import type { PlayerViewState, Seat, ViewFrontCardInfo, ViewZoneKey } from '../../online/types.js';
import {
  CardType,
  FaceState,
  GamePhase,
  HeartColor,
  OrientationState,
  SlotPosition,
} from '../../shared/types/enums.js';
import type { LegalRulesEffectStepAction } from './ai-effect-step-actions.js';
import type { LegalRulesLiveAction } from './ai-live-actions.js';
import {
  MAX_AI_EFFECT_SELECTION_CARDS,
  MAX_AI_REJECTED_EFFECT_SELECTIONS,
  type RulesEffectCardSelection,
  type EffectCardSelectionBinding,
} from './ai-effect-card-selection.js';
import { matchesSelectionGroups } from '../effects/card-selection-groups.js';
import {
  AI_DECISION_SCHEMA_VERSION,
  AI_DECISION_SCHEMA_VERSION_V2,
  type AiCardObservationV1,
  type AiCardObservationV2,
  type AiDecisionRequestDraftV2,
  type AiDecisionRequestV2,
  type AiDecisionRequestV1,
  type AiEffectStepCandidateV2,
  type AiEffectCardSelectionWindowV2,
  type AiHandCardObservationV2,
  type AiMainActionCandidateV2,
  type AiMainActionObservationV2,
  type AiLiveActionCandidateV2,
  type AiLiveActionObservationV2,
  type AiLiveCardObservationV2,
  type AiLiveContextV2,
  type AiMulliganCandidate,
  type AiObservationV1,
  type AiSelfObservationV2,
} from './ai-decision-contract.js';

const PUBLIC_OBJECT_ID_PREFIX = 'obj_';
const MAX_DECISION_ID_LENGTH = 256;
const MAX_CANDIDATE_TOKEN_LENGTH = 128;
const MAX_CONTEXT_DIGEST_LENGTH = 256;
// 普通登场至多 60 × 3 + END；舞台直接起动按定义追加，超限仍整体拒绝。
const MAX_MAIN_ACTION_CANDIDATES = 256;
const MAX_EFFECT_STEP_CANDIDATES = 256;
const MAX_LIVE_ACTION_CANDIDATES = 64;
const AI_LIVE_PHASES: readonly string[] = [
  GamePhase.LIVE_SET_PHASE,
  GamePhase.PERFORMANCE_PHASE,
  GamePhase.LIVE_RESULT_PHASE,
];
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
const AI_STAGE_SLOTS = [SlotPosition.LEFT, SlotPosition.CENTER, SlotPosition.RIGHT] as const;

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

export interface TrustedEndPhaseMainActionCandidateV2 {
  readonly kind: 'END_PHASE';
  readonly binding: {
    readonly type: GameCommandType.END_PHASE;
    readonly playerId: string;
  };
}

export interface TrustedPlayMemberMainActionCandidateV2 {
  readonly kind: 'PLAY_MEMBER_TO_SLOT';
  readonly playMode: 'EMPTY' | 'SINGLE_RELAY';
  readonly binding: {
    readonly type: GameCommandType.PLAY_MEMBER_TO_SLOT;
    readonly playerId: string;
    readonly cardId: string;
    readonly targetSlot: SlotPosition;
    readonly relayMode?: 'SINGLE';
  };
  readonly preview: {
    readonly printedCost: number;
    readonly modifiedCost: number;
    readonly energyCost: number;
    readonly relayDiscount: number;
  };
}

/**
 * 权威枚举器与 AI Frame 之间的受信边界。binding 中的 playerId/cardId
 * 仅保存在 Frame 的执行侧 Map，不会进入 wire request。
 */
export type TrustedMainActionCandidateV2 =
  | TrustedEndPhaseMainActionCandidateV2
  | TrustedPlayMemberMainActionCandidateV2
  | {
      readonly kind: 'ACTIVATE_ABILITY';
      readonly sourceSlot: SlotPosition;
      readonly binding: {
        readonly type: GameCommandType.ACTIVATE_ABILITY;
        readonly playerId: string;
        readonly cardId: string;
        readonly abilityId: string;
        readonly abilityInstanceId?: never;
      };
    };

export interface AiDecisionFrameDraftV2 {
  readonly request: AiDecisionRequestDraftV2;
  /**
   * 不包含 decisionId、contextDigest 或 trusted binding 的规范 JSON。
   * 服务端可在 Node 边界对它计算 SHA-256。
   */
  readonly canonicalContext: string;
  readonly mulliganCardIdByToken: ReadonlyMap<string, string>;
  readonly mainActionByToken: ReadonlyMap<string, TrustedMainActionCandidateV2>;
  readonly effectActionByToken: ReadonlyMap<string, LegalRulesEffectStepAction>;
  readonly liveActionByToken: ReadonlyMap<string, LegalRulesLiveAction>;
  readonly effectCardSelection: RulesEffectCardSelection | null;
  readonly effectCardIdByToken: ReadonlyMap<string, string>;
}

export interface AiDecisionFrameV2 {
  readonly request: AiDecisionRequestV2;
  readonly canonicalContext: string;
  readonly mulliganCardIdByToken: ReadonlyMap<string, string>;
  readonly mainActionByToken: ReadonlyMap<string, TrustedMainActionCandidateV2>;
  readonly effectActionByToken: ReadonlyMap<string, LegalRulesEffectStepAction>;
  readonly liveActionByToken: ReadonlyMap<string, LegalRulesLiveAction>;
  readonly effectCardSelection: RulesEffectCardSelection | null;
  readonly effectCardIdByToken: ReadonlyMap<string, string>;
}

export type AiDecisionFrameDraftBuildResultV2 =
  | { readonly ok: true; readonly frame: AiDecisionFrameDraftV2 }
  | { readonly ok: false; readonly reason: string };

export type AiDecisionFrameFinalizeResultV2 =
  | { readonly ok: true; readonly frame: AiDecisionFrameV2 }
  | { readonly ok: false; readonly reason: string };

export type AiDecisionResolutionV2 =
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.ACTIVATE_ABILITY;
      readonly cardId: string;
      readonly abilityId: string;
    }
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.MULLIGAN;
      readonly cardIdsToMulligan: readonly string[];
    }
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.END_PHASE;
    }
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.PLAY_MEMBER_TO_SLOT;
      readonly cardId: string;
      readonly targetSlot: SlotPosition;
      readonly relayMode?: 'SINGLE';
    }
  | {
      readonly ok: true;
      readonly commandType: GameCommandType.CONFIRM_EFFECT_STEP;
      readonly effectStep: LegalRulesEffectStepAction['binding'] | EffectCardSelectionBinding;
    }
  | {
      readonly ok: true;
      readonly commandType: LegalRulesLiveAction['binding']['type'];
      readonly liveAction: LegalRulesLiveAction['binding'];
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

/**
 * 构建 V2 决策 Frame 草稿。V2 在换牌窗口保留 V1 的可见语义，
 * 登场使用已验证动作；起动及多选使用声明，均须由真实命令最终校验。
 */
export function buildAiDecisionFrameV2(
  view: PlayerViewState,
  decisionId: string,
  trustedMainActions: readonly TrustedMainActionCandidateV2[] = [],
  trustedEffectActions: readonly LegalRulesEffectStepAction[] = [],
  trustedLiveActions: readonly LegalRulesLiveAction[] = [],
  trustedEffectCardSelection: RulesEffectCardSelection | null = null,
  rejectedEffectSelections: readonly (readonly string[])[] = []
): AiDecisionFrameDraftBuildResultV2 {
  if (!isValidBoundedString(decisionId, MAX_DECISION_ID_LENGTH)) {
    return { ok: false, reason: 'AI 决策令牌格式无效' };
  }

  if (view.activeEffect) {
    if (trustedEffectCardSelection) {
      return buildAiEffectCardSelectionFrame(
        view,
        decisionId,
        trustedEffectCardSelection,
        rejectedEffectSelections
      );
    }
    return buildAiEffectStepFrame(view, decisionId, trustedEffectActions);
  }

  if (AI_LIVE_PHASES.includes(view.match.phase)) {
    return buildAiLiveActionFrame(view, decisionId, trustedLiveActions);
  }

  const mulliganHint = view.permissions.availableCommands.find(
    (hint) => hint.command === GameCommandType.MULLIGAN && hint.enabled
  );
  if (mulliganHint) {
    const v1Build = buildAiDecisionFrame(view, decisionId);
    if (!v1Build.ok) {
      return v1Build;
    }
    const request: AiDecisionRequestDraftV2 = {
      schemaVersion: AI_DECISION_SCHEMA_VERSION_V2,
      decisionId,
      observation: v1Build.frame.request.observation,
      window: v1Build.frame.request.window,
    };
    return {
      ok: true,
      frame: createAiDecisionFrameDraftV2(request, {
        mulliganCardIdByToken: v1Build.frame.mulliganCardIdByToken,
        mainActionByToken: new Map(),
        effectActionByToken: new Map(),
      }),
    };
  }

  if (trustedMainActions.length === 0) {
    return { ok: false, reason: '当前没有可用的 AI 决策窗口' };
  }
  if (trustedMainActions.length > MAX_MAIN_ACTION_CANDIDATES) {
    return { ok: false, reason: '主要阶段合法动作数量超过 AI 协议上限' };
  }

  const ownPlayerId = view.match.participants[view.match.viewerSeat]?.id;
  if (!ownPlayerId) {
    return { ok: false, reason: '己方玩家投影不完整' };
  }

  const selfBuild = buildAiSelfObservationV2(view);
  if (!selfBuild.ok) {
    return selfBuild;
  }

  const commandAvailability = {
    canEndPhase: view.permissions.availableCommands.some(
      (hint) => hint.command === GameCommandType.END_PHASE && hint.enabled
    ),
    canPlayMember: view.permissions.availableCommands.some(
      (hint) => hint.command === GameCommandType.PLAY_MEMBER_TO_SLOT && hint.enabled
    ),
    canActivateAbility: view.permissions.availableCommands.some(
      (hint) => hint.command === GameCommandType.ACTIVATE_ABILITY && hint.enabled
    ),
  };
  const normalizedBuild = normalizeAndSortTrustedMainActions(
    trustedMainActions,
    ownPlayerId,
    selfBuild.handByCardId,
    selfBuild.observation,
    commandAvailability,
    view
  );
  if (!normalizedBuild.ok) {
    return normalizedBuild;
  }

  const candidates: AiMainActionCandidateV2[] = [];
  const mainActionByToken = new Map<string, TrustedMainActionCandidateV2>();
  for (const [index, action] of normalizedBuild.actions.entries()) {
    const actionToken = `action-${index + 1}`;
    mainActionByToken.set(actionToken, action);
    if (action.kind === 'END_PHASE') {
      candidates.push({ actionToken, kind: 'END_MAIN_PHASE' });
      continue;
    }
    if (action.kind === 'ACTIVATE_ABILITY') {
      const source = view.objects[`${PUBLIC_OBJECT_ID_PREFIX}${action.binding.cardId}`]!;
      const config = source.activatedAbilityUiConfigs!.find(
        (entry) =>
          entry.abilityId === action.binding.abilityId && entry.abilityInstanceId === undefined
      )!;
      candidates.push({
        actionToken,
        kind: 'ACTIVATE_ABILITY',
        legality: 'DECLARATION_ONLY',
        sourceSlot: action.sourceSlot,
        abilityText: config.text,
      });
      continue;
    }

    const handCard = selfBuild.handByCardId.get(action.binding.cardId);
    if (!handCard) {
      return { ok: false, reason: '成员登场候选缺少己方手牌投影' };
    }
    const payment = {
      modifiedCost: action.preview.modifiedCost,
      energyCost: action.preview.energyCost,
      relayDiscount: action.preview.relayDiscount,
    };
    candidates.push(
      action.playMode === 'EMPTY'
        ? {
            actionToken,
            kind: 'PLAY_MEMBER_TO_EMPTY_SLOT',
            sourceHandToken: handCard.observation.handToken,
            targetSlot: action.binding.targetSlot,
            payment,
          }
        : {
            actionToken,
            kind: 'PLAY_MEMBER_WITH_SINGLE_RELAY',
            sourceHandToken: handCard.observation.handToken,
            targetSlot: action.binding.targetSlot,
            payment,
          }
    );
  }

  const observation: AiMainActionObservationV2 = {
    ...buildObservation(view),
    self: selfBuild.observation,
  };
  const request: AiDecisionRequestDraftV2 = {
    schemaVersion: AI_DECISION_SCHEMA_VERSION_V2,
    decisionId,
    observation,
    window: {
      kind: 'MAIN_ACTION',
      minSelections: 1,
      maxSelections: 1,
      candidates,
    },
  };

  return {
    ok: true,
    frame: createAiDecisionFrameDraftV2(request, {
      mulliganCardIdByToken: new Map(),
      mainActionByToken,
      effectActionByToken: new Map(),
    }),
  };
}

function buildAiLiveActionFrame(
  view: PlayerViewState,
  decisionId: string,
  trustedActions: readonly LegalRulesLiveAction[]
): AiDecisionFrameDraftBuildResultV2 {
  const ownPlayerId = view.match.participants[view.match.viewerSeat]?.id;
  if (
    !ownPlayerId ||
    view.match.endInfo ||
    view.match.manualOperation.mode !== 'RULES' ||
    view.activeEffect ||
    view.pendingCostPayment ||
    view.pendingSpecialMemberPlay ||
    !AI_LIVE_PHASES.includes(view.match.phase) ||
    trustedActions.length === 0 ||
    trustedActions.length > MAX_LIVE_ACTION_CANDIDATES
  ) {
    return { ok: false, reason: '当前没有可用的 AI LIVE 决策窗口或候选数量超限' };
  }
  const selfBuild = buildAiSelfObservationV2(view);
  if (!selfBuild.ok) return selfBuild;
  const liveBuild = buildAiLiveContextV2(view);
  if (!liveBuild.ok) return liveBuild;
  const ownLiveCards = liveBuild.observation.players.find(
    (player) => player.seat === view.match.viewerSeat
  )!.liveCards;
  const liveObjectIds = view.table.zones[`${view.match.viewerSeat}_LIVE_ZONE`]?.objectIds ?? [];
  const candidates: AiLiveActionCandidateV2[] = [];
  const liveActionByToken = new Map<string, LegalRulesLiveAction>();

  for (const [index, action] of trustedActions.entries()) {
    if (
      action.binding.playerId !== ownPlayerId ||
      (action.binding.type === GameCommandType.CONFIRM_STEP &&
        action.binding.subPhase !== view.match.subPhase)
    ) {
      return { ok: false, reason: 'LIVE 候选与当前权威窗口不一致' };
    }
    // UI hints 描述按钮入口，不是完整命令授权：接受判定的第二条确认和
    // skipSuccessLiveSelection 都可能没有 enabled 的通用 CONFIRM_STEP hint。
    // 本处只消费 GameSession 经中央 validateCommand 验证的完整候选。
    const actionToken = `live-action-${index + 1}`;
    if (action.kind === 'SET_LIVE_CARD') {
      const handEntry = selfBuild.handByCardId.get(action.binding.cardId);
      if (!handEntry || action.binding.faceDown !== true) {
        return { ok: false, reason: 'LIVE 设置候选缺少己方手牌或不是里侧盖牌' };
      }
      candidates.push({
        actionToken,
        kind: action.kind,
        sourceHandToken: handEntry.observation.handToken,
      });
    } else if (action.kind === 'SELECT_SUCCESS_LIVE') {
      const objectId = `${PUBLIC_OBJECT_ID_PREFIX}${action.binding.cardId}`;
      const cardIndex = liveObjectIds.indexOf(objectId);
      const liveCard = ownLiveCards[cardIndex];
      const selection = view.match.liveResult?.successLiveSelection;
      if (
        !liveCard?.card ||
        liveCard.faceDown ||
        selection?.waitingSeat !== view.match.viewerSeat ||
        !selection.candidateObjectIds.includes(objectId)
      ) {
        return { ok: false, reason: '成功 LIVE 候选缺少当前可见的合法投影' };
      }
      candidates.push({
        actionToken,
        kind: action.kind,
        liveToken: liveCard.liveToken,
        card: liveCard.card,
      });
    } else {
      if (
        action.kind === 'SKIP_SUCCESS_LIVE' &&
        (view.match.liveResult?.successLiveSelection?.waitingSeat !== view.match.viewerSeat ||
          view.match.liveResult.successLiveSelection.canSkipToWaitingRoom !== true)
      ) {
        return { ok: false, reason: '当前不能放弃成功 LIVE 入成功区' };
      }
      candidates.push({ actionToken, kind: action.kind });
    }
    liveActionByToken.set(actionToken, action);
  }
  const observation: AiLiveActionObservationV2 = {
    ...buildObservation(view),
    self: selfBuild.observation,
    live: liveBuild.observation,
  };
  return {
    ok: true,
    frame: createAiDecisionFrameDraftV2(
      {
        schemaVersion: AI_DECISION_SCHEMA_VERSION_V2,
        decisionId,
        observation,
        window: { kind: 'LIVE_ACTION', minSelections: 1, maxSelections: 1, candidates },
      },
      {
        mulliganCardIdByToken: new Map(),
        mainActionByToken: new Map(),
        effectActionByToken: new Map(),
        liveActionByToken,
      }
    ),
  };
}

function buildAiEffectStepFrame(
  view: PlayerViewState,
  decisionId: string,
  trustedActions: readonly LegalRulesEffectStepAction[]
): AiDecisionFrameDraftBuildResultV2 {
  const effect = view.activeEffect;
  const ownPlayerId = view.match.participants[view.match.viewerSeat]?.id;
  if (
    !effect ||
    !ownPlayerId ||
    view.match.manualOperation.mode !== 'RULES' ||
    (view.match.phase !== GamePhase.MAIN_PHASE && !AI_LIVE_PHASES.includes(view.match.phase)) ||
    effect.waitingSeat !== view.match.viewerSeat ||
    effect.publicCardSelectionAutoAdvanceAt !== undefined ||
    effect.publicEffectChoiceAutoAdvanceAt !== undefined ||
    effect.publicRevealAutoAdvanceAt !== undefined ||
    !view.permissions.availableCommands.some(
      (hint) => hint.command === GameCommandType.CONFIRM_EFFECT_STEP && hint.enabled
    )
  ) {
    return { ok: false, reason: '当前不是可处理的 AI 卡效选择窗口' };
  }
  if (trustedActions.length === 0 || trustedActions.length > MAX_EFFECT_STEP_CANDIDATES) {
    return { ok: false, reason: '当前卡效选择形态尚未接入 AI 或候选数量超限' };
  }
  const selfBuild = buildAiSelfObservationV2(view);
  if (!selfBuild.ok) return selfBuild;
  const liveBuild = AI_LIVE_PHASES.includes(view.match.phase) ? buildAiLiveContextV2(view) : null;
  if (liveBuild && !liveBuild.ok) return liveBuild;

  const candidates: AiEffectStepCandidateV2[] = [];
  const effectActionByToken = new Map<string, LegalRulesEffectStepAction>();
  for (const [index, action] of trustedActions.entries()) {
    if (
      action.binding.type !== GameCommandType.CONFIRM_EFFECT_STEP ||
      action.binding.playerId !== ownPlayerId ||
      action.binding.effectId !== effect.id
    ) {
      return { ok: false, reason: '卡效候选与当前权威窗口不一致' };
    }
    const actionToken = `effect-action-${index + 1}`;
    const candidate = projectAiEffectStepCandidate(view, action, actionToken);
    if (!candidate) {
      return { ok: false, reason: '卡效候选缺少当前玩家可见的合法投影' };
    }
    candidates.push(candidate);
    effectActionByToken.set(actionToken, action);
  }

  const sourceObject = view.objects[effect.sourceObjectId];
  return {
    ok: true,
    frame: createAiDecisionFrameDraftV2(
      {
        schemaVersion: AI_DECISION_SCHEMA_VERSION_V2,
        decisionId,
        observation: {
          ...buildObservation(view),
          self: selfBuild.observation,
          ...(liveBuild?.ok ? { live: liveBuild.observation } : {}),
        },
        window: {
          kind: 'EFFECT_STEP',
          minSelections: 1,
          maxSelections: 1,
          sourceCard:
            sourceObject?.surface === 'FRONT' && sourceObject.frontInfo
              ? buildAiCardObservationV2(sourceObject.frontInfo)
              : null,
          sourceCardDisplayCode: effect.sourceCardDisplayCode,
          controllerSeat: effect.controllerSeat,
          effectText: effect.effectText,
          stepText: effect.stepText,
          candidates,
        },
      },
      {
        mulliganCardIdByToken: new Map(),
        mainActionByToken: new Map(),
        effectActionByToken,
      }
    ),
  };
}

function buildAiEffectCardSelectionFrame(
  view: PlayerViewState,
  decisionId: string,
  selection: RulesEffectCardSelection,
  rejectedSelections: readonly (readonly string[])[]
): AiDecisionFrameDraftBuildResultV2 {
  const effect = view.activeEffect;
  const ownPlayerId = view.match.participants[view.match.viewerSeat]?.id;
  if (
    !effect ||
    !ownPlayerId ||
    view.match.endInfo ||
    view.match.manualOperation.mode !== 'RULES' ||
    (view.match.phase !== GamePhase.MAIN_PHASE && !AI_LIVE_PHASES.includes(view.match.phase)) ||
    view.pendingCostPayment ||
    view.pendingSpecialMemberPlay ||
    effect.waitingSeat !== view.match.viewerSeat ||
    effect.selectableObjectMode !== 'ORDERED_MULTI' ||
    effect.selectableObjectsFaceDown ||
    effect.numericInput ||
    effect.stageFormation ||
    effect.effectChoice ||
    effect.selectableSlots !== undefined ||
    effect.selectableOptions !== undefined ||
    effect.publicCardSelectionAutoAdvanceAt !== undefined ||
    effect.publicEffectChoiceAutoAdvanceAt !== undefined ||
    effect.publicRevealAutoAdvanceAt !== undefined ||
    selection.binding.type !== GameCommandType.CONFIRM_EFFECT_STEP ||
    selection.binding.playerId !== ownPlayerId ||
    selection.binding.effectId !== effect.id ||
    selection.cardIds.length > MAX_AI_EFFECT_SELECTION_CARDS ||
    new Set(selection.cardIds).size !== selection.cardIds.length ||
    selection.minSelections !== (effect.minSelectableObjects ?? 0) ||
    selection.maxSelections !==
      (effect.maxSelectableObjects ?? effect.selectableObjectIds?.length ?? 0) ||
    selection.canSkip !== (effect.canSkipSelection === true) ||
    selection.cardIds.length !== (effect.selectableObjectIds?.length ?? 0) ||
    rejectedSelections.length > MAX_AI_REJECTED_EFFECT_SELECTIONS ||
    !view.permissions.availableCommands.some(
      (hint) => hint.command === GameCommandType.CONFIRM_EFFECT_STEP && hint.enabled
    )
  )
    return { ok: false, reason: '当前多选声明缺少完整可见的权威窗口' };

  const selfBuild = buildAiSelfObservationV2(view);
  if (!selfBuild.ok) return selfBuild;
  const liveBuild = AI_LIVE_PHASES.includes(view.match.phase) ? buildAiLiveContextV2(view) : null;
  if (liveBuild && !liveBuild.ok) return liveBuild;
  const candidates: AiEffectCardSelectionWindowV2['candidates'][number][] = [];
  const effectCardIdByToken = new Map<string, string>();
  const tokenByCardId = new Map<string, string>();
  for (const [index, cardId] of selection.cardIds.entries()) {
    const objectId = `${PUBLIC_OBJECT_ID_PREFIX}${cardId}`;
    const object = view.objects[objectId];
    if (
      !effect.selectableObjectIds?.includes(objectId) ||
      object?.surface !== 'FRONT' ||
      !object.frontInfo
    ) {
      return { ok: false, reason: '多选候选缺少当前玩家可见卡面' };
    }
    const cardToken = `effect-card-${index + 1}`;
    effectCardIdByToken.set(cardToken, cardId);
    tokenByCardId.set(cardId, cardToken);
    candidates.push({
      cardToken,
      card: buildAiCardObservationV2(object.frontInfo),
      ownerSeat: object.ownerSeat,
    });
  }
  if (
    selection.groups?.some((group) =>
      group.candidateCardIds.some((id) => !tokenByCardId.has(id))
    ) ||
    rejectedSelections.some(
      (ids) =>
        ids.length > MAX_AI_EFFECT_SELECTION_CARDS || ids.some((id) => !tokenByCardId.has(id))
    )
  ) {
    return { ok: false, reason: '多选分组或已拒绝选择引用未知候选' };
  }
  const sourceObject = view.objects[effect.sourceObjectId];
  return {
    ok: true,
    frame: createAiDecisionFrameDraftV2(
      {
        schemaVersion: AI_DECISION_SCHEMA_VERSION_V2,
        decisionId,
        observation: {
          ...buildObservation(view),
          self: selfBuild.observation,
          ...(liveBuild?.ok ? { live: liveBuild.observation } : {}),
        },
        window: {
          kind: 'EFFECT_CARD_SELECTION',
          legality: 'DECLARATION_ONLY',
          ordered: true,
          minSelections: selection.minSelections,
          maxSelections: selection.maxSelections,
          canSkip: selection.canSkip,
          sourceCard:
            sourceObject?.surface === 'FRONT' && sourceObject.frontInfo
              ? buildAiCardObservationV2(sourceObject.frontInfo)
              : null,
          sourceCardDisplayCode: effect.sourceCardDisplayCode,
          controllerSeat: effect.controllerSeat,
          effectText: effect.effectText,
          stepText: effect.stepText,
          candidates,
          ...(selection.groups !== undefined
            ? {
                groups: selection.groups.map((group) => ({
                  candidateCardTokens: group.candidateCardIds.map((id) => tokenByCardId.get(id)!),
                  minCount: group.minCount,
                  maxCount: group.maxCount,
                })),
              }
            : {}),
          distinctGroupAssignment: selection.distinctGroupAssignment,
          rejectedSelections: rejectedSelections.map((ids) =>
            ids.map((id) => tokenByCardId.get(id)!)
          ),
        },
      },
      {
        mulliganCardIdByToken: new Map(),
        mainActionByToken: new Map(),
        effectActionByToken: new Map(),
        effectCardSelection: selection,
        effectCardIdByToken,
      }
    ),
  };
}

function projectAiEffectStepCandidate(
  view: PlayerViewState,
  action: LegalRulesEffectStepAction,
  actionToken: string
): AiEffectStepCandidateV2 | null {
  const effect = view.activeEffect!;
  switch (action.kind) {
    case 'CONFIRM':
      return { actionToken, kind: 'CONFIRM' };
    case 'SKIP':
      return effect.canSkipSelection === true ? { actionToken, kind: 'SKIP' } : null;
    case 'SELECT_CARD':
    case 'SELECT_SINGLE_FROM_MULTI': {
      const cardId =
        action.kind === 'SELECT_CARD'
          ? action.binding.selectedCardId
          : action.binding.selectedCardIds[0];
      const objectId = `${PUBLIC_OBJECT_ID_PREFIX}${cardId}`;
      const object = view.objects[objectId];
      if (
        effect.selectableObjectsFaceDown ||
        !effect.selectableObjectIds?.includes(objectId) ||
        object?.surface !== 'FRONT' ||
        !object.frontInfo
      ) {
        return null;
      }
      return {
        actionToken,
        kind: 'SELECT_CARD',
        card: buildAiCardObservationV2(object.frontInfo),
        ownerSeat: object.ownerSeat,
      };
    }
    case 'SELECT_SLOT':
      return effect.selectableSlots?.includes(action.binding.selectedSlot)
        ? { actionToken, kind: 'SELECT_SLOT', targetSlot: action.binding.selectedSlot }
        : null;
    case 'SELECT_OPTION': {
      const option = effect.selectableOptions?.find(
        (entry) => entry.id === action.binding.selectedOptionId
      );
      return option ? { actionToken, kind: 'SELECT_OPTION', label: option.label } : null;
    }
    case 'SELECT_EFFECT_OPTION': {
      const option = effect.effectChoice?.options.find(
        (entry) => entry.id === action.binding.selectedEffectOptionIds[0]
      );
      return option && option.selectable !== false
        ? { actionToken, kind: 'SELECT_EFFECT_OPTION', label: option.text }
        : null;
    }
  }
}

/**
 * 将服务端对 canonicalContext 计算的摘要绑定到最终 wire Frame。
 */
export function finalizeAiDecisionFrameV2(
  draft: AiDecisionFrameDraftV2,
  contextDigest: string
): AiDecisionFrameFinalizeResultV2 {
  if (!isValidBoundedString(contextDigest, MAX_CONTEXT_DIGEST_LENGTH)) {
    return { ok: false, reason: 'AI 决策上下文摘要格式无效' };
  }
  return {
    ok: true,
    frame: {
      request: {
        ...draft.request,
        contextDigest,
      },
      canonicalContext: draft.canonicalContext,
      mulliganCardIdByToken: draft.mulliganCardIdByToken,
      mainActionByToken: draft.mainActionByToken,
      effectActionByToken: draft.effectActionByToken,
      liveActionByToken: draft.liveActionByToken,
      effectCardSelection: draft.effectCardSelection,
      effectCardIdByToken: draft.effectCardIdByToken,
    },
  };
}

export function resolveAiDecisionV2(
  frame: AiDecisionFrameV2,
  decision: unknown
): AiDecisionResolutionV2 {
  if (!isRecord(decision)) {
    return { ok: false, reason: 'AI 决策不是有效对象' };
  }
  if (decision.schemaVersion !== AI_DECISION_SCHEMA_VERSION_V2) {
    return { ok: false, reason: 'AI 决策协议版本不支持' };
  }
  if (!isValidBoundedString(decision.decisionId, MAX_DECISION_ID_LENGTH)) {
    return { ok: false, reason: 'AI 决策令牌格式无效' };
  }
  if (decision.decisionId !== frame.request.decisionId) {
    return { ok: false, reason: '决策令牌与当前窗口不一致' };
  }
  if (!isValidBoundedString(decision.contextDigest, MAX_CONTEXT_DIGEST_LENGTH)) {
    return { ok: false, reason: 'AI 决策上下文摘要格式无效' };
  }
  if (decision.contextDigest !== frame.request.contextDigest) {
    return { ok: false, reason: 'AI 决策上下文与当前窗口不一致' };
  }
  if (decision.kind !== frame.request.window.kind) {
    return { ok: false, reason: '决策类型与当前窗口不一致' };
  }

  if (decision.kind === 'EFFECT_CARD_SELECTION') {
    const selection = frame.effectCardSelection;
    const window = frame.request.window;
    if (!selection || window.kind !== 'EFFECT_CARD_SELECTION')
      return { ok: false, reason: '当前没有多选声明绑定' };
    const baseKeys = ['schemaVersion', 'decisionId', 'contextDigest', 'kind', 'choice'];
    if (decision.choice === 'SKIP') {
      if (!hasExactOwnKeys(decision, baseKeys) || !selection.canSkip)
        return { ok: false, reason: '当前多选不能跳过或包含未支持字段' };
      return {
        ok: true,
        commandType: GameCommandType.CONFIRM_EFFECT_STEP,
        effectStep: { ...selection.binding, selectedCardId: null },
      };
    }
    if (
      decision.choice !== 'SELECT' ||
      !hasExactOwnKeys(decision, [...baseKeys, 'selectedCardTokens']) ||
      !Array.isArray(decision.selectedCardTokens) ||
      decision.selectedCardTokens.length < selection.minSelections ||
      decision.selectedCardTokens.length > selection.maxSelections ||
      decision.selectedCardTokens.length > MAX_AI_EFFECT_SELECTION_CARDS ||
      !decision.selectedCardTokens.every((token): token is string =>
        isValidBoundedString(token, MAX_CANDIDATE_TOKEN_LENGTH)
      ) ||
      new Set(decision.selectedCardTokens).size !== decision.selectedCardTokens.length
    )
      return { ok: false, reason: '多选声明的字段、数量或候选令牌无效' };
    const tokens = decision.selectedCardTokens;
    const selectedCardIds: string[] = [];
    for (const token of tokens) {
      const cardId = frame.effectCardIdByToken.get(token);
      if (!cardId) return { ok: false, reason: '多选声明包含未知候选' };
      selectedCardIds.push(cardId);
    }
    if (
      !matchesSelectionGroups(selectedCardIds, selection.groups, selection.distinctGroupAssignment)
    )
      return { ok: false, reason: '多选声明不满足当前分组约束' };
    if (
      window.rejectedSelections.some(
        (rejected) =>
          rejected.length === tokens.length &&
          rejected.every((token, index) => token === tokens[index])
      )
    )
      return { ok: false, reason: '当前局面下该有序选择已被拒绝' };
    return {
      ok: true,
      commandType: GameCommandType.CONFIRM_EFFECT_STEP,
      effectStep: { ...selection.binding, selectedCardIds },
    };
  }

  if (decision.kind === 'LIVE_ACTION') {
    if (
      !hasExactOwnKeys(decision, [
        'schemaVersion',
        'decisionId',
        'contextDigest',
        'kind',
        'selectedActionToken',
      ]) ||
      !isValidBoundedString(decision.selectedActionToken, MAX_CANDIDATE_TOKEN_LENGTH)
    ) {
      return { ok: false, reason: 'LIVE 决策包含未支持的字段或无效令牌' };
    }
    const action = frame.liveActionByToken.get(decision.selectedActionToken);
    if (!action) return { ok: false, reason: 'LIVE 决策包含未知候选' };
    return { ok: true, commandType: action.binding.type, liveAction: action.binding };
  }

  if (decision.kind === 'EFFECT_STEP') {
    if (
      !hasExactOwnKeys(decision, [
        'schemaVersion',
        'decisionId',
        'contextDigest',
        'kind',
        'selectedActionToken',
      ]) ||
      !isValidBoundedString(decision.selectedActionToken, MAX_CANDIDATE_TOKEN_LENGTH)
    ) {
      return { ok: false, reason: '卡效决策包含未支持的字段或无效令牌' };
    }
    const action = frame.effectActionByToken.get(decision.selectedActionToken);
    if (!action) {
      return { ok: false, reason: '卡效决策包含未知候选' };
    }
    return {
      ok: true,
      commandType: GameCommandType.CONFIRM_EFFECT_STEP,
      effectStep: action.binding,
    };
  }

  if (decision.kind === 'MULLIGAN') {
    if (
      !hasExactOwnKeys(decision, [
        'schemaVersion',
        'decisionId',
        'contextDigest',
        'kind',
        'selectedCardTokens',
      ])
    ) {
      return { ok: false, reason: '换牌决策包含未支持的字段' };
    }
    if (!Array.isArray(decision.selectedCardTokens)) {
      return { ok: false, reason: '换牌选择必须是候选令牌数组' };
    }
    const window = frame.request.window;
    if (window.kind !== 'MULLIGAN') {
      return { ok: false, reason: '决策类型与当前窗口不一致' };
    }
    if (
      decision.selectedCardTokens.length < window.minSelections ||
      decision.selectedCardTokens.length > window.maxSelections
    ) {
      return { ok: false, reason: '换牌选择数量不符合当前窗口约束' };
    }

    const selectedTokens: string[] = [];
    for (const token of decision.selectedCardTokens) {
      if (!isValidBoundedString(token, MAX_CANDIDATE_TOKEN_LENGTH)) {
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

  if (decision.kind !== 'MAIN_ACTION') {
    return { ok: false, reason: '决策类型与当前窗口不一致' };
  }
  if (
    !hasExactOwnKeys(decision, [
      'schemaVersion',
      'decisionId',
      'contextDigest',
      'kind',
      'selectedActionToken',
    ])
  ) {
    return { ok: false, reason: '主要阶段决策包含未支持的字段' };
  }
  if (!isValidBoundedString(decision.selectedActionToken, MAX_CANDIDATE_TOKEN_LENGTH)) {
    return { ok: false, reason: '主要阶段动作令牌格式无效' };
  }

  const action = frame.mainActionByToken.get(decision.selectedActionToken);
  if (!action) {
    return { ok: false, reason: '主要阶段决策包含未知候选' };
  }
  if (action.kind === 'END_PHASE') {
    return { ok: true, commandType: GameCommandType.END_PHASE };
  }
  if (action.kind === 'ACTIVATE_ABILITY') {
    return {
      ok: true,
      commandType: GameCommandType.ACTIVATE_ABILITY,
      cardId: action.binding.cardId,
      abilityId: action.binding.abilityId,
    };
  }
  return {
    ok: true,
    commandType: GameCommandType.PLAY_MEMBER_TO_SLOT,
    cardId: action.binding.cardId,
    targetSlot: action.binding.targetSlot,
    ...(action.playMode === 'SINGLE_RELAY' ? { relayMode: 'SINGLE' as const } : {}),
  };
}

interface AiHandProjectionEntryV2 {
  readonly index: number;
  readonly observation: AiHandCardObservationV2;
}

type AiSelfObservationBuildResultV2 =
  | {
      readonly ok: true;
      readonly observation: AiSelfObservationV2;
      readonly handByCardId: ReadonlyMap<string, AiHandProjectionEntryV2>;
    }
  | { readonly ok: false; readonly reason: string };

function buildAiSelfObservationV2(view: PlayerViewState): AiSelfObservationBuildResultV2 {
  const viewerSeat = view.match.viewerSeat;
  const handZoneKey = `${viewerSeat}_HAND` as ViewZoneKey;
  const handZone = view.table.zones[handZoneKey];
  if (!handZone?.objectIds || handZone.objectIds.length !== handZone.count) {
    return { ok: false, reason: '己方手牌投影不完整' };
  }

  const hand: AiHandCardObservationV2[] = [];
  const handByCardId = new Map<string, AiHandProjectionEntryV2>();
  for (const [index, publicObjectId] of handZone.objectIds.entries()) {
    const object = view.objects[publicObjectId];
    const cardId = decodePublicObjectId(publicObjectId);
    if (!object?.frontInfo || object.ownerSeat !== viewerSeat || !cardId) {
      return { ok: false, reason: '己方手牌候选缺少正面卡牌信息' };
    }
    if (handByCardId.has(cardId)) {
      return { ok: false, reason: '己方手牌投影包含重复对象' };
    }
    const observation: AiHandCardObservationV2 = {
      handToken: `hand-${index + 1}`,
      card: buildAiCardObservationV2(object.frontInfo),
    };
    hand.push(observation);
    handByCardId.set(cardId, { index, observation });
  }

  const boardBuild = buildAiBoardObservationV2(view, viewerSeat);
  if (!boardBuild.ok) return boardBuild;
  return {
    ok: true,
    observation: { hand, ...boardBuild.observation },
    handByCardId,
  };
}

function buildAiBoardObservationV2(
  view: PlayerViewState,
  viewerSeat: Seat
):
  | { readonly ok: true; readonly observation: Pick<AiSelfObservationV2, 'stage' | 'energy'> }
  | { readonly ok: false; readonly reason: string } {
  const stage: AiSelfObservationV2['stage'][number][] = [];
  for (const slot of AI_STAGE_SLOTS) {
    const zoneKey = `${viewerSeat}_MEMBER_${slot}` as ViewZoneKey;
    const zone = view.table.zones[zoneKey];
    const publicObjectId = zone?.slotMap?.[slot] ?? null;
    if (!zone || !zone.slotMap || !(slot in zone.slotMap)) {
      return { ok: false, reason: '己方成员区投影不完整' };
    }
    if (!publicObjectId) {
      stage.push({ slot, member: null });
      continue;
    }

    const object = view.objects[publicObjectId];
    const frontInfo = object?.frontInfo;
    if (
      !object ||
      object.ownerSeat !== viewerSeat ||
      object.surface !== 'FRONT' ||
      !frontInfo ||
      frontInfo.cardType !== CardType.MEMBER ||
      frontInfo.cost === undefined ||
      object.orientation === undefined
    ) {
      return { ok: false, reason: '己方成员区候选缺少正面卡牌信息' };
    }
    const effectiveCost = frontInfo.cost + (frontInfo.modifierDelta?.costDelta ?? 0);
    if (!Number.isInteger(effectiveCost) || effectiveCost < 0) {
      return { ok: false, reason: '己方成员区有效费用投影无效' };
    }
    stage.push({
      slot,
      member: {
        card: buildAiCardObservationV2(frontInfo),
        orientation: object.orientation,
        effectiveCost,
        enteredStageThisTurn: object.enteredStageThisTurn === true,
      },
    });
  }

  const energyZoneKey = `${viewerSeat}_ENERGY_ZONE` as ViewZoneKey;
  const energyZone = view.table.zones[energyZoneKey];
  if (!energyZone?.objectIds || energyZone.objectIds.length !== energyZone.count) {
    return { ok: false, reason: '己方能量区投影不完整' };
  }
  let activeEnergyCount = 0;
  for (const publicObjectId of energyZone.objectIds) {
    const object = view.objects[publicObjectId];
    if (!object || object.ownerSeat !== viewerSeat || object.orientation === undefined) {
      return { ok: false, reason: '己方能量区卡牌状态投影不完整' };
    }
    if (object.orientation === OrientationState.ACTIVE) {
      activeEnergyCount += 1;
    }
  }

  return {
    ok: true,
    observation: {
      stage,
      energy: {
        activeCount: activeEnergyCount,
        totalCount: energyZone.count,
      },
    },
  };
}

function buildAiLiveContextV2(
  view: PlayerViewState
):
  | { readonly ok: true; readonly observation: AiLiveContextV2 }
  | { readonly ok: false; readonly reason: string } {
  const result = view.match.liveResult;
  if (!result) return { ok: false, reason: 'LIVE 公开结果投影不完整' };
  const players: AiLiveContextV2['players'][number][] = [];
  for (const seat of ['FIRST', 'SECOND'] as const) {
    const board = buildAiBoardObservationV2(view, seat);
    if (!board.ok) return board;
    const zone = view.table.zones[`${seat}_LIVE_ZONE`];
    if (!zone?.objectIds || zone.objectIds.length !== zone.count) {
      return { ok: false, reason: 'LIVE 区域投影不完整' };
    }
    const liveCards: AiLiveCardObservationV2[] = [];
    for (const [index, objectId] of zone.objectIds.entries()) {
      const object = view.objects[objectId];
      if (!object || object.ownerSeat !== seat || object.faceState === undefined) {
        return { ok: false, reason: 'LIVE 卡牌投影不完整' };
      }
      const isVisible = object.surface === 'FRONT';
      if (isVisible && !object.frontInfo) {
        return { ok: false, reason: '可见 LIVE 卡牌缺少正面信息' };
      }
      const faceDown = object.faceState === FaceState.FACE_DOWN;
      // 双重限制：对手里侧牌即使投影意外附带 frontInfo，也不进入 AI 协议。
      const canExpose = isVisible && !(seat !== view.match.viewerSeat && faceDown);
      liveCards.push({
        liveToken: `live-${seat}-${index + 1}`,
        faceDown,
        card: canExpose ? buildAiCardObservationV2(object.frontInfo!) : null,
        ...(canExpose
          ? {
              judgmentResult: object.judgmentResult,
              scoreModifier: result.liveCardScoreModifiers[objectId] ?? 0,
              requirementReduction: result.requirementReductions[objectId] ?? 0,
              requirementModifiers: result.requirementModifiers[objectId]?.map((modifier) => ({
                color: modifier.color,
                countDelta: modifier.countDelta,
              })),
            }
          : {}),
      });
    }
    players.push({
      seat,
      ...board.observation,
      liveCards,
      score: result.scores[seat],
      scoreModifier: result.scoreModifiers[seat],
      heartBonuses: result.heartBonuses[seat].map((heart) => ({
        color: heart.color,
        count: heart.count,
      })),
    });
  }
  return {
    ok: true,
    observation: {
      players,
      winnerSeats: [...result.winnerSeats],
      confirmedSeats: [...result.confirmedSeats],
    },
  };
}

type NormalizedMainActionsBuildResult =
  | { readonly ok: true; readonly actions: readonly TrustedMainActionCandidateV2[] }
  | { readonly ok: false; readonly reason: string };

function normalizeAndSortTrustedMainActions(
  actions: readonly TrustedMainActionCandidateV2[],
  ownPlayerId: string,
  handByCardId: ReadonlyMap<string, AiHandProjectionEntryV2>,
  self: AiSelfObservationV2,
  commandAvailability: {
    readonly canEndPhase: boolean;
    readonly canPlayMember: boolean;
    readonly canActivateAbility: boolean;
  },
  view: PlayerViewState
): NormalizedMainActionsBuildResult {
  const normalized: TrustedMainActionCandidateV2[] = [];
  const semanticKeys = new Set<string>();
  const stageBySlot = new Map(self.stage.map((entry) => [entry.slot, entry.member] as const));

  for (const action of actions) {
    if (action.kind === 'END_PHASE') {
      if (
        !commandAvailability.canEndPhase ||
        action.binding.type !== GameCommandType.END_PHASE ||
        action.binding.playerId !== ownPlayerId
      ) {
        return { ok: false, reason: '结束主要阶段候选与当前权威窗口不一致' };
      }
      if (semanticKeys.has('END_PHASE')) {
        return { ok: false, reason: '权威主要阶段候选包含重复动作' };
      }
      semanticKeys.add('END_PHASE');
      normalized.push({
        kind: 'END_PHASE',
        binding: {
          type: GameCommandType.END_PHASE,
          playerId: ownPlayerId,
        },
      });
      continue;
    }

    if (action.kind === 'ACTIVATE_ABILITY') {
      const { binding, sourceSlot } = action;
      const objectId = `${PUBLIC_OBJECT_ID_PREFIX}${binding.cardId}`;
      const source = view.objects[objectId];
      const slotObjectId =
        view.table.zones[`${view.match.viewerSeat}_MEMBER_${sourceSlot}`]?.slotMap?.[sourceSlot];
      const config = source?.activatedAbilityUiConfigs?.find(
        (entry) => entry.abilityId === binding.abilityId && entry.abilityInstanceId === undefined
      );
      if (
        !commandAvailability.canActivateAbility ||
        binding.type !== GameCommandType.ACTIVATE_ABILITY ||
        binding.playerId !== ownPlayerId ||
        binding.abilityInstanceId !== undefined ||
        !AI_STAGE_SLOTS.includes(sourceSlot) ||
        slotObjectId !== objectId ||
        source?.ownerSeat !== view.match.viewerSeat ||
        source.surface !== 'FRONT' ||
        !stageBySlot.get(sourceSlot) ||
        !config
      ) {
        return { ok: false, reason: '起动能力候选与己方公开舞台不一致' };
      }
      const semanticKey = `ACTIVATE\u0000${binding.cardId}\u0000${binding.abilityId}`;
      if (semanticKeys.has(semanticKey)) {
        return { ok: false, reason: '权威主要阶段候选包含重复动作' };
      }
      semanticKeys.add(semanticKey);
      normalized.push({
        kind: 'ACTIVATE_ABILITY',
        sourceSlot,
        binding: {
          type: GameCommandType.ACTIVATE_ABILITY,
          playerId: ownPlayerId,
          cardId: binding.cardId,
          abilityId: binding.abilityId,
        },
      });
      continue;
    }
    if (action.kind !== 'PLAY_MEMBER_TO_SLOT') {
      return { ok: false, reason: '权威主要阶段候选类型不支持' };
    }
    const { binding, preview, playMode } = action;
    const handEntry = handByCardId.get(binding.cardId);
    const targetMember = stageBySlot.get(binding.targetSlot);
    if (
      !commandAvailability.canPlayMember ||
      binding.type !== GameCommandType.PLAY_MEMBER_TO_SLOT ||
      binding.playerId !== ownPlayerId ||
      !handEntry ||
      handEntry.observation.card.cardType !== CardType.MEMBER ||
      !AI_STAGE_SLOTS.includes(binding.targetSlot)
    ) {
      return { ok: false, reason: '成员登场候选与当前权威窗口不一致' };
    }
    const rawBinding = binding as unknown as Record<string, unknown>;
    if (rawBinding.freePlay !== undefined || rawBinding.relayReplacementSlots !== undefined) {
      return { ok: false, reason: 'AI 主要阶段候选不得使用自由登场或双换手' };
    }
    if (
      (playMode === 'EMPTY' && (targetMember !== null || binding.relayMode !== undefined)) ||
      (playMode === 'SINGLE_RELAY' && (targetMember === null || binding.relayMode !== 'SINGLE'))
    ) {
      return { ok: false, reason: '成员登场候选的成员区与换手语义不一致' };
    }
    if (!isValidPaymentPreview(preview, self.energy.activeCount, playMode)) {
      return { ok: false, reason: '成员登场候选的费用预览无效' };
    }
    if (
      handEntry.observation.card.cost !== undefined &&
      preview.printedCost !== handEntry.observation.card.cost
    ) {
      return { ok: false, reason: '成员登场候选的印刷费用与卡牌投影不一致' };
    }

    const semanticKey = `${binding.cardId}\u0000${binding.targetSlot}\u0000${playMode}`;
    if (semanticKeys.has(semanticKey)) {
      return { ok: false, reason: '权威主要阶段候选包含重复动作' };
    }
    semanticKeys.add(semanticKey);
    normalized.push({
      kind: 'PLAY_MEMBER_TO_SLOT',
      playMode,
      binding: {
        type: GameCommandType.PLAY_MEMBER_TO_SLOT,
        playerId: ownPlayerId,
        cardId: binding.cardId,
        targetSlot: binding.targetSlot,
        ...(playMode === 'SINGLE_RELAY' ? { relayMode: 'SINGLE' as const } : {}),
      },
      preview: {
        printedCost: preview.printedCost,
        modifiedCost: preview.modifiedCost,
        energyCost: preview.energyCost,
        relayDiscount: preview.relayDiscount,
      },
    });
  }

  normalized.sort((left, right) => {
    if (left.kind === 'END_PHASE') return right.kind === 'END_PHASE' ? 0 : -1;
    if (right.kind === 'END_PHASE') return 1;
    if (left.kind === 'ACTIVATE_ABILITY') {
      return right.kind === 'ACTIVATE_ABILITY'
        ? AI_STAGE_SLOTS.indexOf(left.sourceSlot) - AI_STAGE_SLOTS.indexOf(right.sourceSlot)
        : 1;
    }
    if (right.kind === 'ACTIVATE_ABILITY') return -1;
    const handDifference =
      (handByCardId.get(left.binding.cardId)?.index ?? Number.MAX_SAFE_INTEGER) -
      (handByCardId.get(right.binding.cardId)?.index ?? Number.MAX_SAFE_INTEGER);
    if (handDifference !== 0) return handDifference;
    return (
      AI_STAGE_SLOTS.indexOf(left.binding.targetSlot) -
      AI_STAGE_SLOTS.indexOf(right.binding.targetSlot)
    );
  });

  return { ok: true, actions: normalized };
}

function isValidPaymentPreview(
  preview: TrustedPlayMemberMainActionCandidateV2['preview'],
  activeEnergyCount: number,
  playMode: TrustedPlayMemberMainActionCandidateV2['playMode']
): boolean {
  const values = [
    preview.printedCost,
    preview.modifiedCost,
    preview.energyCost,
    preview.relayDiscount,
  ];
  if (values.some((value) => !Number.isInteger(value) || value < 0)) {
    return false;
  }
  if (preview.energyCost > activeEnergyCount) {
    return false;
  }
  if (playMode === 'EMPTY') {
    return preview.relayDiscount === 0 && preview.energyCost === preview.modifiedCost;
  }
  return preview.energyCost === Math.max(0, preview.modifiedCost - preview.relayDiscount);
}

function createAiDecisionFrameDraftV2(
  request: AiDecisionRequestDraftV2,
  bindings: Pick<
    AiDecisionFrameDraftV2,
    'mulliganCardIdByToken' | 'mainActionByToken' | 'effectActionByToken'
  > & {
    readonly liveActionByToken?: ReadonlyMap<string, LegalRulesLiveAction>;
    readonly effectCardSelection?: RulesEffectCardSelection;
    readonly effectCardIdByToken?: ReadonlyMap<string, string>;
  }
): AiDecisionFrameDraftV2 {
  return {
    request,
    canonicalContext: canonicalStringify({
      schemaVersion: request.schemaVersion,
      observation: request.observation,
      window: request.window,
    }),
    mulliganCardIdByToken: bindings.mulliganCardIdByToken,
    mainActionByToken: bindings.mainActionByToken,
    effectActionByToken: bindings.effectActionByToken,
    liveActionByToken: bindings.liveActionByToken ?? new Map(),
    effectCardSelection: bindings.effectCardSelection ?? null,
    effectCardIdByToken: bindings.effectCardIdByToken ?? new Map(),
  };
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}

function toCanonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonicalItem = toCanonicalJsonValue(item);
      return canonicalItem === undefined ? null : canonicalItem;
    });
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const canonicalValue = toCanonicalJsonValue(value[key]);
      if (canonicalValue !== undefined) {
        result[key] = canonicalValue;
      }
    }
    return result;
  }
  return undefined;
}

function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isValidBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
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

function buildAiCardObservationV2(frontInfo: ViewFrontCardInfo): AiCardObservationV2 {
  return {
    ...buildAiCardObservation(frontInfo),
    blade: frontInfo.blade,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
