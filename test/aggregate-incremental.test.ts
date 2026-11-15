import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse as csvParse } from 'csv-parse/sync';
import { afterEach, describe, expect, it } from 'vitest';

import { aggregateCSVReports } from '../src/aggregate.js';

const tempDirs: string[] = [];

const makeDataDir = () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lighthouse-parade-aggregate-'),
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

type ReportSpec = {
  fileName: string;
  requestedUrl: string;
  /** Header name (after the two URL columns) to value. */
  columns: Record<string, string>;
  /** Ordered columns for this report; defaults to the keys of `columns`. */
  columnOrder?: string[];
  mtimeMs?: number;
};

/** Writes a minimal Lighthouse-shaped CSV whose audit section matches the spec. */
const writeReport = (dir: string, spec: ReportSpec) => {
  const metricNames = spec.columnOrder ?? Object.keys(spec.columns);
  const lines = [
    '"requestedUrl","finalDisplayedUrl","fetchTime","gatherMode"',
    `"${spec.requestedUrl}","${spec.requestedUrl}","2026-01-01T00:00:00.000Z","navigation"`,
    '',
    'category,score',
    '"performance","1"',
    '',
    'category,audit,score,displayValue,description',
    ...metricNames.map(
      (metric) =>
        `"performance","${metric}","${spec.columns[metric] ?? ''}","x","d"`,
    ),
    '',
  ];
  const filePath = path.join(dir, 'reports', spec.fileName);
  fs.writeFileSync(filePath, lines.join('\n'));
  if (spec.mtimeMs !== undefined) {
    fs.utimesSync(filePath, spec.mtimeMs / 1000, spec.mtimeMs / 1000);
  }

  return filePath;
};

const readAggregated = (dir: string) => {
  const text = fs.readFileSync(
    path.join(dir, 'aggregatedMobileReport.csv'),
    'utf8',
  );
  return csvParse(text, { columns: true }) as Record<string, string>[];
};

describe('aggregateCSVReports (incremental)', () => {
  it('only includes reports for URLs found by the current crawl', async () => {
    const dir = makeDataDir();
    writeReport(dir, {
      fileName: 'a.csv',
      requestedUrl: 'https://a.test/',
      columns: { fcp: '1' },
    });
    writeReport(dir, {
      fileName: 'gone.csv',
      requestedUrl: 'https://a.test/gone',
      columns: { fcp: '1' },
    });

    // The deleted page is absent from this crawl, so it must leave the table.
    await aggregateCSVReports(dir, ['https://a.test/']);

    const rows = readAggregated(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Requested URL']).toBe('https://a.test/');
  });

  it('keeps one row per requested URL, taking the newer report on duplicates', async () => {
    const dir = makeDataDir();
    writeReport(dir, {
      fileName: 'old.csv',
      requestedUrl: 'https://a.test/',
      columns: { fcp: '0.1' },
      mtimeMs: 1_000_000,
    });
    writeReport(dir, {
      fileName: 'new.csv',
      requestedUrl: 'https://a.test/',
      columns: { fcp: '0.9' },
      mtimeMs: 2_000_000,
    });

    await aggregateCSVReports(dir, ['https://a.test/']);

    const rows = readAggregated(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]['performance: fcp']).toBe('0.9');
  });

  it('aligns historical columns by name, dropping missing and blanking added columns', async () => {
    const dir = makeDataDir();
    // Old Lighthouse: one shared column, one column the new run no longer emits.
    writeReport(dir, {
      fileName: 'old.csv',
      requestedUrl: 'https://a.test/old',
      columns: { fcp: '0.5', 'legacy-audit': '1' },
      columnOrder: ['legacy-audit', 'fcp'],
      mtimeMs: 1_000_000,
    });
    // New Lighthouse: same fcp column plus a new audit the old report lacks.
    writeReport(dir, {
      fileName: 'fresh.csv',
      requestedUrl: 'https://a.test/fresh',
      columns: { fcp: '0.7', 'new-audit': '0.3' },
      mtimeMs: 2_000_000,
    });

    await aggregateCSVReports(
      dir,
      ['https://a.test/old', 'https://a.test/fresh'],
      [path.join(dir, 'reports', 'fresh.csv')],
    );

    const rows = readAggregated(dir);
    const headerRow = csvParse(
      fs.readFileSync(path.join(dir, 'aggregatedMobileReport.csv'), 'utf8'),
    )[0] as string[];
    expect(headerRow).toContain('performance: fcp');
    expect(headerRow).toContain('performance: new-audit');
    // The column the current run doesn't know about is dropped entirely.
    expect(headerRow).not.toContain('performance: legacy-audit');

    const oldRow = rows.find(
      (row) => row['Requested URL'] === 'https://a.test/old',
    );
    expect(oldRow?.['performance: fcp']).toBe('0.5');
    // Added columns stay empty for rows that predate them.
    expect(oldRow?.['performance: new-audit']).toBe('');

    const freshRow = rows.find(
      (row) => row['Requested URL'] === 'https://a.test/fresh',
    );
    expect(freshRow?.['performance: new-audit']).toBe('0.3');
  });

  it('writes headers from the newest usable report when every page was reused', async () => {
    const dir = makeDataDir();
    writeReport(dir, {
      fileName: 'older.csv',
      requestedUrl: 'https://a.test/a',
      columns: { fcp: '1' },
      mtimeMs: 1_000_000,
    });
    writeReport(dir, {
      fileName: 'newer.csv',
      requestedUrl: 'https://a.test/b',
      columns: { fcp: '1', lcp: '1' },
      mtimeMs: 2_000_000,
    });

    // No current-report paths: nothing was run fresh this time.
    await aggregateCSVReports(
      dir,
      ['https://a.test/a', 'https://a.test/b'],
      [],
    );

    const headerRow = csvParse(
      fs.readFileSync(path.join(dir, 'aggregatedMobileReport.csv'), 'utf8'),
    )[0] as string[];
    expect(headerRow).toContain('performance: lcp');
    expect(readAggregated(dir)).toHaveLength(2);
  });

  it('fills a failed current run with the historical report for the same URL', async () => {
    const dir = makeDataDir();
    writeReport(dir, {
      fileName: 'history.csv',
      requestedUrl: 'https://a.test/flaky',
      columns: { fcp: '0.4' },
      mtimeMs: 1_000_000,
    });

    // The failed fresh run wrote nothing, so aggregation over the current
    // crawl scope still picks up the history file for that URL.
    await aggregateCSVReports(dir, ['https://a.test/flaky']);

    const rows = readAggregated(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Requested URL']).toBe('https://a.test/flaky');
    expect(rows[0]['performance: fcp']).toBe('0.4');
  });

  it('still writes an aggregation when no page was run fresh', async () => {
    const dir = makeDataDir();
    writeReport(dir, {
      fileName: 'only-history.csv',
      requestedUrl: 'https://a.test/',
      columns: { fcp: '1' },
    });

    await expect(
      aggregateCSVReports(dir, ['https://a.test/'], []),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'aggregatedMobileReport.csv'))).toBe(
      true,
    );
  });
});
