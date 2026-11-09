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
  | 'fitWidth'
  | 'palette'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'undo'
  | 'redo'
  | 'home'
  | 'settings';

// ---------------------------------------------------------------- persisted state

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

export interface SavedSignature {
  id: string;
  kind: 'signature' | 'initials';
  /** PNG data URL with a transparent background. */
  dataUrl: string;
  createdAt: number;
}

export interface FieldLayout {
  name: string;
  type: 'text' | 'checkbox' | 'dropdown' | 'signature';
  page: number;
  rect: { x: number; y: number; width: number; height: number };
  options?: string[];
}

export interface FormTemplate {
  id: string;
  name: string;
  fields: FieldLayout[];
  createdAt: number;
}

export type BrandPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface BrandProfile {
  logoDataUrl: string | null;
  url: string;
  text: string;
  position: BrandPosition;
  logoHeight: number;
  pages: 'all' | 'first';
}

export interface SpaceSource {
  id: string;
  kind: 'pdf' | 'text' | 'url';
  title: string;
  /** File name inside the space's folder. */
  file: string;
  url?: string;
  size: number;
  addedAt: number;
}

export interface Space {
  id: string;
  name: string;
  instructions: string;
  sources: SpaceSource[];
  createdAt: number;
}

export interface AppState {
  recent: RecentFile[];
  signatures: SavedSignature[];
  templates: FormTemplate[];
  brand: BrandProfile | null;
  spaces: Space[];
  settings: { theme: 'system' | 'dark' | 'light'; aiProvider?: 'gemini' | 'claude'; geminiModel?: string };
}

// ---------------------------------------------------------------- OCR

export interface OcrWord {
  text: string;
  confidence: number;
  /** Pixel box in the submitted image. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

// ---------------------------------------------------------------- AI

export type AiDoc =
  | { kind: 'pdf'; title: string; data: Uint8Array }
  | { kind: 'text'; title: string; text: string };

export interface AiCitation {
  citedText: string;
  documentIndex: number;
  documentTitle: string | null;
  startPage?: number;
  endPage?: number;
}

export interface AiBlock {
  text: string;
  citations: AiCitation[];
}

export type AiEvent =
  | { requestId: string; type: 'delta'; text: string }
  | { requestId: string; type: 'thinking' }
  | { requestId: string; type: 'done'; blocks: AiBlock[]; stopReason: string | null }
  | { requestId: string; type: 'error'; message: string };

export interface AiStatus {
  provider: 'gemini' | 'claude';
  /** A key is set for the active provider. */
  hasKey: boolean;
  keys: { gemini: boolean; claude: boolean };
  /** The model in use, when known. */
  model: string | null;
}

export interface AiChatRequest {
  conversationId: string;
  /** Sources for a new conversation: the open document, or a Space. */
  docs?: AiDoc[];
  spaceId?: string;
  text: string;
}

export interface SlideOutline {
  title: string;
  subtitle: string;
  slides: { title: string; bullets: string[]; notes: string }[];
}

/** The API the preload script exposes to the renderer as `window.api`. */
export interface DesktopApi {
  platform: NodeJS.Platform;
  openDialog(): Promise<OpenedFile | null>;
  openPath(path: string): Promise<OpenedFile>;
  save(path: string, data: Uint8Array): Promise<void>;
  saveAs(suggestedName: string, data: Uint8Array): Promise<OpenedFile | null>;
  exportFile(suggestedName: string, data: Uint8Array, ext: string, label: string): Promise<string | null>;
  pickFiles(filters: { name: string; extensions: string[] }[], multi: boolean): Promise<{ path: string; name: string; data: Uint8Array }[]>;
  /** Tell the window which document is open and whether it has unsaved changes. */
  setDocState(state: { dirty: boolean; path: string | null; name: string | null }): void;
  /** Main process asks the page to save, then close the window (from the close prompt). */
  onSaveAndClose(cb: () => void): void;
  closeWindow(): void;
  findFont(pdfFontName: string, hint: { bold?: boolean; italic?: boolean }): Promise<Uint8Array | null>;
  /** Installed font families (for the font picker). */
  listFonts(): Promise<string[]>;
  takePendingOpen(): Promise<string | null>;
  pathForFile(file: File): string;
  onMenu(cb: (action: MenuAction) => void): void;
  onOpenRequest(cb: (path: string) => void): void;

  getState(): Promise<AppState>;
  setState<K extends keyof AppState>(key: K, value: AppState[K]): Promise<AppState>;

  ocr(png: Uint8Array): Promise<OcrWord[]>;

  aiStatus(): Promise<AiStatus>;
  aiSetKey(provider: 'gemini' | 'claude', key: string | null): Promise<void>;
  /** Free Gemini models this key can use (best first). */
  aiGeminiModels(): Promise<string[]>;
  /** Send a tiny request with the saved Gemini key: which model works, or Google's error. */
  aiTestGemini(): Promise<{ ok: boolean; model: string | null; message: string }>;
  aiChat(req: AiChatRequest): Promise<string>;
  aiCancel(requestId: string): void;
  aiForget(conversationId: string): void;
  onAiEvent(cb: (e: AiEvent) => void): void;
  aiSlides(req: { docs?: AiDoc[]; spaceId?: string; focus: string }): Promise<SlideOutline>;
  saveSlides(outline: SlideOutline): Promise<string | null>;

  spaceAddFiles(spaceId: string): Promise<AppState>;
  spaceAddUrl(spaceId: string, url: string): Promise<AppState>;
  spaceAddPath(spaceId: string, path: string): Promise<AppState>;
  spaceRemoveSource(spaceId: string, sourceId: string): Promise<AppState>;
  spaceDelete(spaceId: string): Promise<AppState>;
}
