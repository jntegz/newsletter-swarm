// The live preview: the real page rendered from the draft, in a frame. A new address loads in a
// second frame behind the first and takes its place once drawn, at the same scroll position, so
// the preview never flashes blank. When the page is on this origin (the development preview), the
// studio can also reach into it: a click on a section selects it, the selected section is marked,
// and style changes apply before the next save.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type PreviewWidth = 'desktop' | 'phone';

/** The width a desktop preview is drawn at before it is scaled to fit. */
const DESKTOP_WIDTH = 1280;
const PHONE_WIDTH = 390;

const STUDIO_CSS = `
[id^="section-"]{cursor:pointer;transition:outline-color .15s}
[id^="section-"]:hover{outline:2px dashed #8a94a6;outline-offset:-2px}
[data-studio-selected]{outline:2px solid #14203a!important;outline-offset:-2px}
@media (prefers-reduced-motion:reduce){[id^="section-"]{transition:none}}
`;

/** The frame's document when it is on this origin; null for the site's own address. */
function documentOf(frame: HTMLIFrameElement | null): Document | null {
  try {
    return frame?.contentDocument ?? null;
  } catch {
    return null;
  }
}

interface Props {
  url: string | null;
  width: PreviewWidth;
  /** Who it is drawn for, for the frame's name. */
  audience: string;
  selected: string | null;
  /** A selection made in the list (not in the preview): scroll the section into view. */
  revealSelected: number;
  onSelect: (sectionId: string) => void;
  /** The draft's CSS, for an instant restyle while the next save is on its way. */
  liveCss: string | null;
}

export function PreviewFrame({
  url,
  width,
  audience,
  selected,
  revealSelected,
  onSelect,
  liveCss,
}: Props) {
  const box = useRef<HTMLDivElement>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const [shown, setShown] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const handlers = useRef({ onSelect, selected, liveCss });
  useLayoutEffect(() => {
    handlers.current = { onSelect, selected, liveCss };
  });

  // A new address starts loading behind the one shown.
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  if (url !== lastUrl) {
    setLastUrl(url);
    if (url && url !== shown) setLoading(url);
  }

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const prepare = (doc: Document) => {
    if (!doc.getElementById('swarm-studio-css')) {
      const style = doc.createElement('style');
      style.id = 'swarm-studio-css';
      style.textContent = STUDIO_CSS;
      doc.head?.append(style);
    }
    doc.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      // The preview is for looking: links and buttons don't leave it.
      if (target?.closest('a, button, form')) event.preventDefault();
      const section = target?.closest('[id^="section-"]');
      if (section) handlers.current.onSelect(section.id.slice('section-'.length));
    });
    doc.addEventListener('submit', (event) => event.preventDefault());
    mark(doc, handlers.current.selected);
    restyle(doc, handlers.current.liveCss);
  };

  const onLoad = (src: string) => {
    if (src !== loading) return;
    const next = frames.current.get(src);
    const previous = shown ? frames.current.get(shown) : null;
    const doc = documentOf(next ?? null);
    if (doc) {
      prepare(doc);
      const before = documentOf(previous ?? null)?.defaultView?.scrollY ?? 0;
      doc.defaultView?.scrollTo(0, before);
    }
    setShown(src);
    setLoading(null);
  };

  // The selected section, marked in the page.
  useEffect(() => {
    const doc = documentOf(shown ? (frames.current.get(shown) ?? null) : null);
    if (doc) mark(doc, selected);
  }, [selected, shown]);

  useEffect(() => {
    if (!revealSelected || !selected) return;
    const doc = documentOf(shown ? (frames.current.get(shown) ?? null) : null);
    doc?.getElementById(`section-${selected}`)?.scrollIntoView({ block: 'start' });
    // Only a new request to reveal scrolls, not every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSelected]);

  useEffect(() => {
    const doc = documentOf(shown ? (frames.current.get(shown) ?? null) : null);
    if (doc) restyle(doc, liveCss);
  }, [liveCss, shown]);

  const frameWidth = width === 'phone' ? PHONE_WIDTH : DESKTOP_WIDTH;
  // A phone frame sits on the grey with room around it, unless the screen is a phone already.
  const framed = width === 'phone' && size.width >= PHONE_WIDTH + 32;
  const room = Math.max(0, size.width - (framed ? 32 : 0));
  const scale = room && frameWidth > room ? room / frameWidth : 1;
  const height = framed ? size.height - 32 : size.height;

  const list = [shown, loading].filter((u, i, all): u is string => !!u && all.indexOf(u) === i);

  return (
    <div
      ref={box}
      className="relative h-full min-h-0 w-full overflow-hidden"
    >
      {list.map((src) => {
        const visible = src === shown || (!shown && src === loading);
        return (
          <iframe
            key={src}
            ref={(node) => {
              if (node) frames.current.set(src, node);
              else frames.current.delete(src);
            }}
            src={src}
            title={`Preview of the home page, as ${audience}`}
            // Scripts never run in the preview; the frame keeps its own origin.
            sandbox="allow-same-origin"
            onLoad={() => onLoad(src)}
            aria-hidden={visible ? undefined : true}
            className={`absolute border-0 bg-white ${
              framed
                ? 'top-4 left-1/2 rounded-[18px] shadow-[0_0_0_1px_var(--line),var(--shadow-card)]'
                : width === 'phone'
                  ? 'top-0 left-1/2'
                  : 'top-0 left-0'
            } ${visible ? '' : 'invisible'}`}
            style={{
              width: frameWidth,
              height: Math.max(0, height / scale),
              transform:
                width === 'phone'
                  ? `translateX(-50%) scale(${scale})`
                  : `scale(${scale})`,
              transformOrigin: width === 'phone' ? 'top center' : 'top left',
            }}
          />
        );
      })}
    </div>
  );
}

function mark(doc: Document, selected: string | null) {
  for (const el of doc.querySelectorAll('[data-studio-selected]'))
    el.removeAttribute('data-studio-selected');
  if (selected) doc.getElementById(`section-${selected}`)?.setAttribute('data-studio-selected', '');
}

function restyle(doc: Document, css: string | null) {
  const style = doc.getElementById('swarm-design-css');
  if (style && css !== null && style.textContent !== css) style.textContent = css;
}
