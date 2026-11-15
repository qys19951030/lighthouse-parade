import fs from 'node:fs';
import path from 'node:path';

import { stringify as csvStringify } from 'csv-stringify/sync';

import { reportToRow, reportToRowHeaders } from './report-to-row.js';

const { readdir, writeFile } = fs.promises;

/**
 * Combines the individual report CSV's from a folder into a single CSV file.
 *
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
  // Skeleton: the incremental implementation consumes these below.
  void requestedUrls;
  void currentReportPaths;
  const reportsDirPath = path.join(dataDirPath, 'reports');
  const files = await readdir(reportsDirPath);

  const rows = [];
  let headers: string[] | null = null;

  for (const fileName of files) {
    if (fileName === '.DS_Store') {
      continue;
    }

    const filePath = path.join(reportsDirPath, fileName);
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const newRow = reportToRow(fileContents);
    if (!newRow) {
      console.log(`Failed to bundle: ${fileName}`);
      continue;
    }

    // Derived from a report already known to parse. Reading headers from an
    // arbitrary file would throw on a malformed one, which only happened to be
    // safe while the valid reports sorted first.
    headers ??= reportToRowHeaders(fileContents);
    rows.push(newRow);
  }

  if (!headers) {
    throw new Error(
      `No reports could be read from ${reportsDirPath}. Every Lighthouse run failed, so there is nothing to aggregate — the errors above say why each one failed.`,
    );
  }

  rows.unshift(headers);

  const aggregatedReportData = csvStringify(rows);

  const writePath = path.join(dataDirPath, 'aggregatedMobileReport.csv');
  await writeFile(writePath, aggregatedReportData);
};
