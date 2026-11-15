import process from 'node:process';

import { expect, test, vi } from 'vitest';

import { createFakeCrawler } from '../src/crawl.mock.js';
import { createEmitter } from '../src/emitter.js';
import type { LighthouseEvents } from '../src/lighthouse.js';
import type {
  ReportInventory,
  ReportRecord,
} from '../src/report-inventory.js';
import { type ScanEvents, scan } from '../src/scan-task.js';

// Deliberately process.nextTick rather than queueMicrotask. The emitter
// dispatches handlers via Promise.resolve().then(), so this helper has to
// yield past that microtask queue rather than joining the back of it.
const nextTick = async () =>
  new Promise((resolve) => process.nextTick(resolve));

const makeRecord = (
  requestedUrl: string,
  overrides: Partial<ReportRecord> = {},
): ReportRecord => ({
  fileName: `history-${requestedUrl.replaceAll(/[^a-z]/gi, '')}.csv`,
  filePath: `/tmp/reports/history-${requestedUrl.replaceAll(/[^a-z]/gi, '')}.csv`,
  requestedUrl,
  headers: ['Requested URL', 'Final URL'],
  row: { 'Requested URL': requestedUrl, 'Final URL': requestedUrl },
  modifiedMs: 1_000_000,
  ...overrides,
});

const inventoryWith = (
  records: ReportRecord[],
  unreadable: ReportInventory['unreadable'] = [],
): ReportInventory => ({
  reportsByUrl: new Map(records.map((record) => [record.requestedUrl, record])),
  unreadable,
});

const baseOptions = {
  ignoreRobotsTxt: false,
  includePathGlob: [],
  excludePathGlob: [],
  lighthouseConcurrency: 1,
};

test('reuses a page whose requested URL already has a usable report', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouse = vi.fn(() => {
    throw new Error('Lighthouse should not start for a covered URL');
  });

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    reportInventory: inventoryWith([makeRecord('https://example.com/a')]),
  });

  const onReportReused = vi.fn<ScanEvents['reportReused']>();
  emitter.on('reportReused', onReportReused);
  const onReportBegin = vi.fn<ScanEvents['reportBegin']>();
  emitter.on('reportBegin', onReportBegin);
  const onUrlFound = vi.fn<ScanEvents['urlFound']>();
  emitter.on('urlFound', onUrlFound);

  crawlerEmit('urlFound', 'https://example.com/a', 'text/html', 100, 200);
  await nextTick();
  crawlerEmit('resolve');
  await emitter.promise;

  expect(lighthouse).not.toHaveBeenCalled();
  expect(onReportReused).toHaveBeenCalledTimes(1);
  expect(onReportReused).toHaveBeenCalledWith('https://example.com/a');
  expect(onReportBegin).not.toHaveBeenCalled();
  // The crawl record still gets every found URL even when the page is reused.
  expect(onUrlFound).toHaveBeenCalledTimes(1);
});

test('runs Lighthouse for a page with no usable report', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouseEmitter = createEmitter<LighthouseEvents>();
  const lighthouse = vi.fn(() => lighthouseEmitter);

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    reportInventory: inventoryWith([]),
  });

  const onReportReused = vi.fn<ScanEvents['reportReused']>();
  emitter.on('reportReused', onReportReused);

  crawlerEmit('urlFound', 'https://example.com/new', 'text/html', 100, 200);
  await nextTick();
  expect(lighthouse).toHaveBeenCalledTimes(1);

  lighthouseEmitter.emit('begin');
  await nextTick();
  lighthouseEmitter.emit('complete', 'fresh-csv-data');
  crawlerEmit('resolve');
  await emitter.promise;

  expect(onReportReused).not.toHaveBeenCalled();
});

test('re-runs a page whose only existing report is unreadable and warns with the file name', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouseEmitter = createEmitter<LighthouseEvents>();
  const lighthouse = vi.fn(() => lighthouseEmitter);

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    reportInventory: inventoryWith([], [
      { fileName: 'corrupt.csv', reason: 'unable to parse report' },
    ]),
  });

  const onWarning = vi.fn<ScanEvents['warning']>();
  emitter.on('warning', onWarning);
  const onReportReused = vi.fn<ScanEvents['reportReused']>();
  emitter.on('reportReused', onReportReused);

  crawlerEmit('urlFound', 'https://example.com/a', 'text/html', 100, 200);
  await nextTick();
  crawlerEmit('resolve');
  lighthouseEmitter.emit('complete', 'fresh-csv-data');
  await emitter.promise;

  expect(lighthouse).toHaveBeenCalledTimes(1);
  expect(onReportReused).not.toHaveBeenCalled();
  expect(onWarning).toHaveBeenCalledWith(
    expect.stringContaining('corrupt.csv'),
  );
});

test('forces a full run, ignoring the inventory, when force is set', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouseEmitter = createEmitter<LighthouseEvents>();
  const lighthouse = vi.fn(() => lighthouseEmitter);

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    force: true,
    reportInventory: inventoryWith([makeRecord('https://example.com/a')]),
  });

  const onReportReused = vi.fn<ScanEvents['reportReused']>();
  emitter.on('reportReused', onReportReused);

  crawlerEmit('urlFound', 'https://example.com/a', 'text/html', 100, 200);
  await nextTick();
  expect(lighthouse).toHaveBeenCalledTimes(1);

  lighthouseEmitter.emit('complete', 'fresh-csv-data');
  crawlerEmit('resolve');
  await emitter.promise;

  expect(onReportReused).not.toHaveBeenCalled();
});

test('falls back to the historical report when a forced run fails for a covered URL', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouseEmitter = createEmitter<LighthouseEvents>();
  const lighthouse = vi.fn(() => lighthouseEmitter);
  const record = makeRecord('https://example.com/a', {
    fileName: 'history-a.csv',
  });

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    force: true,
    reportInventory: inventoryWith([record]),
  });

  const onReportReused = vi.fn<ScanEvents['reportReused']>();
  emitter.on('reportReused', onReportReused);
  const onReportFail = vi.fn<ScanEvents['reportFail']>();
  emitter.on('reportFail', onReportFail);
  const onInfo = vi.fn<ScanEvents['info']>();
  emitter.on('info', onInfo);

  crawlerEmit('urlFound', 'https://example.com/a', 'text/html', 100, 200);
  await nextTick();
  lighthouseEmitter.emit('error', new Error('chrome exploded'));
  crawlerEmit('resolve');
  await emitter.promise;

  expect(onReportFail).not.toHaveBeenCalled();
  expect(onReportReused).toHaveBeenCalledWith('https://example.com/a');
  expect(onInfo).toHaveBeenCalledWith(
    expect.stringContaining('history-a.csv'),
  );
});

test('always re-emits urlFound, even when the report is reused', async () => {
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const lighthouse = vi.fn(() => {
    throw new Error('should not run');
  });

  const emitter = scan('https://example.com', {
    ...baseOptions,
    crawler: fakeCrawler,
    lighthouse,
    reportInventory: inventoryWith([
      makeRecord('https://example.com/a'),
      makeRecord('https://example.com/b'),
    ]),
  });

  const onUrlFound = vi.fn<ScanEvents['urlFound']>();
  emitter.on('urlFound', onUrlFound);

  crawlerEmit('urlFound', 'https://example.com/a', 'text/html', 100, 200);
  crawlerEmit('urlFound', 'https://example.com/b', 'text/html', 100, 200);
  crawlerEmit('resolve');
  await emitter.promise;

  expect(onUrlFound).toHaveBeenCalledTimes(2);
});
