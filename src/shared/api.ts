/** Everything the window can ask the main process to do. */
import type { CaseRef, Difficulty, NoteStyle, Practice, StudyPack, TopicRow } from './law';
import type { ChatMsg, DownloadState, ParaTag, TutorMode, EngineStatus, LiveEvent, Meeting, ModelInfo, Para, PhoneInfo, SearchHit, Settings, StreamEvent, Summary, TemplateId, Voice } from './types';

export type Api = {
  boot(): Promise<{ settings: Settings; meetings: Meeting[]; models: ModelInfo[]; status: EngineStatus; downloads: DownloadState[]; platform: string; version: string; ask: ChatMsg[] }>;
  listMeetings(): Promise<Meeting[]>;
  getTranscript(id: string): Promise<Para[]>;
  updateMeeting(id: string, patch: Partial<Pick<Meeting, 'title' | 'folder' | 'starred' | 'notes' | 'template'>>): Promise<Meeting>;
  deleteMeeting(id: string): Promise<void>;
  updatePara(id: string, paraId: string, patch: { text?: string; hl?: boolean; note?: string; sp?: string; tag?: ParaTag | null }): Promise<Para[]>;
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
  chat(id: string, question: string, streamId: string, mode?: TutorMode, passage?: { text: string; t: number }): Promise<ChatMsg>;
  clearChat(id: string): Promise<Meeting>;
  ask(question: string, streamId: string): Promise<ChatMsg>;
  clearAsk(): Promise<void>;
  catchUp(id: string, streamId: string): Promise<string>;
  abort(streamId: string): Promise<void>;
  search(q: string): Promise<SearchHit[]>;

  exportMeeting(id: string, format: 'md' | 'txt' | 'srt' | 'pdf' | 'docx' | 'audio'): Promise<string | null>;
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
  /** Show or hide the floating live-transcript window. */
  toggleMini(show?: boolean): Promise<boolean>;
  /** A button in the floating window: passed on to the main window. */
  miniCommand(cmd: 'stop-record' | 'bookmark' | 'show'): Promise<void>;
  /** Study material for one lecture. */
  studyGet(id: string): Promise<StudyPack>;
  studyNotes(id: string, style: NoteStyle, streamId: string): Promise<StudyPack>;
  studyLegal(id: string, streamId: string): Promise<StudyPack>;
  studyRevision(id: string, kind: 'cards' | 'sbaqs' | 'shortQs' | 'problems', opts: { count: number; difficulty: Difficulty }, streamId: string): Promise<StudyPack>;
  /** Edit what was generated (flashcards and questions can be changed, added or deleted). */
  studySave(id: string, patch: Partial<StudyPack>): Promise<StudyPack>;
  /** Record an answer, for spaced repetition and the knowledge-gap tracker. */
  practice(key: string, right: boolean, topic: string, lectureId: string): Promise<void>;
  revisionOverview(): Promise<RevisionOverview>;
  caseBank(): Promise<{ c: CaseRef; meetingId: string; title: string; date: number }[]>;
  exportStudy(id: string, what: 'notes' | 'notes-docx' | 'anki' | 'all-anki'): Promise<string | null>;
  /** Email one conversation's notes now. */
  emailNotes(id: string): Promise<Meeting>;
  /** Save (and check) the Gmail app password; an empty one removes it. */
  saveEmailPassword(pass: string): Promise<{ saved: boolean }>;
  emailStatus(): Promise<{ hasPassword: boolean }>;
  /** The Groq key handed to paired phones, for when this Mac is out of reach. Empty removes it. */
  saveGroqKey(key: string): Promise<void>;
  groqStatus(): Promise<{ hasKey: boolean }>;
  /** Send a test email with the current settings. */
  testEmail(): Promise<void>;
};

export type RevisionItem = { key: string; kind: 'card' | 'sbaq' | 'short'; topic: string; lectureId: string; lecture: string; front?: string; back?: string; sbaq?: import('./law').Sbaq; q?: string; a?: string };
export type RevisionOverview = {
  topics: TopicRow[];
  session: RevisionItem[];
  practice: Practice;
  confusing: { meetingId: string; title: string; paraId: string; t: number; text: string }[];
  totals: { items: number; due: number; lectures: number; untestedLectures: { id: string; title: string }[] };
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
