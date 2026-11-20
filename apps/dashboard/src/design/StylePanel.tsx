// Style: the theme's settings (theme.json), drawn as controls by group, with the contrast checked
// as colours change. Changes reach the preview at once (same-origin preview) or with a quick save.
import type { Design } from '@swarm/site-themes';
import { contrastWarnings, resolveSettings } from '@swarm/site-themes';
import { Button } from '@swarm/ui/components';
import { useMemo } from 'react';
import * as Icon from '../icons';
import { useToast } from '../shell/toast';
import { SettingsForm } from './SettingControls';
import { withValue } from './settings-form';
import { useStudio } from './studio';

export function StylePanel() {
  const { draft, channelId, canEdit } = useStudio();
  const toast = useToast();
  const { design, theme } = draft;
  const defs = useMemo(() => theme?.settings ?? [], [theme]);
  const values = useMemo(() => resolveSettings(defs, design.settings), [defs, design.settings]);
  const warnings = contrastWarnings(values, defs);
  const changed = Object.keys(design.settings).some((id) => defs.some((d) => d.id === id));

  if (!theme) {
    return (
      <p className="text-[13px] text-sub">
        The theme’s files have problems, so its settings can’t be shown. Fix them in Code.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h2 className="text-[17px] font-[650]">Style</h2>
        <p className="mt-1 text-[13px] leading-[1.55] text-sub">
          Colours, type and shape for the whole site: the home page, posts and the archive.
        </p>
      </div>
      {defs.length === 0 ? (
        <p className="text-[13px] text-sub">This theme declares no style settings.</p>
      ) : (
        <SettingsForm
          defs={defs}
          values={values}
          context={{ channelId, disabled: !canEdit }}
          onChange={(id, value) =>
            draft.change((d) => ({ ...d, settings: withValue(d.settings, id, value) }), {
              soon: true,
            })
          }
          after={(group) =>
            group === (defs.find((d) => d.type === 'color')?.group ?? null) && (
              <div role="status" className="grid grid-cols-[minmax(0,1fr)] gap-2 empty:hidden">
                {warnings.map((warning) => (
                  <p
                    key={warning}
                    className="flex items-start gap-2 rounded-control bg-warn-soft px-3 py-2 text-[13px] leading-[1.5] text-warn"
                  >
                    <Icon.Alert size={16} className="mt-0.5 shrink-0" />
                    {warning}
                  </p>
                ))}
              </div>
            )
          }
        />
      )}
      {canEdit && changed && (
        <div className="border-t border-line pt-4">
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              const before: Design = design;
              draft.change((d) => ({ ...d, settings: {} }), { soon: true });
              toast.show({
                message: `Style is back to ${theme.name}’s own.`,
                action: { label: 'Undo', onAction: () => draft.change(() => before, { soon: true }) },
              });
            }}
          >
            Reset style to the theme’s
          </Button>
        </div>
      )}
    </div>
  );
}
