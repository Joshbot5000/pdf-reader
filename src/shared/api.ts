/** Everything the window can ask the main process to do. */
import type { ChatMsg, DownloadState, EngineStatus, LiveEvent, Meeting, ModelInfo, Para, PhoneInfo, SearchHit, Settings, StreamEvent, Summary, TemplateId, Voice } from './types';

export type Api = {
  boot(): Promise<{ settings: Settings; meetings: Meeting[]; models: ModelInfo[]; status: EngineStatus; downloads: DownloadState[]; platform: string; version: string; ask: ChatMsg[] }>;
  listMeetings(): Promise<Meeting[]>;
  getTranscript(id: string): Promise<Para[]>;
  updateMeeting(id: string, patch: Partial<Pick<Meeting, 'title' | 'folder' | 'starred' | 'notes' | 'template'>>): Promise<Meeting>;
  deleteMeeting(id: string): Promise<void>;
  updatePara(id: string, paraId: string, patch: { text?: string; hl?: boolean; note?: string; sp?: string }): Promise<Para[]>;
  renameSpeaker(id: string, speakerId: string, name: string): Promise<Meeting>;
  mergeSpeakers(id: string, from: string, into: string): Promise<{ meeting: Meeting; paras: Para[] }>;
  setSummary(id: string, summary: Summary): Promise<Meeting>;
  dismissHint(id: string, speakerId: string): Promise<Meeting>;

  recStart(opts: { template: TemplateId }): Promise<Meeting>;
  recAudio(id: string, pcm: Float32Array): void;
  recBlob(id: string, bytes: Uint8Array): void;
  recPause(id: string): Promise<void>;
  recBookmark(id: string, t: number): Promise<void>;
  recStop(id: string): Promise<Meeting>;
  recDiscard(id: string): Promise<void>;

  importFiles(paths?: string[]): Promise<Meeting[]>;
  importSample(): Promise<Meeting>;

  summarize(id: string, streamId: string, template?: TemplateId): Promise<void>;
  chat(id: string, question: string, streamId: string): Promise<ChatMsg>;
  clearChat(id: string): Promise<Meeting>;
  ask(question: string, streamId: string): Promise<ChatMsg>;
  clearAsk(): Promise<void>;
  catchUp(id: string, streamId: string): Promise<string>;
  abort(streamId: string): Promise<void>;
  search(q: string): Promise<SearchHit[]>;

  exportMeeting(id: string, format: 'md' | 'txt' | 'srt' | 'pdf' | 'audio'): Promise<string | null>;
  copyText(text: string): Promise<void>;

  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  listModels(): Promise<ModelInfo[]>;
  downloadModel(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  removeModel(id: string): Promise<ModelInfo[]>;
  listVoices(): Promise<Voice[]>;
  deleteVoice(id: string): Promise<Voice[]>;
  openDataFolder(): Promise<void>;
  micAccess(): Promise<boolean>;
  phoneInfo(): Promise<PhoneInfo>;
};

export type Events = {
  meeting: Meeting;
  meetingDeleted: string;
  live: LiveEvent;
  stream: StreamEvent;
  download: DownloadState;
  models: ModelInfo[];
  status: EngineStatus;
  command: string;
};

export type Bridge = {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  send(method: string, ...args: unknown[]): void;
  on<K extends keyof Events>(event: K, cb: (data: Events[K]) => void): () => void;
  pathFor(file: File): string;
};
