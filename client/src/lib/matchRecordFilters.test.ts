import { describe, expect, it } from 'vitest';
import { buildMatchRecordFilters } from './matchRecordFilters';
import { buildAdminMatchRecordSearch } from './onlineClient';

const EMPTY = {
  userQuery: '',
  playerAQuery: '',
  playerBQuery: '',
  dateFrom: '',
  dateTo: '',
  activity: '',
};
describe('shared history filters', () => {
  it('serializes both participant conditions with inclusive local date boundaries', () => {
    const filters = buildMatchRecordFilters({
      ...EMPTY,
      playerAQuery: ' Alpha ',
      playerBQuery: 'Beta',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-06',
      activity: 'ranked:season-1',
      userQuery: ' R_1 ',
    });
    const query = new URLSearchParams(buildAdminMatchRecordSearch(filters));
    expect(Object.fromEntries(query)).toEqual({
      userQuery: 'R_1',
      playerAQuery: 'Alpha',
      playerBQuery: 'Beta',
      rankedSeasonId: 'season-1',
      startedFrom: String(new Date(2026, 8, 1, 0, 0, 0, 0).getTime()),
      startedTo: String(new Date(2026, 8, 6, 23, 59, 59, 999).getTime()),
    });
  });
  it('retains the history page theme filter and omits empty or invalid values', () => {
    expect(
      buildMatchRecordFilters({
        ...EMPTY,
        activity: 'theme:event-1',
        playerBQuery: '  Beta ',
        dateFrom: 'invalid',
      })
    ).toEqual({ themeTableVersionId: 'event-1', playerBQuery: 'Beta' });
    expect(buildMatchRecordFilters(EMPTY)).toEqual({});
  });
});
