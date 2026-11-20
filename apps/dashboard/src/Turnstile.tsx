import { useEffect, useRef } from 'react';

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance?: 'always' | 'execute' | 'interaction-only';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile missing'));
    script.onerror = () => {
      loading = null;
      reject(new Error('Turnstile failed to load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare's bot check. It usually completes invisibly; it only asks for interaction
 * when it is unsure. The token goes to the API, which verifies it server-side.
 */
export function Turnstile({
  siteKey,
  action,
  onToken,
  onError,
}: {
  siteKey: string;
  action: string;
  onToken: (token: string | null) => void;
  onError: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onToken, onError });
  useEffect(() => {
    callbacks.current = { onToken, onError };
  });

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !ref.current) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: siteKey,
          action,
          appearance: 'interaction-only',
          callback: (token) => callbacks.current.onToken(token),
          'expired-callback': () => callbacks.current.onToken(null),
          'error-callback': () => callbacks.current.onError(),
        });
      })
      .catch(() => callbacks.current.onError());
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, action]);

  return <div ref={ref} />;
}
