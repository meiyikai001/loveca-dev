import type {
  AiDecisionProviderV2,
  AiDecisionRequestV2,
  AiDecisionV2,
} from '../../application/ai/ai-decision-contract.js';
import type { Seat } from '../../online/types.js';

export interface LocalInteractiveAiProviderOptions {
  readonly seat: Seat;
  /** Receives only this seat's already-redacted request, never a session or command binding. */
  readonly onRequest: (request: AiDecisionRequestV2) => void;
}

export interface LocalInteractiveSubmitResult {
  /** FORWARDED means delivered to the coordinator, not validated or executed by the engine. */
  readonly status:
    'FORWARDED' | 'NO_PENDING_DECISION' | 'STALE_DECISION' | 'INVALID_ENVELOPE' | 'CLOSED';
}

interface PendingDecision {
  readonly decisionId: string;
  readonly contextDigest: string;
  readonly kind: AiDecisionRequestV2['window']['kind'];
  finish(decision: AiDecisionV2 | null): void;
  fail(): void;
}

/**
 * One local process, one controlled seat, one outstanding decision. Transport-neutral:
 * no HTTP listener, account, API key, authority access, or buffering of future responses.
 * The original coordinator remains the only owner of semantic validation and execution.
 */
export class LocalInteractiveAiProvider implements AiDecisionProviderV2 {
  private readonly seat: Seat;
  private readonly onRequest: LocalInteractiveAiProviderOptions['onRequest'];
  private pending: PendingDecision | undefined;
  private closed = false;

  constructor(options: LocalInteractiveAiProviderOptions) {
    if (options.seat !== 'FIRST' && options.seat !== 'SECOND') {
      throw new Error('Invalid interactive seat');
    }
    this.seat = options.seat;
    this.onRequest = options.onRequest;
  }

  async decide(request: AiDecisionRequestV2, signal: AbortSignal): Promise<AiDecisionV2 | null> {
    if (this.closed || signal.aborted) return null;
    if (request.observation.match.viewerSeat !== this.seat) {
      throw new Error('Interactive provider seat mismatch');
    }
    if (this.pending) throw new Error('Interactive decision already pending');
    const snapshot = globalThis.structuredClone(request);
    return new Promise<AiDecisionV2 | null>((resolve, reject) => {
      const clear = () => {
        if (this.pending !== pending) return false;
        this.pending = undefined;
        signal.removeEventListener('abort', onAbort);
        return true;
      };
      const pending: PendingDecision = {
        decisionId: request.decisionId,
        contextDigest: request.contextDigest,
        kind: request.window.kind,
        finish: (decision) => {
          if (clear()) resolve(decision);
        },
        fail: () => {
          if (clear()) reject(new Error('Interactive request delivery failed'));
        },
      };
      const onAbort = () => pending.finish(null);
      this.pending = pending;
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.onRequest(snapshot);
      } catch {
        pending.fail();
      }
    });
  }

  submit(value: unknown): LocalInteractiveSubmitResult {
    if (this.closed) return { status: 'CLOSED' };
    const pending = this.pending;
    if (!pending) return { status: 'NO_PENDING_DECISION' };
    let snapshot: unknown;
    try {
      snapshot = globalThis.structuredClone(value);
    } catch {
      return { status: 'INVALID_ENVELOPE' };
    }
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      return { status: 'INVALID_ENVELOPE' };
    }
    const envelope = snapshot as Record<string, unknown>;
    if (
      envelope.schemaVersion !== 2 ||
      typeof envelope.decisionId !== 'string' ||
      envelope.decisionId.length === 0 ||
      typeof envelope.contextDigest !== 'string' ||
      envelope.contextDigest.length === 0 ||
      typeof envelope.kind !== 'string'
    ) {
      return { status: 'INVALID_ENVELOPE' };
    }
    if (
      envelope.decisionId !== pending.decisionId ||
      envelope.contextDigest !== pending.contextDigest ||
      envelope.kind !== pending.kind
    ) {
      return { status: 'STALE_DECISION' };
    }
    // This cast does NOT trust the action. Keep every submitted field for the coordinator's
    // existing unknown-input resolver to reject extra keys, invalid tokens and illegal shapes.
    pending.finish(snapshot as AiDecisionV2);
    return { status: 'FORWARDED' };
  }

  close(): void {
    this.closed = true;
    this.pending?.finish(null);
  }
}
