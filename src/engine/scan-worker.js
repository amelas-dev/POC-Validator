// worker.js — runs the heavy corpus scan off the main thread.
//
// extractFactsCore() is the only expensive step (regex scan + fact derivation over the
// whole corpus); on a very large paste — tens of MB / ~1M lines — it can take many
// seconds. Doing it here keeps the UI thread free, so the "Reading your tool…" animation
// never freezes and the page stays responsive. The cheap resolve() + safety clamp stay on
// the main thread, which re-attaches the evOf closure via hydrateFacts(core). If this
// worker can't be created (older browser, file:// origin), app.js falls back to a
// synchronous scan and behaviour is unchanged.
import { extractFactsCore } from './classify.js';

self.onmessage = (e) => {
  const { id, corpus } = e.data || {};
  try {
    const core = extractFactsCore(corpus);
    self.postMessage({ id, ok: true, core });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
