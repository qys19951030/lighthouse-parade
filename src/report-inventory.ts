import fs from 'node:fs';
import path from 'node:path';

import { parseReport } from './report-to-row.js';

/**
 * Inventory of the individual Lighthouse report CSVs already saved in a data
 * directory's `reports/` folder.
 *
 * Coverage is keyed by the requested URL recorded *inside* each report rather
 * than by file name: report file names are derived from URLs by character
 * substitution, so they are not a reliable way back to the original URL.
 */

/** One report that parsed successfully and can be reused or aggregated. */
export type ReportRecord = {
  /** File name inside the reports directory (used in terminal warnings). */
  fileName: string;
  /** Absolute path to the report file. */
  filePath: string;
  /** Requested URL read from the report's metadata section. */
  requestedUrl: string;
  /** Column names produced by `report-to-row` for this report. */
  headers: string[];
  /** Report values keyed by column name, safe to align across Lighthouse versions. */
  row: Record<string, string>;
  /** File modification time in milliseconds (newest report wins on duplicates). */
  modifiedMs: number;
};

/** A report file whose contents could not be parsed as a Lighthouse report. */
export type UnreadableReport = {
  fileName: string;
  reason: string;
};

export type ReportInventory = {
  /** Newest usable report per requested URL found inside the directory. */
  reportsByUrl: Map<string, ReportRecord>;
  /** Files that cannot be reused or aggregated, with their file names. */
  unreadable: UnreadableReport[];
};

/**
 * Reads every file in `reportsDirPath` and builds the coverage inventory.
 * A missing or empty directory resolves to an empty inventory rather than
 * throwing, so a first run behaves exactly like a directory with no history.
 */
export const buildReportInventory = async (
  reportsDirPath: string,
): Promise<ReportInventory> => {
  const reportsByUrl = new Map<string, ReportRecord>();
  const unreadable: UnreadableReport[] = [];

  let fileNames: string[];
  try {
    fileNames = await fs.promises.readdir(reportsDirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { reportsByUrl, unreadable };
    }
    throw error;
  }

  for (const fileName of fileNames) {
    // Finder metadata; kept from the original aggregator's skip list.
    if (fileName === '.DS_Store') {
      continue;
    }

    const filePath = path.join(reportsDirPath, fileName);
    const fileContents = fs.readFileSync(filePath, 'utf8');
    const parsed = parseReport(fileContents);

    if (!parsed || parsed.requestedUrl === '') {
      unreadable.push({
        fileName,
        reason: parsed
          ? 'report has no requested URL'
          : 'unable to parse report',
      });
      continue;
    }

    const stats = fs.statSync(filePath);
    const record: ReportRecord = {
      fileName,
      filePath,
      requestedUrl: parsed.requestedUrl,
      headers: parsed.headers,
      row: parsed.row,
      modifiedMs: stats.mtimeMs,
    };

    // One requested URL can have several history files. The newer report
    // wins; file name is only a deterministic tiebreak for identical mtimes.
    const existing = reportsByUrl.get(parsed.requestedUrl);
    if (
      !existing ||
      record.modifiedMs > existing.modifiedMs ||
      (record.modifiedMs === existing.modifiedMs &&
        record.fileName > existing.fileName)
    ) {
      reportsByUrl.set(parsed.requestedUrl, record);
    }
  }

  return { reportsByUrl, unreadable };
};
