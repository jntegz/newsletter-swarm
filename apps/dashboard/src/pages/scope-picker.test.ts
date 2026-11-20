import { API_SCOPES, scopeAllows } from '@swarm/domain';
import { describe, expect, it } from 'vitest';
import { accessOf, allScopesOf, RESOURCE_LABEL, scopesOf } from './ScopePicker';

describe('the access list', () => {
  it('names every resource in plain words', () => {
    for (const scope of API_SCOPES) expect(RESOURCE_LABEL[scope.split(':')[0]!]).toBeTruthy();
  });

  it('asks for the write scope alone on a key, which also grants read', () => {
    const scopes = scopesOf({ members: 'write', channels: 'read', flows: 'none' });
    expect(scopes.sort()).toEqual(['channels:read', 'members:write']);
    expect(scopeAllows(scopes, 'members:read')).toBe(true);
  });

  it('lists both scopes for an OAuth app, whose list is matched exactly', () => {
    expect(allScopesOf({ members: 'write', channels: 'read' }).sort()).toEqual([
      'channels:read',
      'members:read',
      'members:write',
    ]);
  });

  it('shows saved scopes at their highest level, whichever order they come in', () => {
    expect(accessOf(['members:write', 'members:read', 'audit:read'])).toEqual({
      members: 'write',
      audit: 'read',
    });
  });

  it('keeps an OAuth app with every scope unchanged through the list', () => {
    expect(allScopesOf(accessOf(API_SCOPES)).sort()).toEqual([...API_SCOPES].sort());
  });
});
