// iTunes Search API: free, no key, CORS-enabled, and every song comes with a 30 s preview.
// https://performance-partners.apple.com/search-api

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  artwork: string;
  artworkSmall: string;
  previewUrl: string;
  storeUrl: string;
}

interface ItunesSong {
  trackId: number;
  trackName: string;
  artistName: string;
  collectionName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  trackViewUrl?: string;
}

function sizedArtwork(url: string, size: number) {
  return url.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
}

export function storefront(): string {
  const region = (navigator.languages?.[0] ?? navigator.language ?? '').split('-')[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toLowerCase() : 'us';
}

export async function searchSongs(term: string, signal?: AbortSignal): Promise<Track[]> {
  const q = term.trim();
  if (!q) return [];
  const params = new URLSearchParams({ term: q, media: 'music', entity: 'song', limit: '12', country: storefront() });
  return request(`https://itunes.apple.com/search?${params}`, signal);
}

/** Resolve a track id from a shared link. */
export async function lookupSong(id: string, signal?: AbortSignal): Promise<Track | null> {
  if (!/^\d{1,12}$/.test(id)) return null;
  const params = new URLSearchParams({ id, entity: 'song', country: storefront() });
  const [track] = await request(`https://itunes.apple.com/lookup?${params}`, signal);
  return track ?? null;
}

async function request(url: string, signal?: AbortSignal): Promise<Track[]> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`iTunes ${res.status}`);
  const json = (await res.json()) as { results: ItunesSong[] };
  return json.results
    .filter((r) => r.previewUrl && r.artworkUrl100)
    .map((r) => ({
      id: String(r.trackId),
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName ?? '',
      artwork: sizedArtwork(r.artworkUrl100!, 600),
      artworkSmall: sizedArtwork(r.artworkUrl100!, 120),
      previewUrl: r.previewUrl!,
      storeUrl: r.trackViewUrl ?? '',
    }));
}

export function spotifySearchUrl(t: Pick<Track, 'title' | 'artist'>) {
  return `https://open.spotify.com/search/${encodeURIComponent(`${t.title} ${t.artist}`)}`;
}
