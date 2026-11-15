import { describe, it } from 'vitest';

// Offline tests for the report inventory module. No network, no Chrome:
// reports are plain CSV files written into temporary directories.
describe('buildReportInventory', () => {
  it.todo('indexes usable reports by the requested URL recorded inside them');
  it.todo('picks the newest report when one URL has several history files');
  it.todo('lists unreadable files with their file name instead of covering the URL');
  it.todo('resolves to an empty inventory for a missing or empty reports directory');
  it.todo('does not treat file names as the source of the requested URL');
});
