// A stand-in for the capture worker: its only way to the vault is its VAULT binding, pinned to
// the CaptureVault entrypoint (tests/bindings.test.ts). It calls whatever method a test names and
// returns what came back, or the error, as JSON.
export default {
  async fetch(request, env) {
    const { method, args } = await request.json();
    try {
      const value = await env.VAULT[method](...args);
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json({ ok: false, error: String(error && error.message) });
    }
  },
};
