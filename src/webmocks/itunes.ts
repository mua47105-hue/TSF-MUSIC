/** WEB MOCK of src/api/itunes.ts — returns [] (avoids browser CORS
 *  noise in the lab; the merged-thin top-up path is still exercised
 *  through the fixture saavn pool).
 *  Law ⑪ parity note: the real module gained NO new exports for Phase 1
 *  (genre is a FIELD on the mapped Track, from primaryGenreName); this
 *  mock's empty pool means the genre path is never exercised on web —
 *  nothing to mirror here. */

import type { Track } from '../types';

export async function searchItunes(_query: string, _limit = 20): Promise<Track[]> {
  await new Promise((r) => setTimeout(r, 80));
  return [];
}
