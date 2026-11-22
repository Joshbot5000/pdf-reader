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
   - [ ] Law-lecture notes in five styles (concise, detailed, beginner, exam, one page)
   - [ ] Lecturer-emphasis detection (explicit phrases, deterministic) + AI-inferred exam points, both timestamped
   - [ ] Case extraction (name, facts, issue, judgment, principle, why mentioned, timestamp), flagged as unverified
   - [ ] Legislation extraction with legislation.gov.uk links
   - [ ] Case bank across lectures
4. Revision pack
   - [ ] Flashcards: generate, edit, delete, add, export to Anki
   - [ ] SBAQs (5 options, explanations, difficulty), short-answer, problem questions
   - [ ] Spaced repetition and practice history
5. Tutor
   - [ ] Modes: explain, law school, exam, Socratic, case, compare, lecture-only
   - [ ] Ask about a selected passage; replay a selection
6. Knowledge gaps
   - [ ] Topic dashboard (strong / improving / needs revision / not tested) and weakest-first sessions
7. Polish
   - [ ] Bookmark categories, tags/subjects, font size, DOCX and Anki export, mini transcript window, PDF/slide import
