import type { HelmApi } from '../../preload/index.js';

declare global {
  interface Window {
    /** Injected by the preload contextBridge. The renderer's whole world. */
    helm: HelmApi;
  }
}

export {};
