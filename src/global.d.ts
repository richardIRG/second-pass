import type { EditorApi } from './shared/types';

declare global {
  interface Window {
    codexEditor: EditorApi;
  }
}

export {};
