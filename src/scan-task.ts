import { type CrawlOptions, crawl as defaultCrawler } from './crawl.js';
import { createEmitter } from './emitter.js';
import { runLighthouseReport } from './lighthouse.js';
import type { ReportInventory } from './report-inventory.js';

type ScanOptions = {
  /**
   * Function to determine whether to run lighthouse on a given URL
   * The intended use case for this is to skip URL's where there are already reports saved from previous runs.
   */
  crawler?: typeof defaultCrawler;
  lighthouse?: typeof runLighthouseReport;
  lighthouseConcurrency: number;
  /** Ignore any usable reports in the inventory and run every page fresh. */
  force?: boolean;
  /**
   * Inventory of reports saved from earlier runs. Pages whose requested URL
   * already has a usable report are reused (unless `force` is set) instead of
   * starting another Lighthouse run.
   */
  reportInventory?: ReportInventory;
} & CrawlOptions;

export type ScanEvents = {
  warning: (message: string | Error) => void;
  info: (message: string) => void;
  reportBegin: (url: string) => void;
  reportFail: (url: string, error: string | Error) => void;
  reportComplete: (url: string, reportData: string) => void;
  /** A previously saved report is being reused, so Lighthouse is not started. */
  reportReused: (url: string) => void;
  resolve: () => void;
  urlFound: (
    url: string,
    contentType: string,
    bytes: number,
    statusCode: number,
  ) => void;
};

const emptyInventory = (): ReportInventory => ({
  reportsByUrl: new Map(),
  unreadable: [],
});

export const scan = (
  siteUrl: string,
  {
    crawler = defaultCrawler,
    lighthouse = runLighthouseReport,
    lighthouseConcurrency,
    force = false,
    reportInventory = emptyInventory(),
    ...opts
  }: ScanOptions,
) => {
  const { promise, on, emit } = createEmitter<ScanEvents>();
  /** Used so we can display an error if no pages are found while crawling */
  let hasFoundAnyPages = false;

  // Files that could not be parsed are not coverage: they never skip a page.
  // Their names surface here so the terminal can point at them directly.
  for (const { fileName, reason } of reportInventory.unreadable) {
    emit('warning', `Ignoring unreadable report ${fileName}: ${reason}`);
  }

  emit('info', 'Starting the crawl...');

  const crawlerEmitter = crawler(siteUrl, opts);

  const lighthousePromises: Promise<void>[] = [];
  // The same URL can be reported by the crawler more than once. Only the
  // first sighting should make a reuse decision or start a Lighthouse run.
  const seenUrls = new Set<string>();

  crawlerEmitter.on('urlFound', (url, contentType, bytes, statusCode) => {
    hasFoundAnyPages = true;
    // Urls.csv records every crawled address, reused pages included.
    emit('urlFound', url, contentType, bytes, statusCode);

    if (seenUrls.has(url)) {
      return;
    }
    seenUrls.add(url);

    const existingReport = reportInventory.reportsByUrl.get(url);

    if (existingReport && !force) {
      emit('reportReused', url);
      return;
    }

    lighthousePromises.push(
      new Promise((resolve) => {
        lighthouse(url, lighthouseConcurrency)
          .on('begin', () => emit('reportBegin', url))
          .on('complete', (reportData) => {
            emit('reportComplete', url, reportData);
            resolve();
          })
          .on('error', (error) => {
            // A forced re-run that still fails must not make the page vanish:
            // keep the page covered with its last known good report.
            if (existingReport) {
              emit(
                'info',
                `Lighthouse failed for ${url}; reusing the existing report ${existingReport.fileName} instead`,
              );
              emit('reportReused', url);
            } else {
              emit('reportFail', url, error);
            }
            // Resolves instead of rejects because we want to continue with the other lighthouses even if one fails
            resolve();
          });
      }),
    );
  });

  crawlerEmitter.on('warning', (message) => emit('warning', message));

  crawlerEmitter.promise
    .then(async () => {
      await Promise.all(lighthousePromises);
      emit('info', 'Scan complete');

      if (!hasFoundAnyPages) {
        emit(
          'warning',
          `No pages were found for this site. The two most likely reasons for this are:
1) the URL is incorrect
2) the crawler is being denied by a robots.txt file`,
        );
        return;
      }

      emit('resolve');
    })
    .catch((error: unknown) => emit('reject', error));
  return { promise, on };
};
