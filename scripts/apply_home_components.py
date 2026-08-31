#!/usr/bin/env python3
"""R8-P1: insert the real memoized feed/header components into HomeScreen.tsx."""
import io

PATH = '/home/z/my-project/src/screens/HomeScreen.tsx'
src = io.open(PATH, encoding='utf-8').read()

quicktiles = io.open('/tmp/quicktiles.txt', encoding='utf-8').read().rstrip('\n')
fixed_jsx = io.open('/tmp/fixed_jsx.txt', encoding='utf-8').read().rstrip('\n')

# The fixed JSX was indented 8 spaces (inside ScrollView). HomeHeader's
# return wraps at the same depth inside <>, so dedent 4 (8→4).
lines = fixed_jsx.split('\n')
dedented = '\n'.join(l[4:] if l.startswith('    ') else l for l in lines)

# quickTiles block was indented 2 → keep as-is (same depth inside HomeHeader).

# the fixed JSX ends mid-conditional (loading ? ... : <> shelves ...) —
# close the inner fragment + the ternary so the inserted body is balanced.
dedented += '\n      </>\n    )}\n'

COMPONENTS = '''// ── R8-P1 windowed-feed primitives ─────────────────────────────────────────
// Every wrapper is React.memo'd with STABLE props (track refs, stable
// callbacks) so a feed append re-renders ONLY the new rows — the rows
// above keep their mounted views. ShelfCard/Artwork/QuickTile (in their
// own modules) are memo'd too; their onPress closures capture per-card
// data objects, so ignoring closure identity is safe there.

/** One flattened feed row (FlatList data element). */
type FeedItem =
  | { k: 'header'; key: string; title: string }
  | { k: 'song'; key: string; track: Track }
  | { k: 'albumShelf'; key: string; title: string; albums: Collection[] };

/** "Top Songs" section header — same look as the old batch wrapper. */
const FeedHeaderRow = React.memo(function FeedHeaderRow({ title }: { title: string }) {
  return (
    <View style={styles.feedSection}>
      <Text style={styles.feedHeader} testID="endless-feed-songs">
        {title}
      </Text>
    </View>
  );
});

/** A feed song row — memo holds across feed appends (stable track ref +
 *  stable onPlay), so TrackRow re-renders only on player changes. */
const FeedSongRow = React.memo(function FeedSongRow({
  track,
  onPlay,
}: {
  track: Track;
  onPlay: (t: Track) => void;
}) {
  return <TrackRow track={track} onPress={() => onPlay(track)} />;
});

/** A feed album shelf batch (cards in a horizontal rail). */
const FeedAlbumShelf = React.memo(function FeedAlbumShelf({
  title,
  albums,
  onOpen,
}: {
  title: string;
  albums: Collection[];
  onOpen: (c: Collection) => void;
}) {
  return (
    <Shelf title={title}>
      {albums.map((c) => (
        <ShelfCard
          key={c.id}
          title={c.title}
          subtitle={c.subtitle}
          artwork={c.artwork}
          seed={`feed-album-${c.id}`}
          size={150}
          onPress={() => onOpen(c)}
        />
      ))}
    </Shelf>
  );
});

/** Spinner / retry row / honest end marker + the quiet footer. */
const FeedFooter = React.memo(function FeedFooter({
  loading,
  feedState,
  onRetry,
  showEmpty,
  onGoAI,
}: {
  loading: boolean;
  feedState: 'idle' | 'loading' | 'retry' | 'exhausted';
  onRetry: () => void;
  showEmpty: boolean;
  onGoAI: () => void;
}) {
  if (loading) return null;
  return (
    <>
      {feedState === 'loading' ? (
        <ActivityIndicator color={colors.accentBright} style={styles.feedSpinner} />
      ) : null}
      {feedState === 'retry' ? (
        <PressableScale haptic style={styles.feedRetry} onPress={onRetry}>
          <Ionicons name="refresh" size={15} color={colors.textDim} />
          <Text style={styles.feedRetryText}>Couldn't load more — tap to retry</Text>
        </PressableScale>
      ) : null}
      {feedState === 'exhausted' ? (
        <Text style={styles.feedEnd} testID="endless-feed-end">
          You've reached the end
        </Text>
      ) : null}
      {showEmpty ? <EmptyHome onGoAI={onGoAI} /> : null}
      <View style={styles.footerDivider}>
        <View style={styles.footerRule} />
        <Text style={styles.footerText}>TSF Music · Music for everyone</Text>
      </View>
    </>
  );
});

/** The fixed shelves (everything above the endless feed). Memo'd: feed
 *  appends and feed-state flips CANNOT re-render this subtree — only
 *  actual shelf data changes do (each settles exactly once per load). */
const HomeHeader = React.memo(function HomeHeader({
  chip,
  setChip,
  userName,
  offline,
  loading,
  showAI,
  hasMixes,
  mixes,
  favorites,
  nowSound,
  recents,
  popularArtists,
  trending,
  onTheRise,
  because,
  newAlbums,
  featured,
  charts,
  winWidth,
  play,
  openTrackCollection,
  openArtist,
  onGoAI,
}: {
  chip: Chip;
  setChip: (c: Chip) => void;
  userName: string;
  offline: boolean;
  loading: boolean;
  showAI: boolean;
  hasMixes: boolean;
  mixes: DailyMix[] | null;
  favorites: Track[];
  nowSound: NowSoundCard | null;
  recents: Track[];
  popularArtists: ArtistInfo[];
  trending: Track[] | null;
  onTheRise: OnTheRiseCard | null;
  because: Array<{ artist: string; seedTrack?: Track }>;
  newAlbums: Collection[];
  featured: Collection[];
  charts: Collection[];
  winWidth: number;
  play: (tracks: Track[], index: number) => void;
  openTrackCollection: (title: string, tracks: Track[]) => void;
  openArtist: (artist: string) => void;
  onGoAI: () => void;
}) {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

QUICKTILES_BLOCK

  const quickTileList = quickTiles.slice(0, 8);

  return (
    <>
FIXED_JSX
    </>
  );
});

'''

COMPONENTS = COMPONENTS.replace('QUICKTILES_BLOCK', quicktiles)
COMPONENTS = COMPONENTS.replace('FIXED_JSX', dedented)

# quickTiles body references `favorites` etc — it was written with 2-space
# indent inside the component; inside HomeHeader it sits at the same level.

ANCHOR = "// Quick-tile grid math is window-reactive: the two-column width is computed"
assert ANCHOR in src, 'anchor missing'
src = src.replace(ANCHOR, COMPONENTS + ANCHOR, 1)

# pass the favorites prop from HomeScreen
src = src.replace(
    """            chip={chip}
            setChip={setChip}
            userName={userName}
            offline={offline}
            loading={loading}
            showAI={showAI}
            hasMixes={hasMixes}
            mixes={mixes}
            nowSound={nowSound}""",
    """            chip={chip}
            setChip={setChip}
            userName={userName}
            offline={offline}
            loading={loading}
            showAI={showAI}
            hasMixes={hasMixes}
            mixes={mixes}
            favorites={favorites}
            nowSound={nowSound}""",
)

io.open(PATH, 'w', encoding='utf-8').write(src)
print('real components inserted OK')
