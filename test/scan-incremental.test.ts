import { describe, it } from 'vitest';

// Offline tests for the reuse decisions made while orchestrating a scan.
// The crawler and Lighthouse are both faked, so no network or Chrome is used.
describe('scan incremental behavior', () => {
  it.todo('reuses a page whose requested URL already has a usable report');
  it.todo('runs Lighthouse for a page with no usable report');
  it.todo('re-runs a page whose only existing report is unreadable and warns with the file name');
  it.todo('forces a full run, ignoring the inventory, when force is set');
  it.todo('falls back to the historical report when a forced run fails for a covered URL');
  it.todo('always re-emits urlFound, even when the report is reused');
});
