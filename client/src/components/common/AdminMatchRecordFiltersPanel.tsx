import { AlertTriangle, CalendarDays, Filter, Search } from 'lucide-react';
import { ActionButton, SelectMenu } from '@/components/common';

export interface AdminActivityFilterOption {
  readonly value: string;
  readonly label: string;
}

export function AdminMatchRecordFiltersPanel({
  userQuery,
  playerAQuery,
  playerBQuery,
  onPlayerAQueryChange,
  onPlayerBQueryChange,
  rankedOnly = false,
  dateFrom,
  dateTo,
  activity,
  activityOptions,
  activityOptionsError,
  appliedFilterCount,
  onUserQueryChange,
  onDateFromChange,
  onDateToChange,
  onActivityChange,
  onApply,
  onReset,
  disabled,
}: {
  userQuery: string;
  playerAQuery: string;
  playerBQuery: string;
  onPlayerAQueryChange: (value: string) => void;
  onPlayerBQueryChange: (value: string) => void;
  rankedOnly?: boolean;
  dateFrom: string;
  dateTo: string;
  activity: string;
  activityOptions: readonly AdminActivityFilterOption[];
  activityOptionsError: string | null;
  appliedFilterCount: number;
  onUserQueryChange: (value: string) => void;
  onDateFromChange: (value: string) => void;
  onDateToChange: (value: string) => void;
  onActivityChange: (value: string) => void;
  onApply: () => void;
  onReset: () => void;
  disabled: boolean;
}) {
  const hasFilterValue = Boolean(
    activity ||
    userQuery.trim() ||
    playerAQuery.trim() ||
    playerBQuery.trim() ||
    dateFrom ||
    dateTo ||
    appliedFilterCount > 0
  );

  return (
    <form
      className="-mx-3 mt-3 border-y border-[var(--border-subtle)] bg-[color:color-mix(in_srgb,var(--bg-elevated)_52%,var(--bg-surface))] px-3 py-3 sm:-mx-4 sm:px-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onApply();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[var(--text-primary)]">
          <Filter size={14} aria-hidden="true" className="shrink-0 text-[var(--accent-primary)]" />
          <h3 className="truncate text-xs font-semibold">筛选对局</h3>
        </div>
        <span
          className={`shrink-0 text-[11px] font-medium ${
            appliedFilterCount > 0 ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'
          }`}
        >
          {appliedFilterCount > 0 ? `${appliedFilterCount} 项生效` : '全部记录'}
        </span>
      </div>

      <div className="mt-2.5 grid gap-2.5">
        <SelectMenu
          label={rankedOnly ? '按排位赛季筛选' : '按所属活动筛选'}
          value={activity}
          options={[{ value: '', label: rankedOnly ? '全部赛季' : '全部活动' }, ...activityOptions]}
          onChange={onActivityChange}
          disabled={disabled}
          className="w-full shadow-none"
        />

        {activityOptionsError ? (
          <p
            className="flex items-start gap-1.5 rounded-lg border border-[color:color-mix(in_srgb,var(--semantic-warning)_25%,var(--border-subtle))] bg-[color:color-mix(in_srgb,var(--semantic-warning)_7%,transparent)] px-2.5 py-2 text-[11px] leading-4 text-[var(--semantic-warning)]"
            role="status"
          >
            <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{activityOptionsError}</span>
          </p>
        ) : null}

        <label className="relative block">
          <span className="sr-only">搜索参与者或对局</span>
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
          />
          <input
            value={userQuery}
            onChange={(event) => onUserQueryChange(event.target.value)}
            type="search"
            autoComplete="off"
            maxLength={120}
            className="input-field h-10 pl-9 pr-3 text-sm"
            placeholder="用户名、房间号或对局 ID"
          />
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1 text-xs">
            玩家 A
            <input
              className="input-field h-10 min-w-0"
              type="search"
              maxLength={120}
              placeholder="显示名或用户 ID"
              value={playerAQuery}
              onChange={(event) => onPlayerAQueryChange(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            玩家 B
            <input
              className="input-field h-10 min-w-0"
              type="search"
              maxLength={120}
              placeholder="显示名或用户 ID"
              value={playerBQuery}
              onChange={(event) => onPlayerBQueryChange(event.target.value)}
            />
          </label>
        </div>
        <fieldset className="grid gap-1.5">
          <legend className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-muted)]">
            <CalendarDays size={13} aria-hidden="true" />
            开局日期
          </legend>
          <div className="grid grid-cols-2 gap-2">
            <label className="grid min-w-0 gap-1 text-[10px] text-[var(--text-muted)]">
              开始
              <input
                value={dateFrom}
                onChange={(event) => onDateFromChange(event.target.value)}
                type="date"
                max={dateTo || undefined}
                className="input-field h-10 min-w-0 px-2 text-[11px]"
              />
            </label>
            <label className="grid min-w-0 gap-1 text-[10px] text-[var(--text-muted)]">
              结束
              <input
                value={dateTo}
                onChange={(event) => onDateToChange(event.target.value)}
                type="date"
                min={dateFrom || undefined}
                className="input-field h-10 min-w-0 px-2 text-[11px]"
              />
            </label>
          </div>
        </fieldset>
      </div>

      <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-2">
        <ActionButton
          type="button"
          variant="ghost"
          size="compact"
          onClick={onReset}
          disabled={disabled || !hasFilterValue}
          className="border border-[var(--border-default)]"
        >
          清空
        </ActionButton>
        <ActionButton type="submit" size="compact" disabled={disabled}>
          <Search size={14} aria-hidden="true" />
          查询
        </ActionButton>
      </div>
    </form>
  );
}
