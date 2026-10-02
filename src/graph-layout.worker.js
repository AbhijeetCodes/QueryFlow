// Lays out big graphs off the main thread, so opening the Graph tab never freezes the page.
import { layoutGraph } from './graph-layout.js';

self.onmessage = (e) => {
  const { id, input } = e.data;
  try {
    self.postMessage({ id, result: layoutGraph(input) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
