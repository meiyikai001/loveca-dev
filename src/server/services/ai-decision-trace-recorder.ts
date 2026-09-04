import { Buffer } from 'node:buffer';
import type {
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../application/ai/ai-decision-contract.js';
import type {
  AiDecisionFrameV2,
  AiDecisionResolutionV2,
  TrustedMainActionCandidateV2,
} from '../../application/ai/ai-decision-frame.js';
import { GameCommandType } from '../../application/game-commands.js';
import type { Seat } from '../../online/types.js';
import type { AiTurnStepResult } from './ai-turn-coordinator.js';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
type SuccessfulResolution = Extract<AiDecisionResolutionV2, { readonly ok: true }>;
type TraceResult = AiTurnStepResult | { readonly status: 'ERROR' };

export type AiDecisionTraceOutcome =
  | Pick<
      Extract<AiTurnStepResult, { readonly status: 'EXECUTED' }>,
      'status' | 'commandType' | 'resultingPublicSequence'
    >
  | { readonly status: Exclude<TraceResult['status'], 'EXECUTED'> };

export interface AiDecisionTraceRecord {
  readonly request: AiDecisionRequestV2;
  readonly validatedChoice: AiDecisionV2 | null;
  readonly outcome: AiDecisionTraceOutcome;
}

export interface AiSeatDecisionTrace {
  readonly schemaVersion: 1;
  readonly viewerSeat: Seat;
  readonly records: readonly AiDecisionTraceRecord[];
  readonly incomplete: boolean;
  readonly omittedRecords: number;
  readonly pendingRecords: number;
}

export interface AiDecisionTraceHandle {
  setChoice(frame: AiDecisionFrameV2, resolution: SuccessfulResolution): void;
  finish(result: TraceResult): void;
}

const OMITTED_HANDLE: AiDecisionTraceHandle = {
  setChoice() {},
  finish() {},
};

interface SeatRecords {
  readonly serializedRecords: string[];
  omitted: number;
  pending: number;
}

/**
 * Opt-in, local-only decision material. Never accepts authority state or provider responses.
 * Private snapshots stay seat-separated and share one UTF-8 serialized-payload budget.
 */
export class AiDecisionTraceRecorder {
  private readonly maxBytes: number;
  private bytes = 0;
  private captureIncomplete = false;
  private readonly seats: Record<Seat, SeatRecords> = {
    FIRST: { serializedRecords: [], omitted: 0, pending: 0 },
    SECOND: { serializedRecords: [], omitted: 0, pending: 0 },
  };

  constructor(options: { readonly maxBytes?: number } = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxBytes = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0;
    this.captureIncomplete = this.maxBytes !== maxBytes;
  }

  get incomplete(): boolean {
    return this.captureIncomplete;
  }

  begin(request: AiDecisionRequestV2): AiDecisionTraceHandle {
    let seat: Seat | undefined;
    try {
      seat = request.observation.match.viewerSeat;
      // The caller supplies a pristine, already-redacted request before invoking the provider.
      const snapshot = globalThis.structuredClone(request);
      const reservedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
      if (this.captureIncomplete || this.bytes + reservedBytes > this.maxBytes) {
        this.omit(seat);
        return OMITTED_HANDLE;
      }
      this.bytes += reservedBytes;
      const seatRecords = this.seats[seat];
      seatRecords.pending += 1;
      let finished = false;
      let validatedChoice: AiDecisionV2 | null = null;
      const discard = () => {
        finished = true;
        this.bytes -= reservedBytes;
        seatRecords.pending -= 1;
        this.omit(seat);
      };
      return {
        setChoice: (frame, resolution) => {
          if (finished || validatedChoice !== null) return;
          try {
            validatedChoice = reconstructChoice(snapshot, frame, resolution);
          } catch {
            discard();
          }
        },
        finish: (result) => {
          if (finished) return;
          try {
            const record: AiDecisionTraceRecord = {
              request: snapshot,
              validatedChoice,
              outcome: whitelistOutcome(result),
            };
            const serialized = JSON.stringify(record);
            const completedBytes = Buffer.byteLength(serialized, 'utf8');
            if (this.bytes - reservedBytes + completedBytes > this.maxBytes) {
              discard();
              return;
            }
            seatRecords.serializedRecords.push(serialized);
            this.bytes += completedBytes - reservedBytes;
            seatRecords.pending -= 1;
            finished = true;
          } catch {
            discard();
          }
        },
      };
    } catch {
      this.omit(seat);
      return OMITTED_HANDLE;
    }
  }

  /** Returned values are detached; neither consumers nor late providers can rewrite history. */
  getSeatTrace(seat: Seat): AiSeatDecisionTrace {
    const entries = this.seats[seat];
    return {
      schemaVersion: 1,
      viewerSeat: seat,
      records: entries.serializedRecords.map(
        (serialized) => JSON.parse(serialized) as AiDecisionTraceRecord
      ),
      incomplete: this.captureIncomplete || entries.pending > 0,
      omittedRecords: entries.omitted,
      pendingRecords: entries.pending,
    };
  }

  private omit(seat: Seat | undefined): void {
    this.captureIncomplete = true;
    if (seat === 'FIRST' || seat === 'SECOND') this.seats[seat].omitted += 1;
  }
}

function reconstructChoice(
  snapshot: AiDecisionRequestV2,
  frame: AiDecisionFrameV2,
  resolution: SuccessfulResolution
): AiDecisionV2 {
  if (
    snapshot.decisionId !== frame.request.decisionId ||
    snapshot.contextDigest !== frame.request.contextDigest ||
    snapshot.window.kind !== frame.request.window.kind ||
    snapshot.observation.match.viewerSeat !== frame.request.observation.match.viewerSeat
  )
    throw new Error('Trace frame mismatch');
  const base = {
    schemaVersion: snapshot.schemaVersion,
    decisionId: snapshot.decisionId,
    contextDigest: snapshot.contextDigest,
  };
  const window = snapshot.window;
  switch (window.kind) {
    case 'MULLIGAN': {
      if (resolution.commandType !== GameCommandType.MULLIGAN) break;
      const tokens = resolution.cardIdsToMulligan.map((id) =>
        findUniqueToken(frame.mulliganCardIdByToken, (value) => value === id)
      );
      if (!tokens.every((token) => window.candidates.some((entry) => entry.token === token))) break;
      return { ...base, kind: window.kind, selectedCardTokens: tokens };
    }
    case 'EFFECT_CARD_SELECTION': {
      if (resolution.commandType !== GameCommandType.CONFIRM_EFFECT_STEP) break;
      const binding = resolution.effectStep;
      if (binding.selectedCardId === null && window.canSkip) {
        return { ...base, kind: window.kind, choice: 'SKIP' };
      }
      if (!binding.selectedCardIds) break;
      const tokens = binding.selectedCardIds.map((id) =>
        findUniqueToken(frame.effectCardIdByToken, (value) => value === id)
      );
      if (!tokens.every((token) => window.candidates.some((entry) => entry.cardToken === token)))
        break;
      return { ...base, kind: window.kind, choice: 'SELECT', selectedCardTokens: tokens };
    }
    case 'EFFECT_STEP': {
      if (resolution.commandType !== GameCommandType.CONFIRM_EFFECT_STEP) break;
      const token = findUniqueToken(
        frame.effectActionByToken,
        (action) => action.binding === resolution.effectStep
      );
      if (!window.candidates.some((entry) => entry.actionToken === token)) break;
      return { ...base, kind: window.kind, selectedActionToken: token };
    }
    case 'LIVE_ACTION': {
      if (!('liveAction' in resolution)) break;
      const token = findUniqueToken(
        frame.liveActionByToken,
        (action) => action.binding === resolution.liveAction
      );
      if (!window.candidates.some((entry) => entry.actionToken === token)) break;
      return { ...base, kind: window.kind, selectedActionToken: token };
    }
    case 'MAIN_ACTION': {
      const token = findUniqueToken(frame.mainActionByToken, (action) =>
        matchesMainAction(action, resolution)
      );
      if (!window.candidates.some((entry) => entry.actionToken === token)) break;
      return { ...base, kind: window.kind, selectedActionToken: token };
    }
  }
  throw new Error('Trace choice could not be reconstructed');
}

function findUniqueToken<T>(
  entries: ReadonlyMap<string, T>,
  matches: (value: T) => boolean
): string {
  let found: string | undefined;
  for (const [token, value] of entries) {
    if (!matches(value)) continue;
    if (found !== undefined) throw new Error('Trace choice is ambiguous');
    found = token;
  }
  if (found === undefined) throw new Error('Trace choice is missing');
  return found;
}

function matchesMainAction(
  action: TrustedMainActionCandidateV2,
  resolution: SuccessfulResolution
): boolean {
  switch (action.kind) {
    case 'END_PHASE':
      return resolution.commandType === GameCommandType.END_PHASE;
    case 'ACTIVATE_ABILITY':
      return (
        resolution.commandType === GameCommandType.ACTIVATE_ABILITY &&
        action.binding.cardId === resolution.cardId &&
        action.binding.abilityId === resolution.abilityId
      );
    case 'PLAY_MEMBER_TO_SLOT':
      return (
        resolution.commandType === GameCommandType.PLAY_MEMBER_TO_SLOT &&
        action.binding.cardId === resolution.cardId &&
        action.binding.targetSlot === resolution.targetSlot &&
        (action.playMode === 'SINGLE_RELAY' ? 'SINGLE' : undefined) === resolution.relayMode
      );
  }
}

function whitelistOutcome(result: TraceResult): AiDecisionTraceOutcome {
  switch (result.status) {
    case 'EXECUTED':
      return {
        status: 'EXECUTED',
        commandType: result.commandType,
        resultingPublicSequence: result.resultingPublicSequence,
      };
    case 'UNAVAILABLE':
    case 'NO_DECISION':
    case 'STALE':
    case 'REJECTED':
    case 'ABORTED':
    case 'TIMEOUT':
    case 'PROVIDER_ERROR':
    case 'ERROR':
      return { status: result.status };
    default:
      throw new Error('Trace outcome is unsupported');
  }
}
