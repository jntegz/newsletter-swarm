// Links to videos and posts on other services, shown as a card. An email can't play anything, and a
// website page stays free of other companies until someone clicks, so both show a link. Only an
// email shows YouTube's thumbnail: that's a normal image in a message the reader has already opened.
//
// On a website page a link with a `player` can also load in the page, once the reader clicks. X and
// Bluesky have none: their embeds need their own script running in the page, so they stay links.
interface EmbedPlayer {
  /** The address to load, built only from checked ids. */
  src: string;
  /** What a page showing this player adds to its frame-src. */
  origin: string;
  /** Sets the frame's size: a video's shape, or the height of an audio player. */
  shape: 'video' | 'short' | 'medium' | 'tall';
}

interface EmbedInfo {
  provider: 'YouTube' | 'X' | 'Spotify' | 'Bluesky' | 'Vimeo';
  /** The call to action on the card. */
  action: string;
  youtubeId: string | null;
  player: EmbedPlayer | null;
}

const YOUTUBE_PLAYER = 'https://www.youtube-nocookie.com';
const VIMEO_PLAYER = 'https://player.vimeo.com';
const SPOTIFY_PLAYER = 'https://open.spotify.com';

const SPOTIFY_SHAPE = {
  track: 'short',
  episode: 'medium',
  show: 'medium',
  album: 'tall',
  playlist: 'tall',
  artist: 'tall',
} as const;

function vimeoPlayer(parsed: URL): EmbedPlayer | null {
  const match =
    /^\/(?:channels\/[\w-]+\/|groups\/[\w-]+\/videos\/)?(\d{1,12})(?:\/([0-9a-f]{6,20}))?\/?$/.exec(
      parsed.pathname,
    );
  if (!match) return null;
  const hash = match[2] ?? parsed.searchParams.get('h');
  if (hash && !/^[0-9a-f]{6,20}$/.test(hash)) return null;
  // dnt asks the player not to track the viewer. An unlisted video needs its hash to play.
  return {
    src: `${VIMEO_PLAYER}/video/${match[1]}?dnt=1${hash ? `&h=${hash}` : ''}`,
    origin: VIMEO_PLAYER,
    shape: 'video',
  };
}

function spotifyPlayer(parsed: URL): EmbedPlayer | null {
  const match =
    /^\/(?:intl-[a-z-]{2,10}\/)?(track|episode|show|album|playlist|artist)\/([A-Za-z0-9]{22})\/?$/.exec(
      parsed.pathname,
    );
  if (!match) return null;
  const kind = match[1] as keyof typeof SPOTIFY_SHAPE;
  return {
    src: `${SPOTIFY_PLAYER}/embed/${kind}/${match[2]}`,
    origin: SPOTIFY_PLAYER,
    shape: SPOTIFY_SHAPE[kind],
  };
}

/** What a link is, or null when it isn't from a service we show as an embed. */
export function embedInfo(url: string): EmbedInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^(www|m)\./, '').toLowerCase();
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id =
      host === 'youtu.be'
        ? parsed.pathname.slice(1).split('/')[0]
        : (parsed.searchParams.get('v') ??
          /^\/(?:shorts|embed|live)\/([^/]+)/.exec(parsed.pathname)?.[1]);
    const youtubeId = id && /^[\w-]{6,20}$/.test(id) ? id : null;
    return youtubeId
      ? {
          provider: 'YouTube',
          action: 'Watch on YouTube',
          youtubeId,
          player: {
            src: `${YOUTUBE_PLAYER}/embed/${youtubeId}`,
            origin: YOUTUBE_PLAYER,
            shape: 'video',
          },
        }
      : null;
  }
  if (host === 'x.com' || host === 'twitter.com') {
    return { provider: 'X', action: 'Read the post on X', youtubeId: null, player: null };
  }
  if (host === 'open.spotify.com') {
    return {
      provider: 'Spotify',
      action: 'Listen on Spotify',
      youtubeId: null,
      player: spotifyPlayer(parsed),
    };
  }
  if (host === 'bsky.app') {
    return {
      provider: 'Bluesky',
      action: 'Read the post on Bluesky',
      youtubeId: null,
      player: null,
    };
  }
  if (host === 'vimeo.com') {
    return {
      provider: 'Vimeo',
      action: 'Watch on Vimeo',
      youtubeId: null,
      player: vimeoPlayer(parsed),
    };
  }
  return null;
}

/** An image's share of the column, or null for the full width. */
export const imageWidthPercent = (value: unknown): 25 | 50 | 75 | null =>
  value === 25 || value === 50 || value === 75 ? value : null;
