import { describe, it } from 'vitest';

// Offline tests for incremental aggregation: scoping to the current crawl,
// column-name alignment across report versions and per-URL dedup.
describe('aggregateCSVReports (incremental)', () => {
  it.todo('only includes reports for URLs found by the current crawl');
  it.todo('keeps one row per requested URL, taking the newer report on duplicates');
  it.todo('aligns historical columns by name, dropping missing and blanking added columns');
  it.todo('writes headers from the newest usable report when every page was reused');
  it.todo('fills a failed current run with the historical report for the same URL');
  it.todo('still writes an aggregation when no page was run fresh');
});
