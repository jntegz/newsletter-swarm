// Loads an embed's player in the page when a reader asks for it. The page holds a link card, which is
// all a reader without JavaScript gets, and the player's address (built from checked ids in
// embedInfo). This script shows the button, and only a click adds the frame, so until then the page
// makes no request to the service. It sets no cookie and starts nothing playing: the player appears
// and waits for the reader, with or without reduced motion.
//
// Only a page with a player carries the script and rules, and its CSP allows those players' origins
// (sendPage in ./layout). Both are stored with a cached page, nonce swapped on a hit (edge/cache.ts).
// The frame keeps the service's own origin, so allow-same-origin gives it nothing of this site's.
// It sends only this site's origin as referrer, never a page address that may hold a gift token;
// YouTube's player refuses to run with no referrer at all.
import { h } from './html';

const SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';
const ALLOW = 'encrypted-media; fullscreen; picture-in-picture';

const PLAYER_SCRIPT = `(function(){var d=document;[].forEach.call(d.querySelectorAll('.sw-player[data-sw-src]'),function(p){var l=p.querySelector('.sw-player-load'),b=l&&l.querySelector('button');if(!b)return;l.hidden=false;b.addEventListener('click',function(){var f=d.createElement('iframe');f.className='sw-player-frame';f.title=p.getAttribute('data-sw-title');f.referrerPolicy='strict-origin-when-cross-origin';f.setAttribute('sandbox','${SANDBOX}');f.setAttribute('allow','${ALLOW}');f.src=p.getAttribute('data-sw-src');p.insertBefore(f,p.firstChild);l.remove();f.focus()})})})();`;

export const playerScript = (nonce: string) =>
  `<script nonce="${h(nonce)}">${PLAYER_SCRIPT}</script>`;

export const PLAYER_CSS = `.sw-player{margin:0 0 1em}
.sw-player .sw-link-card{margin:0}
.sw-player-load{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:10px}
.sw-player-load[hidden]{display:none}
.sw-player-load p{flex:1 1 220px;margin:0;font-size:14px;color:var(--text-sub)}
.sw-player-frame{display:block;width:100%;margin:0 0 10px;border:0;border-radius:12px}
.sw-player-video .sw-player-frame{aspect-ratio:16/9}
.sw-player-short .sw-player-frame{height:152px}
.sw-player-medium .sw-player-frame{height:232px}
.sw-player-tall .sw-player-frame{height:352px}
`;
