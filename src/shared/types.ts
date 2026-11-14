/** Data model shared by the main process, the AI workers and the window. */

export type Word = { t: string; s: number; e: number };

/** One speaker turn (a paragraph) of the transcript. Times are seconds from the start. */
export type Para = {
  id: string;
  sp: string;
  s: number;
  e: number;
  text: string;
  words: Word[];
  hl?: boolean;
  note?: string;
};

export type Speaker = { id: string; name: string; color: number; voiceId?: string; named?: boolean };

export type ActionItem = { id: string; text: string; owner?: string; due?: string; done: boolean };
export type Chapter = { t: number; title: string; note?: string };
export type Flashcard = { q: string; a: string };

export type TemplateId = 'meeting' | 'lecture' | 'interview' | 'memo';

export type Summary = {
  title: string;
  overview: string;
  keyPoints: string[];
  actions: ActionItem[];
  decisions: string[];
  questions: string[];
  chapters: Chapter[];
  topics: string[];
  cards: Flashcard[];
  template: TemplateId;
  model?: string;
  at?: number;
};

export type Source = { n: number; meetingId: string; title: string; t: number; date: number };
export type ChatMsg = { id: string; role: 'user' | 'assistant'; text: string; at: number; sources?: Source[] };

export type MeetingStatus = 'recording' | 'processing' | 'ready' | 'error';

export type Meeting = {
  id: string;
  title: string;
  titleAuto: boolean;
  createdAt: number;
  duration: number;
  source: 'mic' | 'import' | 'sample' | 'phone';
  status: MeetingStatus;
  progress?: number;
  error?: string;
  folder?: string;
  starred?: boolean;
  speakers: Speaker[];
  summary?: Summary;
  summaryState?: 'running' | 'error';
  summaryError?: string;
  chat: ChatMsg[];
  notes: string;
  peaks: number[];
  words: number;
  preview: string;
  template: TemplateId;
  bookmarks: number[];
  hasAudio: boolean;
  /** Names the AI worked out from the conversation, awaiting the user's confirmation. speaker id -> name */
  nameHints?: Record<string, string>;
};

export type Voice = { id: string; name: string; color: number; vec: number[]; samples: number };

export type Settings = {
  theme: 'system' | 'dark' | 'light';
  asrModel: string;
  llmModel: string;
  language: string;
  autoSummary: boolean;
  rememberVoices: boolean;
  onboarded: boolean;
  folders: string[];
  userName: string;
  /** Let a paired phone reach this library over the local network. */
  phone: boolean;
  /** Optional secure (https) address for the phone, e.g. from Tailscale. */
  phoneLink: string;
};

export type ModelKind = 'asr' | 'llm' | 'support';
export type ModelInfo = {
  id: string;
  kind: ModelKind;
  name: string;
  blurb: string;
  bytes: number;
  installed: boolean;
  recommended?: boolean;
  minRam?: number;
};
export type DownloadState = { id: string; received: number; total: number; error?: string; done?: boolean };

export type EngineStatus = {
  asr: 'missing' | 'idle' | 'loading' | 'ready' | 'error';
  llm: 'missing' | 'idle' | 'loading' | 'ready' | 'error';
  asrError?: string;
  llmError?: string;
  gpu?: string;
  ramGb: number;
};

export type SearchHit = { meetingId: string; title: string; date: number; paraId: string; t: number; speaker: string; snippet: string };

export type LiveEvent =
  | { type: 'paras'; meetingId: string; paras: Para[]; speakers: Speaker[]; duration: number; replace: boolean }
  | { type: 'partial'; meetingId: string; text: string }
  | { type: 'progress'; meetingId: string; progress: number };

export type StreamEvent = { streamId: string; delta?: string; done?: boolean; error?: string; sources?: Source[]; stage?: string };

export type PhoneInfo = { enabled: boolean; running: boolean; port: number; lan: string[]; url: string; qr: string; secure: boolean; connected: number; error?: string };

export const SPEAKER_COLORS = 8;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  asrModel: 'whisper-small',
  llmModel: 'qwen-4b',
  language: 'en',
  autoSummary: true,
  rememberVoices: true,
  onboarded: false,
  folders: [],
  userName: '',
  phone: true,
  phoneLink: '',
};

export const LANGUAGES: [string, string][] = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['pl', 'Polish'], ['sv', 'Swedish'], ['tr', 'Turkish'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
  ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
];

export const uid = (): string => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
