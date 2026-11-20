// A publication's tracking choices as read from channels.settings_json (tracking-choices.ts).
import { describe, expect, it } from 'vitest';
import { channelSettings } from '../src/tracking-choices';

describe('channelSettings', () => {
  it('tracks and profiles by default', () => {
    expect(channelSettings('{}')).toEqual({
      trackOpens: true,
      trackClicks: true,
      profileReaders: true,
    });
  });

  it('turns each off only on false', () => {
    expect(channelSettings('{"trackClicks":false,"trackOpens":"no"}')).toEqual({
      trackOpens: true,
      trackClicks: false,
      profileReaders: true,
    });
    expect(channelSettings('{"profileReaders":false}').profileReaders).toBe(false);
  });

  it('never profiles without open tracking', () => {
    expect(channelSettings('{"trackOpens":false,"profileReaders":true}')).toEqual({
      trackOpens: false,
      trackClicks: true,
      profileReaders: false,
    });
  });
});
