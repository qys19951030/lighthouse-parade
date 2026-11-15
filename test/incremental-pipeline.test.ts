import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { parse as csvParse } from 'csv-parse/sync';
import { afterEach, expect, test, vi } from 'vitest';

import { aggregateCSVReports } from '../src/aggregate.js';
import { createFakeCrawler } from '../src/crawl.mock.js';
import { createEmitter } from '../src/emitter.js';
import type { LighthouseEvents } from '../src/lighthouse.js';
import { buildReportInventory } from '../src/report-inventory.js';
import { scan } from '../src/scan-task.js';
import { makeFileNameFromUrl } from '../src/utilities.js';

// Deliberately process.nextTick rather than queueMicrotask. The emitter
// dispatches handlers via Promise.resolve().then(), so this helper has to
// yield past that microtask queue rather than joining the back of it.
const nextTick = async () =>
  new Promise((resolve) => process.nextTick(resolve));

const tempDirs: string[] = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lighthouse-parade-pipeline-'),
  );
  fs.mkdirSync(path.join(dir, 'reports'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  tempDirs.length = 0;
});

/** A parseable Lighthouse-shaped CSV for a URL, with a distinctive score. */
const reportFor = (requestedUrl: string, fcpScore: string) =>
  [
    '"requestedUrl","finalDisplayedUrl","fetchTime","gatherMode"',
    `"${requestedUrl}","${requestedUrl}","2026-01-01T00:00:00.000Z","navigation"`,
    '',
    'category,score',
    '"performance","1"',
    '',
    'category,audit,score,displayValue,description',
    `"performance","first-contentful-paint","${fcpScore}","0.6 s","desc"`,
    '',
  ].join('\n');

const urls = ['https://example.com/a', 'https://example.com/b'];

/** Mirrors how cli.ts drives a scan: writes reports, records crawled URLs. */
const runScan = async (
  dataDir: string,
  options: { force?: boolean; failUrl?: string },
) => {
  const reportsDir = path.join(dataDir, 'reports');
  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const inventory = await buildReportInventory(reportsDir);
  let lighthouseCalls = 0;

  const emitter = scan('https://example.com', {
    ignoreRobotsTxt: false,
    includePathGlob: [],
    excludePathGlob: [],
    lighthouseConcurrency: 1,
    crawler: fakeCrawler,
    reportInventory: inventory,
    force: options.force,
    lighthouse(url) {
      lighthouseCalls++;
      const lh = createEmitter<LighthouseEvents>();
      queueMicrotask(() => {
        lh.emit('begin');
        if (url === options.failUrl) {
          lh.emit('error', new Error('boom'));
        } else {
          lh.emit('complete', reportFor(url, '0.9'));
        }
      });
      return lh;
    },
  });

  const crawledUrls: string[] = [];
  const currentReportPaths: string[] = [];
  let reused = 0;

  // Mirror cli.ts: urls.csv records every found address, reused pages included.
  const urlsFile = path.join(dataDir, 'urls.csv');
  emitter.on('urlFound', (url, contentType, bytes, statusCode) => {
    crawledUrls.push(url);
    fs.appendFileSync(
      urlsFile,
      `${[JSON.stringify(url), contentType, bytes, statusCode].join(',')}\n`,
    );
  });
  fs.writeFileSync(urlsFile, 'URL,content_type,bytes,response\n');
  emitter.on('reportReused', () => {
    reused++;
  });
  emitter.on('reportComplete', (url, reportData) => {
    const filePath = path.join(reportsDir, makeFileNameFromUrl(url, 'csv'));
    fs.writeFileSync(filePath, reportData);
    currentReportPaths.push(filePath);
  });

  for (const url of urls) {
    crawlerEmit('urlFound', url, 'text/html', 100, 200);
  }
  await nextTick();
  crawlerEmit('resolve');
  await emitter.promise;

  await aggregateCSVReports(dataDir, crawledUrls, currentReportPaths);
  return { lighthouseCalls, reused, crawledUrls, currentReportPaths };
};

test('a second run reuses every report and reproduces the same aggregation', async () => {
  const dataDir = makeDataDir();

  const first = await runScan(dataDir, {});
  expect(first.lighthouseCalls).toBe(2);
  expect(first.reused).toBe(0);

  const firstAggregate = fs.readFileSync(
    path.join(dataDir, 'aggregatedMobileReport.csv'),
    'utf8',
  );
  const firstUrlsCsv = fs
    .readFileSync(path.join(dataDir, 'urls.csv'), 'utf8')
    .trim()
    .split('\n');

  const second = await runScan(dataDir, {});

  // Nothing is re-run; both pages come from the saved reports.
  expect(second.lighthouseCalls).toBe(0);
  expect(second.reused).toBe(2);

  // The urls.csv file still records every crawled address, even when pages are reused.
  const secondUrlsCsv = fs
    .readFileSync(path.join(dataDir, 'urls.csv'), 'utf8')
    .trim()
    .split('\n');
  // Header plus one row per URL on both runs.
  expect(firstUrlsCsv).toHaveLength(3);
  expect(secondUrlsCsv).toEqual(firstUrlsCsv);

  // All-reused runs still write a scoped aggregation with identical content.
  const secondAggregate = fs.readFileSync(
    path.join(dataDir, 'aggregatedMobileReport.csv'),
    'utf8',
  );
  expect(secondAggregate).toBe(firstAggregate);
  const rows = csvParse<Record<string, string>>(secondAggregate, {
    columns: true,
  });
  expect(rows).toHaveLength(2);
});

test('a forced run that fails keeps the page in the report via its history', async () => {
  const dataDir = makeDataDir();
  await runScan(dataDir, {});

  const result = await runScan(dataDir, {
    force: true,
    failUrl: 'https://example.com/a',
  });

  // Forced mode starts Lighthouse for both pages...
  expect(result.lighthouseCalls).toBe(2);
  // ...but the failed one is backfilled from its historical report.
  expect(result.reused).toBe(1);

  const rows = csvParse<Record<string, string>>(
    fs.readFileSync(path.join(dataDir, 'aggregatedMobileReport.csv'), 'utf8'),
    { columns: true },
  );
  expect(rows.map((row) => row['Requested URL']).toSorted()).toEqual(urls);
  const failedPageRow = rows.find(
    (row) => row['Requested URL'] === 'https://example.com/a',
  );
  expect(failedPageRow?.['performance: first-contentful-paint']).toBe('0.9');
});

test('warns about an unreadable history file instead of treating it as coverage', async () => {
  const dataDir = makeDataDir();
  fs.writeFileSync(
    path.join(dataDir, 'reports', 'corrupt.csv'),
    'not a lighthouse report',
  );

  const { fakeCrawler, emit: crawlerEmit } = createFakeCrawler();
  const inventory = await buildReportInventory(path.join(dataDir, 'reports'));
  expect(inventory.reportsByUrl.size).toBe(0);

  const onWarning = vi.fn();
  const emitter = scan('https://example.com', {
    ignoreRobotsTxt: false,
    includePathGlob: [],
    excludePathGlob: [],
    lighthouseConcurrency: 1,
    crawler: fakeCrawler,
    reportInventory: inventory,
    lighthouse() {
      const lh = createEmitter<LighthouseEvents>();
      queueMicrotask(() => {
        lh.emit('begin');
        lh.emit('complete', reportFor(urls[0], '1'));
      });
      return lh;
    },
  });
  emitter.on('warning', (message) => {
    onWarning(message);
  });

  crawlerEmit('urlFound', urls[0], 'text/html', 100, 200);
  await nextTick();
  crawlerEmit('resolve');
  await emitter.promise;

  expect(onWarning).toHaveBeenCalledWith(
    expect.stringContaining('corrupt.csv'),
  );
});
