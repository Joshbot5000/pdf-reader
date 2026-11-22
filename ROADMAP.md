# Hark: law-lecture assistant roadmap

Audit date: 22 Nov 2026. Status: [x] done and tested · [~] partly · [ ] not started.

## Already working before this round (kept as is)
- [x] Mic recording (+ computer audio), live transcript with timestamps, pause, bookmarks
- [x] Speaker separation and remembered voices
- [x] Import audio/video (button and drag-and-drop)
- [x] Click-to-play transcript, word highlighting, editing, highlights, paragraph notes
- [x] Playback 0.75x-2x (pitch preserved by the browser engine), waveform
- [x] Search everything (Cmd+K), folders, stars, rename, delete
- [x] Notes in four templates, per-lecture chat with timestamps, Ask across all lectures with citations
- [x] Export: Markdown, PDF, text, SRT, audio
- [x] Phone app, email of notes, phone working alone through Groq

## Roadmap
1. Recording safety
   - [x] Recover audio of a recording interrupted by a crash or quit, and re-transcribe it in full (tests/recover.mjs)
   - [x] Choose the microphone
   - [x] Notifications: recording started/stopped, notes ready
   - [x] Menu-bar record control and global shortcut
2. AI engine
   - [x] Mac uses Groq (when a key is set and online) for notes, tutor, revision; local model otherwise; disclosed in Settings (src/main/cloud.ts; checked live)
3. Law intelligence
   - [x] Law-lecture notes in five styles (concise, detailed, beginner, exam, one page)
   - [x] Lecturer-emphasis detection (explicit phrases, deterministic) + AI-inferred exam points, both timestamped
   - [x] Case extraction (name, facts, issue, judgment, principle, why mentioned, timestamp), flagged as unverified
   - [x] Legislation extraction with legislation.gov.uk links
   - [x] Case bank across lectures
4. Revision pack
   - [x] Flashcards: generate, edit, delete, add, export to Anki
   - [x] SBAQs (5 options, explanations, difficulty), short-answer, problem questions
   - [x] Spaced repetition and practice history
5. Tutor
   - [x] Modes: explain, law school, exam, Socratic, case, compare, lecture-only
   - [x] Ask about a selected passage; replay a selection
6. Knowledge gaps
   - [x] Topic dashboard (strong / improving / needs revision / not tested) and weakest-first sessions
7. Polish
   - [x] Bookmark categories (Important, Confusing, Exam focus, Follow up), text size, resizable side panel, Anki export
   - [ ] Tags/subjects beyond folders, DOCX export, floating mini transcript window, PDF/slide import

## How it was tested (22 Nov)
- Unit tests (tests/unit.test.ts): emphasis cues, case-name and statute detection on speech-to-text spellings,
  name checking, practice/topic status/session picking, Anki export.
- Live, real Groq, real transcription: a 2.7-minute synthetic contract-law lecture (scratch, not committed) imported,
  transcribed on the Mac, analysed: 5 cases with principles, Misrepresentation Act 1967 s 2(1), all 6 lecturer cues
  with times, exam notes, SBAQs, flashcards, exam-mode tutor answer on a selected passage; no page errors.
- tests/recover.mjs (crash recovery), tests/email.mjs, tests/groq.mjs, tests/phone.mjs still pass.

## Known limits / next tasks
- Exact next task: DOCX export of study notes (via the `docx` package), then a floating mini-transcript window
  during recording, then PDF/slide import as lecture materials for the tutor's lecture-only mode.
- Groq free plan is ~8,000 tokens/minute per model: long lectures are analysed in parts with waits (minutes, not seconds).
- "Research" tutor mode has no web search; it uses general knowledge, clearly labelled, and points to where to verify.
- Legislation links go to a legislation.gov.uk search for the Act; the section text itself is not fetched or verified.
- "Questions I repeatedly ask the AI" is not yet tracked in the gap tracker.
