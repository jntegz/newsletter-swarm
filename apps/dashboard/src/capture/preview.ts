// The builder's live preview: a static page (no scripts) drawn from the draft config, shown in a
// sandboxed iframe through srcdoc.
//
// It mirrors what the capture worker serves:
// - the form markup and styles of workers/capture/src/frame.ts (fieldHtml, FRAME_STYLE), scoped
//   under .sf because the preview draws the form straight into the mock page instead of a
//   second iframe;
// - the wrapper, close button and placement styles of the loader in packages/engine/src/embed.ts.
// Turnstile is never loaded here; a dashed box marks where the challenge would appear.
// Keep this file in step with those two when either changes.
import { consentHtml, type MemberField } from '@swarm/domain';
import { isOverlay, type Config } from './config';

export type PreviewState = 'hidden' | 'form' | 'success';

export interface PreviewInput {
  config: Config;
  /** The Channel's profile fields, to render `field:<key>` entries by type. */
  defs: readonly MemberField[];
  accent: string;
  state: PreviewState;
  /** Simulated scroll depth of the mock page, 0–100. */
  scroll?: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const safeAccent = (accent: string) => (/^#[0-9a-f]{6}$/i.test(accent) ? accent : '#6c4cf1');

/** Every control is out of the dashboard's tab order: the preview is for looking at. */
const NO_TAB = ' tabindex="-1"';

type Field = Config['fields'][number];

function fieldHtml(field: Field, defs: ReadonlyMap<string, MemberField>): string {
  const req = field.required ? ' required' : '';
  const ph = field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : '';
  const label = esc(field.label);
  if (field.key === 'email') {
    return `<label>${label}<input type="email" name="email"${ph} required${NO_TAB}></label>`;
  }
  if (field.key === 'first_name' || field.key === 'last_name') {
    const name = field.key === 'first_name' ? 'firstName' : 'lastName';
    return `<label>${label}<input type="text" name="${name}"${ph}${req}${NO_TAB}></label>`;
  }
  const def = defs.get(field.key.slice('field:'.length));
  if (!def) return '';
  const name = esc(`f.${def.key}`);
  switch (def.type) {
    case 'number':
      return `<label>${label}<input type="number" name="${name}"${ph}${req}${NO_TAB}></label>`;
    case 'date':
      return `<label>${label}<input type="date" name="${name}"${req}${NO_TAB}></label>`;
    case 'boolean':
      return `<label class="choice"><input type="checkbox" name="${name}"${req}${NO_TAB}> ${label}</label>`;
    case 'select':
      if (field.display === 'radio') {
        return `<fieldset><legend>${label}</legend>${def.options
          .map(
            (o) =>
              `<label class="choice"><input type="radio" name="${name}" value="${esc(o)}"${req}${NO_TAB}> ${esc(o)}</label>`,
          )
          .join('')}</fieldset>`;
      }
      return `<label>${label}<select name="${name}"${req}${NO_TAB}><option value="">Choose…</option>${def.options
        .map((o) => `<option>${esc(o)}</option>`)
        .join('')}</select></label>`;
    case 'multi_select':
      return `<fieldset><legend>${label}</legend>${def.options
        .map(
          (o) =>
            `<label class="choice"><input type="checkbox" name="${name}" value="${esc(o)}"${NO_TAB}> ${esc(o)}</label>`,
        )
        .join('')}</fieldset>`;
    default:
      return `<label>${label}<input type="text" name="${name}"${ph}${req}${NO_TAB}></label>`;
  }
}

// FRAME_STYLE from workers/capture/src/frame.ts, scoped under .sf.
const FORM_STYLE = `.sf,.sf *{box-sizing:border-box}
.sf{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;color:#0f0f12;text-align:left}
.sf .m{padding:24px;background:#fff;border:1px solid #efedf6;border-radius:16px}
.sf h2{font-size:20px;letter-spacing:-0.02em;margin:0 0 8px}
.sf p{font-size:14px;line-height:1.5;color:#3a3a44;margin:0 0 14px}
.sf label,.sf legend{display:block;font-size:13px;font-weight:500;margin:0 0 10px}
.sf input[type=text],.sf input[type=email],.sf input[type=number],.sf input[type=date],.sf select{display:block;width:100%;margin-top:4px;font:inherit;font-size:15px;padding:10px 12px;border:1px solid #e7e5ee;border-radius:10px;background:transparent;color:inherit}
.sf fieldset{border:0;padding:0;margin:0 0 10px}
.sf .choice{display:flex;gap:8px;align-items:flex-start;font-weight:400}
.sf .choice a{color:inherit;text-decoration:underline}
.sf .submit{font:inherit;font-weight:600;font-size:15px;color:#fff;background:var(--accent);border:0;border-radius:999px;padding:11px 20px;width:100%}
.sf .status{font-size:14px;margin:10px 0 0}.sf .status.done{color:#1f7a4d;font-weight:600}
.sf .ts{margin:0 0 10px;padding:8px 10px;border:1px dashed #d9d2f5;border-radius:10px;font-size:12px;color:#6b6b76}
.sf.slim .m{padding:14px}.sf.slim form{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}.sf.slim form>*{margin:0}.sf.slim label{flex:1 1 200px}.sf.slim .submit{width:auto}
.sf.slim .ts{flex-basis:100%}
@media (prefers-color-scheme:dark){.sf.auto .m{background:#17171c;border-color:#2a2a33;color:#f4f3f8}.sf.auto p{color:#c9c8d3}.sf.auto input,.sf.auto select{border-color:#2a2a33}}
.sf.dark .m{background:#17171c;border-color:#2a2a33;color:#f4f3f8}.sf.dark p{color:#c9c8d3}.sf.dark input,.sf.dark select{border-color:#2a2a33}`;

// The mock host page and the loader's wrapper styles (embed.ts show()).
const PAGE_STYLE = `html,body{margin:0;height:100%}
body{font-family:Georgia,'Times New Roman',serif;background:#fbfbfd;color:#0f0f12;overflow:hidden}
.site{position:absolute;inset:0;overflow:hidden}
.bar{display:flex;align-items:center;gap:10px;height:52px;padding:0 20px;background:#fff;border-bottom:1px solid #ececf2;font:600 14px -apple-system,'Segoe UI',system-ui,sans-serif}
.logo{width:22px;height:22px;border-radius:6px;background:#d9d2f5}
.nav{margin-left:auto;display:flex;gap:12px}.nav i{display:block;width:44px;height:8px;border-radius:4px;background:#ececf2}
.article{max-width:640px;margin:0 auto;padding:32px 20px 400px}
.title{height:26px;width:72%;border-radius:6px;background:#d5d3de;margin:0 0 18px}
.line{height:10px;border-radius:5px;background:#e4e2ec;margin:0 0 10px}
.gap{height:14px}
.slot{margin:22px auto;padding:14px;border:1px dashed #c9bfef;border-radius:12px;text-align:center;font:13px -apple-system,'Segoe UI',system-ui,sans-serif;color:#6b6b76}
.depth{position:fixed;top:60px;right:4px;bottom:8px;width:4px;border-radius:2px;background:#eeecf4}
.depth b{position:absolute;left:0;right:0;height:40px;border-radius:2px;background:#b9b5c6}
.wrap{position:fixed;z-index:10}
.box{position:relative;overflow:hidden;border-radius:16px;box-shadow:0 12px 40px rgba(15,15,18,0.18)}
.x{position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;border-radius:999px;background:rgba(15,15,18,0.08);color:#0f0f12;font:20px/1 system-ui,sans-serif}
.popup{inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,15,18,0.45)}
.slide{bottom:16px;width:min(380px,calc(100vw - 32px))}
.sticky{left:0;right:0}.sticky .box{border-radius:0}`;

function formHtml(input: PreviewInput): string {
  const { config } = input;
  const defs = new Map(input.defs.map((d) => [d.key, d]));
  const fields = config.fields.map((f) => fieldHtml(f, defs)).join('');
  const consent = config.consent
    ? `<label class="choice"><input type="checkbox" name="consent"${config.consent.required ? ' required' : ''}${NO_TAB}> ${consentHtml(config.consent.text).replace(/<a /g, `<a${NO_TAB} `)}</label>`
    : '';
  const intro =
    config.layout === 'slim'
      ? ''
      : `${config.copy.heading ? `<h2>${esc(config.copy.heading)}</h2>` : ''}${config.copy.body ? `<p>${esc(config.copy.body)}</p>` : ''}`;
  const done = input.state === 'success';
  const status = done
    ? config.success.type === 'message'
      ? esc(config.success.message)
      : `Sends the visitor to ${esc(config.success.url)}`
    : '';
  const form = done
    ? ''
    : `<form>${fields}${consent}<div class="ts">Bot check (shown only when needed)</div><button type="button" class="submit"${NO_TAB}>${esc(config.copy.button)}</button></form>`;
  return `<div class="sf ${config.layout} ${config.theme.mode}"><div class="m">${intro}${form}<p class="status${done ? ' done' : ''}">${status}</p></div></div>`;
}

function article(slot: string): string {
  const lines = (widths: number[]) =>
    widths.map((w) => `<div class="line" style="width:${w}%"></div>`).join('');
  return `<div class="article"><div class="title"></div>${lines([100, 96, 98, 72])}<div class="gap"></div>${lines([100, 94, 88])}${slot}${lines([100, 97, 92, 99, 64])}<div class="gap"></div>${lines([100, 95, 98, 90, 100, 58])}<div class="gap"></div>${lines([100, 93, 97, 82])}</div>`;
}

/** The whole srcdoc document. Every config string is escaped; there are no scripts. */
export function buildPreviewHtml(input: PreviewInput): string {
  const { config } = input;
  const slim = config.layout === 'slim';
  const visible = input.state !== 'hidden';
  const scroll = Math.max(0, Math.min(100, input.scroll ?? 0));
  const form = visible ? formHtml(input) : '';
  const title = esc(config.copy.heading || 'Sign-up form');

  let slot = '';
  let overlay = '';
  if (!isOverlay(config.placement)) {
    slot = visible
      ? `<div style="width:100%;max-width:${slim ? 720 : 480}px;margin:22px auto">${form}</div>`
      : '<div class="slot">The form appears here when its trigger fires.</div>';
  } else if (visible) {
    const close = '<button type="button" class="x" aria-label="Close" tabindex="-1">×</button>';
    if (config.placement === 'popup') {
      overlay = `<div class="wrap popup" role="dialog" aria-label="${title}"><div class="box" style="width:100%;max-width:${slim ? 560 : 440}px">${form}${close}</div></div>`;
    } else if (config.placement === 'slide_in_left' || config.placement === 'slide_in_right') {
      const side = config.placement === 'slide_in_left' ? 'left' : 'right';
      overlay = `<div class="wrap slide" style="${side}:16px" role="complementary" aria-label="${title}"><div class="box">${form}${close}</div></div>`;
    } else {
      const edge = config.placement === 'sticky_top' ? 'top' : 'bottom';
      overlay = `<div class="wrap sticky" style="${edge}:0" role="complementary" aria-label="${title}"><div class="box">${form}${close}</div></div>`;
    }
  }

  const offset = Math.round(scroll * 6);
  const thumb = `top:calc(${scroll}% - ${Math.round(scroll * 0.4)}px)`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview</title>
<style>${PAGE_STYLE}
${FORM_STYLE}
.sf{--accent:${safeAccent(input.accent)}}</style></head><body>
<div class="site"><div class="bar"><span class="logo"></span>Your site<span class="nav"><i></i><i></i><i></i></span></div>
<div style="transform:translateY(-${offset}px)">${article(slot)}</div></div>
<div class="depth" aria-hidden="true"><b style="${thumb}"></b></div>
${overlay}
</body></html>`;
}
