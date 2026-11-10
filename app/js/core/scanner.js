// Paginated scan of the user's Drive into a DriveIndex.
import { DriveIndex } from './driveIndex.js';
import { FILE_FIELDS } from './drive.js';

/**
 * Scan every non-trashed item the user can see, page by page.
 * Items that are not reachable from the My Drive root (e.g. "Shared with me"
 * files that were never added to My Drive) are kept in the index but excluded
 * from organisation.
 */
export async function scanDrive(client, { onProgress, signal, pageSize = 1000 } = {}) {
  const root = await client.getFile('root', 'id,name', { signal });
  const index = new DriveIndex(root.id, 'My Drive');
  let pageToken;
  let pages = 0;
  let count = 0;
  do {
    const res = await client.listPage({
      q: 'trashed = false',
      pageSize,
      pageToken,
      corpora: 'user',
      spaces: 'drive',
      fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
    }, { signal });
    pages++;
    if (res.incompleteSearch) index.incompleteSearch = true;
    for (const f of res.files || []) {
      index.add(f);
      count++;
    }
    pageToken = res.nextPageToken;
    onProgress?.({ pages, count, done: !pageToken });
  } while (pageToken);
  index.finalize();
  index.pagesScanned = pages;
  return index;
}
