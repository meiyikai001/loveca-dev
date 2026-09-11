import type { AdminMatchRecordFilters } from './onlineClient';

export function parseDateInputStart(value: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

export function parseDateInputEnd(value: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(`${value}T23:59:59.999`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

export function buildMatchRecordFilters(input: {
  userQuery: string;
  playerAQuery: string;
  playerBQuery: string;
  dateFrom: string;
  dateTo: string;
  activity: string;
}): AdminMatchRecordFilters {
  const startedFrom = parseDateInputStart(input.dateFrom);
  const startedTo = parseDateInputEnd(input.dateTo);
  return {
    ...(input.userQuery.trim() ? { userQuery: input.userQuery.trim() } : {}),
    ...(input.playerAQuery.trim() ? { playerAQuery: input.playerAQuery.trim() } : {}),
    ...(input.playerBQuery.trim() ? { playerBQuery: input.playerBQuery.trim() } : {}),
    ...(startedFrom !== null ? { startedFrom } : {}),
    ...(startedTo !== null ? { startedTo } : {}),
    ...(input.activity.startsWith('ranked:') ? { rankedSeasonId: input.activity.slice(7) } : {}),
    ...(input.activity.startsWith('theme:')
      ? { themeTableVersionId: input.activity.slice(6) }
      : {}),
  };
}
