import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { DeckClassifierMatchCandidateView } from '@game/online/deck-classifier-types';
import type { Seat } from '@game/online';
import { ActionButton } from '@/components/common';
import {
  AdminMatchRecordFiltersPanel,
  type AdminActivityFilterOption,
} from '@/components/common/AdminMatchRecordFiltersPanel';
import { useDialogAccessibility } from '@/hooks/useDialogAccessibility';
import { fetchDeckClassifierMatchCandidates } from '@/lib/deckClassifierAdminClient';
import { fetchRankedSeasons } from '@/lib/rankedAdminClient';
import { buildMatchRecordFilters } from '@/lib/matchRecordFilters';
import type { AdminMatchRecordFilters } from '@/lib/onlineClient';
import type { DeckClassifierTemplateImportSource } from './DeckClassifierAdminPage';

const EMPTY_FILTERS = {
  userQuery: '',
  playerAQuery: '',
  playerBQuery: '',
  dateFrom: '',
  dateTo: '',
  activity: '',
};
export function candidateOriginLabel(record: DeckClassifierMatchCandidateView): string {
  return record.activityName || '排位';
}
export function formatCandidateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
export function candidateImportSource(
  record: DeckClassifierMatchCandidateView,
  seat: Seat
): DeckClassifierTemplateImportSource {
  const player = record.participants?.find((entry) => entry.seat === seat);
  return {
    matchId: record.matchId,
    seat,
    name: `${player?.displayName || player?.userId || '玩家'} · ${formatCandidateTime(record.startedAt)} · ${seat === 'FIRST' ? '先攻' : '后攻'}`.slice(
      0,
      120
    ),
    note: '',
  };
}

export function DeckClassifierMatchPicker({
  isOpen,
  onClose,
  onSelect,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (
    record: DeckClassifierMatchCandidateView,
    source: DeckClassifierTemplateImportSource
  ) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogAccessibility({ isOpen, dialogRef, initialFocusRef: closeRef, onEscape: onClose });
  const [draft, setDraft] = useState(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AdminMatchRecordFilters>({});
  const [records, setRecords] = useState<readonly DeckClassifierMatchCandidateView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedOffset, setFailedOffset] = useState(0);
  const [seasons, setSeasons] = useState<readonly AdminActivityFilterOption[]>([]);
  const [seasonsError, setSeasonsError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);
  const seasonControllerRef = useRef<AbortController | null>(null);

  const loadSeasons = useCallback(async () => {
    seasonControllerRef.current?.abort();
    const controller = new AbortController();
    seasonControllerRef.current = controller;
    const signal = controller.signal;
    setSeasonsError(null);
    try {
      const ranked = await fetchRankedSeasons();
      if (signal.aborted) return;
      setSeasons(ranked.map((season) => ({ value: `ranked:${season.id}`, label: season.name })));
    } catch (failure) {
      if (!signal.aborted)
        setSeasonsError(failure instanceof Error ? failure.message : '读取赛季失败');
    }
  }, []);

  const load = useCallback(async (query: AdminMatchRecordFilters, offset: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    setFailedOffset(offset);
    if (offset === 0) {
      setRecords([]);
      setHasMore(false);
    }
    try {
      const page = await fetchDeckClassifierMatchCandidates(query, offset, controller.signal);
      if (requestId !== requestRef.current || controller.signal.aborted) return;
      setRecords((current) => (offset === 0 ? page.items : [...current, ...page.items]));
      setHasMore(page.hasMore);
    } catch (failure) {
      if (requestId === requestRef.current && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : '读取对局失败');
      }
    } finally {
      if (requestId === requestRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => void loadSeasons(), 0);
    return () => {
      window.clearTimeout(timer);
      seasonControllerRef.current?.abort();
    };
  }, [isOpen, loadSeasons]);
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => void load(filters, 0), 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
      requestRef.current += 1;
    };
  }, [isOpen, filters, load]);

  if (!isOpen) return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 sm:p-5">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-match-picker-title"
        tabIndex={-1}
        className="modal-surface flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden rounded-none sm:h-auto sm:max-h-[90dvh] sm:max-w-5xl sm:rounded-xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border-subtle)] p-4">
          <h2 id="template-match-picker-title" className="font-semibold">
            从历史对局选择
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="button-icon"
            aria-label="关闭对局选择"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 overflow-y-auto sm:grid-cols-[300px_minmax(0,1fr)] sm:overflow-hidden">
          <div className="px-3 sm:overflow-y-auto sm:px-4">
            <AdminMatchRecordFiltersPanel
              {...draft}
              rankedOnly
              activityOptions={seasons}
              activityOptionsError={seasonsError}
              appliedFilterCount={Object.keys(filters).length}
              disabled={false}
              onUserQueryChange={(value) => setDraft({ ...draft, userQuery: value })}
              onPlayerAQueryChange={(value) => setDraft({ ...draft, playerAQuery: value })}
              onPlayerBQueryChange={(value) => setDraft({ ...draft, playerBQuery: value })}
              onDateFromChange={(value) => setDraft({ ...draft, dateFrom: value })}
              onDateToChange={(value) => setDraft({ ...draft, dateTo: value })}
              onActivityChange={(value) => setDraft({ ...draft, activity: value })}
              onApply={() => setFilters(buildMatchRecordFilters(draft))}
              onReset={() => {
                setDraft(EMPTY_FILTERS);
                setFilters({});
              }}
            />
            {seasonsError ? (
              <ActionButton type="button" variant="ghost" onClick={() => void loadSeasons()}>
                重试赛季列表
              </ActionButton>
            ) : null}
          </div>
          <div className="space-y-3 p-4 sm:overflow-y-auto" aria-busy={loading}>
            <p className="text-xs text-[var(--text-muted)]">
              仅显示已结束的排位对局。选择要导入的玩家席位，返回表单核对后导入。
            </p>
            {records.map((record) => (
              <article
                key={record.matchId}
                className="space-y-2 rounded-lg border border-[var(--border-subtle)] p-3"
              >
                <div className="break-words text-sm font-semibold">
                  {candidateOriginLabel(record)} · {formatCandidateTime(record.startedAt)}
                </div>
                <div className="grid gap-2 lg:grid-cols-2">
                  {(['FIRST', 'SECOND'] as const).map((seat) => {
                    const player = record.participants?.find((entry) => entry.seat === seat);
                    const available = record.importableSeats.includes(seat);
                    const deckName = record.deckNamesBySeat[seat]?.trim() || '卡组名称未记录';
                    return (
                      <div key={seat} className="min-w-0 space-y-1">
                        <ActionButton
                          type="button"
                          variant="secondary"
                          size="compact"
                          className="h-auto min-h-10 w-full whitespace-normal break-words"
                          disabled={!available || loading}
                          onClick={() => onSelect(record, candidateImportSource(record, seat))}
                        >
                          {seat === 'FIRST' ? '先攻' : '后攻'} ·{' '}
                          {player?.displayName || player?.userId || '玩家'}
                        </ActionButton>
                        <p className="flex min-w-0 gap-1 text-xs text-[var(--text-muted)]">
                          <span className="shrink-0">
                            {record.winnerSeat
                              ? record.winnerSeat === seat
                                ? '胜'
                                : '负'
                              : '无胜负结果'}{' '}
                            ·
                          </span>
                          <span className="truncate" title={deckName}>
                            {deckName}
                          </span>
                        </p>
                        {!available ? (
                          <p className="text-xs text-[var(--text-muted)]">
                            缺少长期卡组记录，无法选择
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
            {loading ? <p role="status">正在读取对局…</p> : null}
            {error ? (
              <div role="alert" className="space-y-2 text-[var(--semantic-error)]">
                <p>{error}</p>
                <ActionButton
                  type="button"
                  variant="secondary"
                  onClick={() => void load(filters, failedOffset)}
                >
                  重试
                </ActionButton>
              </div>
            ) : null}
            {!loading && !error && records.length === 0 ? (
              <p>没有符合条件的对局，请调整筛选。</p>
            ) : null}
            {hasMore && !error ? (
              <ActionButton
                type="button"
                variant="secondary"
                disabled={loading}
                onClick={() => void load(filters, records.length)}
              >
                加载更多
              </ActionButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
