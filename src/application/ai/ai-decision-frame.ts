import { GameCommandType } from '../game-commands.js';
import type { PlayerViewState, ViewFrontCardInfo, ViewZoneKey } from '../../online/types.js';
import { CardType, HeartColor, OrientationState, SlotPosition } from '../../shared/types/enums.js';
import {
  AI_DECISION_SCHEMA_VERSION,
  AI_DECISION_SCHEMA_VERSION_V2,
  type AiCardObservationV1,
  type AiCardObservationV2,
  type AiDecisionRequestDraftV2,
  type AiDecisionRequestV2,
  type AiDecisionRequestV1,
  type AiHandCardObservationV2,
  type AiMainActionCandidateV2,
  type AiMainActionObservationV2,
  type AiMulliganCandidate,
  type AiObservationV1,
  type AiSelfObservationV2,
} from './ai-decision-contract.js';

const PUBLIC_OBJECT_ID_PREFIX = 'obj_';
const MAX_DECISION_ID_LENGTH = 256;
const MAX_CANDIDATE_TOKEN_LENGTH = 128;
const MAX_CONTEXT_DIGEST_LENGTH = 256;
// 一副主卡组至多 60 张；即使全部成员同时在手，3 个槽位加 END 也不超过 181。
const MAX_MAIN_ACTION_CANDIDATES = 256;
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
  TrustedEndPhaseMainActionCandidateV2 | TrustedPlayMemberMainActionCandidateV2;

export interface AiDecisionFrameDraftV2 {
  readonly request: AiDecisionRequestDraftV2;
  /**
   * 不包含 decisionId、contextDigest 或 trusted binding 的规范 JSON。
   * 服务端可在 Node 边界对它计算 SHA-256。
   */
  readonly canonicalContext: string;
  readonly mulliganCardIdByToken: ReadonlyMap<string, string>;
  readonly mainActionByToken: ReadonlyMap<string, TrustedMainActionCandidateV2>;
}

export interface AiDecisionFrameV2 {
  readonly request: AiDecisionRequestV2;
  readonly canonicalContext: string;
  readonly mulliganCardIdByToken: ReadonlyMap<string, string>;
  readonly mainActionByToken: ReadonlyMap<string, TrustedMainActionCandidateV2>;
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
 * 在主要阶段只接受权威枚举器已经确认合法的完整动作。
 */
export function buildAiDecisionFrameV2(
  view: PlayerViewState,
  decisionId: string,
  trustedMainActions: readonly TrustedMainActionCandidateV2[] = []
): AiDecisionFrameDraftBuildResultV2 {
  if (!isValidBoundedString(decisionId, MAX_DECISION_ID_LENGTH)) {
    return { ok: false, reason: 'AI 决策令牌格式无效' };
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
  };
  const normalizedBuild = normalizeAndSortTrustedMainActions(
    trustedMainActions,
    ownPlayerId,
    selfBuild.handByCardId,
    selfBuild.observation,
    commandAvailability
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
    }),
  };
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
      hand,
      stage,
      energy: {
        activeCount: activeEnergyCount,
        totalCount: energyZone.count,
      },
    },
    handByCardId,
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
  }
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
  bindings: Pick<AiDecisionFrameDraftV2, 'mulliganCardIdByToken' | 'mainActionByToken'>
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
