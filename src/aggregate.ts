import fs from 'node:fs';
import path from 'node:path';

import { stringify as csvStringify } from 'csv-stringify/sync';

import { buildReportInventory } from './report-inventory.js';

const { writeFile } = fs.promises;

/**
 * Combines the individual report CSVs from a folder into a single CSV file.
 *
 * The inventory already guarantees one newest usable report per requested URL,
 * so duplicate history files never produce duplicate rows.
 *
 * @param dataDirPath Directory containing the `reports/` folder.
 * @param requestedUrls When provided, only rows for these URLs (the addresses
 * found by the current crawl) are included. Reports for pages that were not
 * re-crawled stay out of the aggregation.
 * @param currentReportPaths File paths of the reports produced by the current
 * run. When present, the output headers are aligned to one of these reports.
 * When the run reused only historical reports, the newest usable report in
 * scope supplies the headers instead.
 */
export const aggregateCSVReports = async (
  dataDirPath: string,
  requestedUrls?: string[],
  currentReportPaths?: string[],
) => {
  const reportsDirPath = path.join(dataDirPath, 'reports');
  const inventory = await buildReportInventory(reportsDirPath);

  for (const { fileName, reason } of inventory.unreadable) {
    console.log(`Failed to bundle: ${fileName} (${reason})`);
  }

  // Preserve directory iteration order for the output rows, matching the
  // historical behavior of reading the folder file by file.
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator.prototype.toArray is ES2025; this project targets ES2024
  const records = [...inventory.reportsByUrl.values()].toSorted((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );

  const inScope = requestedUrls
    ? records.filter((record) => requestedUrls.includes(record.requestedUrl))
    : records;

  if (inScope.length === 0) {
    throw new Error(
      `No reports could be read from ${reportsDirPath}. Every Lighthouse run failed, so there is nothing to aggregate — the errors above say why each one failed.`,
    );
  }

  const currentPathSet = new Set(currentReportPaths);
  const headerSource =
    inScope.find((record) => currentPathSet.has(record.filePath)) ??
    // No fresh reports (every page was reused): the newest usable report in
    // scope is the closest thing to "this run's" table shape.
    inScope.reduce((newest, record) =>
      record.modifiedMs > newest.modifiedMs ? record : newest,
    );
  const headers = headerSource.headers;

  // Columns align by name, never by position: historical reports may come from
  // a different Lighthouse version with another column order or column set.
  // Columns missing here stay empty; columns absent from an old report drop.
  const rows = [
    headers,
    ...inScope.map((record) =>
      headers.map((header) => record.row[header] ?? ''),
    ),
  ];

  const aggregatedReportData = csvStringify(rows);

  const writePath = path.join(dataDirPath, 'aggregatedMobileReport.csv');
  await writeFile(writePath, aggregatedReportData);
};
