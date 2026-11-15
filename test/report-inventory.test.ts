import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildReportInventory } from '../src/report-inventory.js';

const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'lighthouse-parade-inventory-'),
  );
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  tempDirs.length = 0;
});

/**
 * Builds a minimal but valid Lighthouse 10+ CSV report (the three
 * blank-line-separated sections) for a given URL. Scores are echoed into the
 * file so tests can prove which report won a dedup race.
 */
const writeReport = (
  reportsDir: string,
  fileName: string,
  requestedUrl: string,
  options: { score?: string; mtimeMs?: number; audit?: string } = {},
) => {
  const { score = '1', mtimeMs, audit = 'first-contentful-paint' } = options;
  const csv = [
    '"requestedUrl","finalDisplayedUrl","fetchTime","gatherMode"',
    `"${requestedUrl}","${requestedUrl}","2026-01-01T00:00:00.000Z","navigation"`,
    '',
    'category,score',
    '"performance","1"',
    '',
    'category,audit,score,displayValue,description',
    `"performance","${audit}","${score}","0.6 s","desc"`,
    '',
  ].join('\n');
  const filePath = path.join(reportsDir, fileName);
  fs.writeFileSync(filePath, csv);
  if (mtimeMs !== undefined) {
    fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }

  return filePath;
};

describe('buildReportInventory', () => {
  it('indexes usable reports by the requested URL recorded inside them', async () => {
    const dir = makeTempDir();
    const reportsDir = path.join(dir, 'reports');
    fs.mkdirSync(reportsDir);
    // A deliberately misleading file name: the URL inside the report is what
    // must be used, not this name.
    writeReport(
      reportsDir,
      'totally-unrelated-name.csv',
      'https://a.test/',
    );

    const inventory = await buildReportInventory(reportsDir);

    expect(inventory.unreadable).toEqual([]);
    expect([...inventory.reportsByUrl.keys()]).toEqual(['https://a.test/']);
    expect(
      inventory.reportsByUrl.get('https://a.test/')?.fileName,
    ).toBe('totally-unrelated-name.csv');
  });

  it('picks the newest report when one URL has several history files', async () => {
    const dir = makeTempDir();
    const reportsDir = path.join(dir, 'reports');
    fs.mkdirSync(reportsDir);
    writeReport(reportsDir, 'old.csv', 'https://a.test/', {
      score: '0.1',
      mtimeMs: 1_000_000,
    });
    writeReport(reportsDir, 'new.csv', 'https://a.test/', {
      score: '0.9',
      mtimeMs: 2_000_000,
    });

    const inventory = await buildReportInventory(reportsDir);

    expect([...inventory.reportsByUrl.keys()]).toHaveLength(1);
    const record = inventory.reportsByUrl.get('https://a.test/');
    expect(record?.fileName).toBe('new.csv');
    expect(record?.row['performance: first-contentful-paint']).toBe('0.9');
  });

  it('lists unreadable files with their file name instead of covering the URL', async () => {
    const dir = makeTempDir();
    const reportsDir = path.join(dir, 'reports');
    fs.mkdirSync(reportsDir);
    fs.writeFileSync(path.join(reportsDir, 'broken.csv'), 'not a lighthouse report');

    const inventory = await buildReportInventory(reportsDir);

    expect(inventory.reportsByUrl.size).toBe(0);
    expect(inventory.unreadable).toEqual([
      expect.objectContaining({ fileName: 'broken.csv' }),
    ]);
  });

  it('resolves to an empty inventory for a missing or empty reports directory', async () => {
    const dir = makeTempDir();

    const missing = await buildReportInventory(path.join(dir, 'reports'));
    expect(missing.reportsByUrl.size).toBe(0);
    expect(missing.unreadable).toEqual([]);

    const reportsDir = path.join(dir, 'reports2');
    fs.mkdirSync(reportsDir);
    const empty = await buildReportInventory(reportsDir);
    expect(empty.reportsByUrl.size).toBe(0);
    expect(empty.unreadable).toEqual([]);
  });

  it('does not treat file names as the source of the requested URL', async () => {
    const dir = makeTempDir();
    const reportsDir = path.join(dir, 'reports');
    fs.mkdirSync(reportsDir);
    // The name says b.test but the report itself was requested from a.test.
    writeReport(reportsDir, 'https--b_test-.csv', 'https://a.test/page');

    const inventory = await buildReportInventory(reportsDir);

    expect(inventory.reportsByUrl.has('https://a.test/page')).toBe(true);
    expect(inventory.reportsByUrl.has('https://b.test/')).toBe(false);
  });
});
