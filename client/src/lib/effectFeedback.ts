import type {
  EffectFeedbackPublicEvent,
  EffectFeedbackTarget,
  PlayerViewState,
  PublicEvent,
} from '@game/online';
import type { BattleAnimationAnchorMaps, BattleAnimationRect } from './battleAnimationEvents';

export const EFFECT_FEEDBACK_DURATION_MS = 1250;
export const EFFECT_FEEDBACK_STEP_MS = 100;
export const EFFECT_FEEDBACK_MAX_BATCH = 8;

export interface EffectFeedbackCursor {
  readonly context: string;
  readonly floor: number;
  readonly latest: number;
  readonly seen: readonly { id: string; seq: number }[];
}

/** Initial attachment, rollback, seat switch and recovery epochs establish a fresh floor. */
export function consumeEffectFeedback(
  cursor: EffectFeedbackCursor | null,
  input: { readonly context: string; readonly seq: number; readonly events: readonly PublicEvent[] }
): { cursor: EffectFeedbackCursor; events: readonly EffectFeedbackPublicEvent[]; reset: boolean } {
  if (!cursor || cursor.context !== input.context || input.seq < cursor.latest) {
    return {
      cursor: { context: input.context, floor: input.seq, latest: input.seq, seen: [] },
      events: [],
      reset: true,
    };
  }
  const seen = new Map(cursor.seen.map((entry) => [entry.id, entry.seq]));
  const events: EffectFeedbackPublicEvent[] = [];
  for (const event of [...input.events].sort((a, b) => a.seq - b.seq)) {
    if (
      event.type !== 'EffectFeedback' ||
      event.seq <= cursor.floor ||
      event.seq > input.seq ||
      seen.has(event.eventId)
    )
      continue;
    seen.set(event.eventId, event.seq);
    events.push(event);
  }
  const entries = [...seen].map(([id, seq]) => ({ id, seq })).sort((a, b) => a.seq - b.seq);
  const droppedFloor = entries.length > 256 ? entries[entries.length - 257]!.seq : cursor.floor;
  return {
    cursor: {
      ...cursor,
      floor: Math.max(cursor.floor, droppedFloor),
      latest: input.seq,
      seen: entries.slice(-256),
    },
    events: events.slice(-EFFECT_FEEDBACK_MAX_BATCH),
    reset: false,
  };
}

export interface PositionedEffectFeedback {
  readonly id: string;
  readonly mode: EffectFeedbackPublicEvent['mode'];
  readonly sourceRect?: BattleAnimationRect;
  readonly targets: readonly {
    readonly rect: BattleAnimationRect;
    readonly objectId?: string;
    readonly changes: EffectFeedbackTarget['changes'];
  }[];
}

export function positionEffectFeedback(
  event: EffectFeedbackPublicEvent,
  view: PlayerViewState,
  anchors: BattleAnimationAnchorMaps
): PositionedEffectFeedback | null {
  const sourceRect =
    event.sourceObjectId && view.objects[event.sourceObjectId]?.surface === 'FRONT'
      ? anchors.cards.get(event.sourceObjectId)
      : undefined;
  const targets = event.targets.flatMap((target) => {
    const zone = view.table.zones[target.zoneKey];
    if (!zone) return [];
    if (target.objectId) {
      const currentIds = [...(zone.objectIds ?? []), ...Object.values(zone.slotMap ?? {})];
      if (
        !currentIds.includes(target.objectId) ||
        view.objects[target.objectId]?.surface !== 'FRONT'
      )
        return [];
    }
    const seat = zone.ownerSeat;
    const memberSlot = target.zoneKey.match(/_MEMBER_(LEFT|CENTER|RIGHT)$/)?.[1];
    const suffix = memberSlot
      ? `slot-${memberSlot}`
      : target.zoneKey.endsWith('_ENERGY_ZONE')
        ? 'energy-zone'
        : 'live-zone';
    const rect =
      (target.objectId ? anchors.cards.get(target.objectId) : undefined) ??
      anchors.zones.get(`seat-${seat}::${suffix}`);
    return rect && rect.width > 0 && rect.height > 0
      ? [{ rect, objectId: target.objectId, changes: target.changes }]
      : [];
  });
  if (!sourceRect && targets.length === 0) return null;
  return { id: event.eventId, mode: event.mode, ...(sourceRect ? { sourceRect } : {}), targets };
}

/** Pending abilities and payment state changes never use the benefit light. */
export function hasEffectFeedbackGlow(
  mode: EffectFeedbackPublicEvent['mode'],
  changes: EffectFeedbackTarget['changes']
): boolean {
  return (
    mode === 'APPLIED' &&
    changes.some(
      (change) =>
        (change.kind === 'HEART' ||
          change.kind === 'BLADE' ||
          change.kind === 'SCORE' ||
          change.kind === 'REQUIREMENT') &&
        change.delta !== 0
    )
  );
}
