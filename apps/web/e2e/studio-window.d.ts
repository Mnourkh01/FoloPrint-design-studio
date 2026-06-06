/**
 * Shared shape of the canvas handle the editor exposes for the e2e suite
 * (window.__studioCanvas, set in editor-client.tsx). One declaration for every
 * spec file: per-file `declare global` blocks with diverging shapes are a TS2717.
 */
export {};

declare global {
  interface Window {
    __studioCanvas?: {
      backgroundImage?: unknown;
      getZoom(): number;
      getObjects(): Array<Record<string, unknown>>;
      getActiveObject(): Record<string, unknown> | undefined;
    };
  }
}
