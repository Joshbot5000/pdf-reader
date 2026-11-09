export interface OpenedFile {
  path: string;
  name: string;
  data: Uint8Array;
}

export type MenuAction =
  | 'open'
  | 'save'
  | 'saveAs'
  | 'insertPdf'
  | 'find'
  | 'zoomIn'
  | 'zoomOut'
  | 'fitWidth';

/** The API the preload script exposes to the renderer as `window.api`. */
export interface DesktopApi {
  openDialog(): Promise<OpenedFile | null>;
  openPath(path: string): Promise<OpenedFile>;
  save(path: string, data: Uint8Array): Promise<void>;
  saveAs(suggestedName: string, data: Uint8Array): Promise<OpenedFile | null>;
  setDirty(dirty: boolean): void;
  takePendingOpen(): Promise<string | null>;
  pathForFile(file: File): string;
  onMenu(cb: (action: MenuAction) => void): void;
  onOpenRequest(cb: (path: string) => void): void;
}
