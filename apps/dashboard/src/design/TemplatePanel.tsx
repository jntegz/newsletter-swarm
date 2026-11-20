// Template: the built-in designs as a grid of compact cards, two to a row. Choosing one keeps the style settings and
// the sections (the themes share their section types and tokens) and says so, with Undo. A design
// with its own code is warned first that choosing replaces that code.
import type { Design } from '@swarm/site-themes';
import { useState } from 'react';
import * as Icon from '../icons';
import { useToast } from '../shell/toast';
import { switchTheme, type ThemeChoice } from './draft';
import { useStudio } from './studio';

export function TemplatePanel() {
  const { themes, draft, canEdit } = useStudio();
  const toast = useToast();
  const { design } = draft;
  const ownCode = design.files !== null;

  const choose = (theme: ThemeChoice) => {
    if (theme.id === design.theme && !ownCode) return;
    const before: Design = design;
    draft.change((d) => switchTheme(d, theme.id));
    // Sections nobody arranged yet are the theme's own starting set, so they follow the template.
    const kept = design.sections ? 'Your style and sections came along' : 'Your style came along';
    toast.show({
      message: ownCode
        ? `Now using ${theme.name}. Its files replaced your own code. ${kept}.`
        : `Now using ${theme.name}. ${kept}${design.sections ? '' : ', with its starting sections'}.`,
      action: { label: 'Undo', onAction: () => draft.change(() => before) },
    });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div>
        <h2 className="text-[17px] font-[650]">Template</h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-sub">
          Starting designs. Switching keeps your words, images, sections and style; only the look
          changes.
        </p>
      </div>
      {ownCode && (
        <p className="rounded-control bg-warn-soft px-3 py-2.5 text-[13px] leading-[1.5] text-warn">
          This design has its own code. Choosing a template replaces that code with the template’s
          files. You can undo it straight after.
        </p>
      )}
      {themes.length === 0 ? (
        <p className="text-[13px] text-sub">
          The templates aren’t available right now. Reload the page to try again.
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3" aria-label="Templates">
          {themes.map((theme) => {
            const current = theme.id === design.theme;
            return (
              <li key={theme.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={current && !ownCode}
                  disabled={!canEdit}
                  onClick={() => choose(theme)}
                  className={`group grid h-full w-full content-start overflow-hidden rounded-card border text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple disabled:cursor-not-allowed ${
                    current
                      ? 'border-purple shadow-[0_0_0_1px_var(--purple)]'
                      : 'border-line hover:border-line-control'
                  }`}
                >
                  <Thumbnail theme={theme} />
                  <span className="grid gap-0.5 border-t border-line px-3 pt-2 pb-2.5">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-[14px] font-semibold">{theme.name}</span>
                      {current && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[12px] font-semibold text-route">
                          <Icon.Check size={13} />
                          {ownCode ? 'Started from' : 'In use'}
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-[12px] leading-[1.45] text-sub">
                      {theme.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The theme's defaults for the placeholder drawing: colours and fonts from its theme.json. */
function defaultsOf(theme: ThemeChoice): { accent: string; page: string; ink: string } {
  try {
    const manifest = JSON.parse(theme.files['theme.json'] ?? '{}') as {
      settings?: { id: string; default?: unknown }[];
    };
    const get = (id: string, fallback: string) => {
      const v = manifest.settings?.find((s) => s.id === id)?.default;
      return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
    };
    return {
      accent: get('accent', '#2f5d50'),
      page: get('page', '#fbfaf7'),
      ink: get('ink', '#16181d'),
    };
  } catch {
    return { accent: '#2f5d50', page: '#fbfaf7', ink: '#16181d' };
  }
}

/**
 * The template's picture. Until the real screenshots exist, a small drawing of a page in the
 * template's own colours stands in: a heading, a line of text, a signup field and three cards.
 */
function Thumbnail({ theme }: { theme: ThemeChoice }) {
  const [failed, setFailed] = useState(false);
  const colours = defaultsOf(theme);
  return (
    <span className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-alt">
      {!failed && (
        <img
          src={`/theme-thumbs/${theme.id}.webp`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover object-top"
        />
      )}
      {failed && (
        <svg
          viewBox="0 0 320 200"
          aria-hidden="true"
          className="absolute inset-0 size-full"
          preserveAspectRatio="xMidYMid slice"
        >
          <rect width="320" height="200" fill={colours.page} />
          <rect x="24" y="18" width="56" height="8" rx="2" fill={colours.ink} opacity="0.85" />
          <rect x="232" y="16" width="64" height="12" rx="6" fill={colours.accent} />
          <rect x="24" y="52" width="180" height="16" rx="3" fill={colours.ink} />
          <rect x="24" y="76" width="220" height="7" rx="2" fill={colours.ink} opacity="0.45" />
          <rect x="24" y="88" width="160" height="7" rx="2" fill={colours.ink} opacity="0.45" />
          <rect
            x="24"
            y="106"
            width="150"
            height="20"
            rx="4"
            fill="none"
            stroke={colours.ink}
            strokeOpacity="0.35"
          />
          <rect x="180" y="106" width="64" height="20" rx="4" fill={colours.accent} />
          {[24, 124, 224].map((x) => (
            <g key={x}>
              <rect x={x} y="146" width="72" height="34" rx="4" fill={colours.ink} opacity="0.08" />
              <rect x={x} y="186" width="56" height="5" rx="2" fill={colours.ink} opacity="0.5" />
            </g>
          ))}
        </svg>
      )}
    </span>
  );
}
