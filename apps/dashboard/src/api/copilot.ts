// Copilot (Phase 8): the editor assistant's event stream, Copilot actions (Ask Copilot to do it),
// Settings → Copilot queries and the workspace key. The browser only ever talks to Swarm's API;
// provider keys stay on the server.
import type {
  CopilotActionDecision,
  CopilotActionResult,
  CopilotActionRun,
  CopilotDoneEvent,
  CopilotErrorEvent,
  CopilotRequestLog,
  CopilotRun,
  CopilotSettings,
  ErrorCode,
  SaveCopilotKey,
} from '@swarm/domain';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client';

const copilotKeys = {
  settings: (workspaceId: string) => ['workspaces', workspaceId, 'copilot'] as const,
  log: (workspaceId: string) => ['workspaces', workspaceId, 'copilot', 'requests'] as const,
};

export const copilotSettingsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: copilotKeys.settings(workspaceId),
    queryFn: ({ signal }) =>
      api.get<CopilotSettings>(`/api/v1/workspaces/${workspaceId}/copilot`, signal),
    retry: false,
  });

export const copilotLogQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: copilotKeys.log(workspaceId),
    queryFn: ({ signal }) =>
      api.get<CopilotRequestLog[]>(
        `/api/v1/workspaces/${workspaceId}/copilot/requests?limit=50`,
        signal,
      ),
  });

export function useSaveCopilotKey(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCopilotKey) =>
      api.put<CopilotSettings>(`/api/v1/workspaces/${workspaceId}/copilot/key`, input),
    onSuccess: (data) => client.setQueryData(copilotKeys.settings(workspaceId), data),
  });
}

export function useCopilotKeyCap(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (monthlyUnitCap: number | null) =>
      api.patch<CopilotSettings>(`/api/v1/workspaces/${workspaceId}/copilot/key`, {
        monthlyUnitCap,
      }),
    onSuccess: (data) => client.setQueryData(copilotKeys.settings(workspaceId), data),
  });
}

export function useDeleteCopilotKey(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/api/v1/workspaces/${workspaceId}/copilot/key`),
    onSuccess: () => client.invalidateQueries({ queryKey: copilotKeys.settings(workspaceId) }),
  });
}

// ---- Copilot actions -------------------------------------------------------------------------

export function useCopilotActions(channelId: string) {
  return useMutation({
    mutationFn: (input: CopilotActionRun) =>
      api.post<CopilotActionResult>(`/api/v1/channels/${channelId}/copilot/actions`, input),
  });
}

/**
 * Confirm or cancel a call the operator's own Copilot request held. A confirmation carries the
 * digest of the request the operator was shown; the API runs nothing if it differs.
 */
export function useDecideCopilotAction(channelId: string) {
  return useMutation({
    mutationFn: ({
      approvalId,
      decision,
      requestDigest,
    }: {
      approvalId: string;
      decision: 'confirm' | 'cancel';
      requestDigest: string;
    }) =>
      api.post<CopilotActionDecision>(
        `/api/v1/channels/${channelId}/copilot/actions/${approvalId}/${decision}`,
        decision === 'confirm' ? { requestDigest } : undefined,
      ),
  });
}

// ---- The event stream ------------------------------------------------------------------------

interface SseEvent {
  event: string;
  data: string;
}

/**
 * Splits a text/event-stream buffer into complete events; `rest` is the incomplete tail to keep
 * for the next chunk. Only `event:` and `data:` fields are used (that is all Copilot sends).
 */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const normalised = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/** A failure the model side reported inside the stream (the request itself was accepted). */
export class CopilotStreamError extends Error {
  constructor(
    readonly code: CopilotErrorEvent['code'],
    message: string,
  ) {
    super(message);
    this.name = 'CopilotStreamError';
  }
}

/**
 * Runs one Copilot request. Calls onDelta with each piece of text as it arrives and resolves with
 * the final result. Rejects with ApiError when the request is refused before streaming (flag,
 * role, limits), CopilotStreamError when the model side fails, or AbortError when aborted.
 */
export async function streamCopilot(
  dispatchId: string,
  input: CopilotRun,
  options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {},
): Promise<CopilotDoneEvent> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/dispatches/${dispatchId}/copilot`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(
      'network',
      'Swarm could not be reached. Check your connection and try again.',
      0,
    );
  }
  if (!res.ok || !res.body) {
    // The refusal is an ordinary JSON error envelope: let the shared client read it.
    const payload = (await res.json().catch(() => null)) as {
      error?: { code: ErrorCode; message: string; details?: { path: string; message: string }[] };
    } | null;
    if (payload?.error) {
      throw new ApiError(
        payload.error.code,
        payload.error.message,
        res.status,
        payload.error.details,
      );
    }
    throw new ApiError(
      'internal',
      'Something went wrong on our side. Try again in a moment.',
      res.status,
    );
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += value;
    const parsed = parseSse(done ? `${buffer}\n\n` : buffer);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.event === 'delta') {
        options.onDelta?.((JSON.parse(event.data) as { text: string }).text);
      } else if (event.event === 'done') {
        await reader.cancel().catch(() => undefined);
        return JSON.parse(event.data) as CopilotDoneEvent;
      } else if (event.event === 'error') {
        const failure = JSON.parse(event.data) as CopilotErrorEvent;
        throw new CopilotStreamError(failure.code, failure.message);
      }
    }
    if (done) break;
  }
  throw new CopilotStreamError('internal', 'The answer ended early. Try again.');
}
