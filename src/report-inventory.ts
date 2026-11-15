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
  void reportsDirPath;
  throw new Error('buildReportInventory is not implemented yet');
};
