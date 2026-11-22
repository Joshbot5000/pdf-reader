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
   - [x] Legislation extraction, checked against legislation.gov.uk's open data: the Act or regulations are found by title,
         the section (or subsection) is fetched, and its official current wording is shown under "Official text", kept
         apart from "Lecturer said". Not found / wrong section numbers are flagged; offline gives "Not checked yet" with
         a re-check button (src/main/legislation.ts, tests/legislation.test.ts with real fixtures; live run verified s 2)
   - [x] Topic outlines: on the Revision page, "Outline" on any topic (or type any topic) gives an exam-ready outline:
         rules and elements, authorities, distinctions, a problem-question checklist and gaps, cited [lecture, m:ss],
         from lecture material only; topics no lecture covers are refused without an AI call; saved until rewritten
   - [x] Ask Hark across all lectures also reads the revision record and case bank when asked about progress or
         cases ("which topics have I not revised recently?", "what cases have I studied on X?") (live runs)
   - [x] Research tutor mode quotes official statute text from legislation.gov.uk with its link (live run, s 2(2))
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
   - [x] DOCX export (notes and whole lectures), floating live-transcript window (tests/mini.mjs)
   - [x] Lecture materials: attach slides and handouts (PDF, PowerPoint .pptx, Word .docx, text) by button or drag-and-drop.
         Notes use them for structure and spellings; case analysis takes correct case names from the slides and lists
         slide cases the lecturer skipped; the tutor cites them as [file, slide N] (tests/materials.test.ts; live run)
   - [x] Knowledge gaps also count repeated tutor questions per lecture topic (3+ = needs revision) and file
         "confusing" bookmarks under the topic they are about (unit test; checked on live data)
   - [x] PDF export of study notes (Notes pane: Copy, .md, Word, PDF) (unit test; live export checked with pdftotext)
   - [x] Keyboard: J/K/arrows + Enter in the library, [ ] playback speed, Esc goes back, ? shows all shortcuts (live 8/8)
   - [x] Tags (header # button, sidebar list, click a tag on a card to filter), archive (hidden from the list,
         sidebar "Archived"), Revision and Case bank filtered by module folder (scratch live test 9/9)

## How it was tested (22 Nov)
- Full regression after this round: unit 40/40, recover 3/3, mini 4/4, email 8/8, groq 13/13, phone 20/20, UI tour passes.
- Unit tests (tests/unit.test.ts): emphasis cues, case-name and statute detection on speech-to-text spellings,
  name checking, practice/topic status/session picking, Anki export.
- Live, real Groq, real transcription: a 2.7-minute synthetic contract-law lecture (scratch, not committed) imported,
  transcribed on the Mac, analysed: 5 cases with principles, Misrepresentation Act 1967 s 2(1), all 6 lecturer cues
  with times, exam notes, SBAQs, flashcards, exam-mode tutor answer on a selected passage; no page errors.
- Lecture materials (22 Nov): unit tests read a real .pptx, .pdf and .docx; live run attached slides to the lecture:
  Carlill and Hyde v Wrench names confirmed from slides, Butler Machine Tool listed as "on your slides, not heard",
  tutor in lecture-only mode correctly said Butler was on the slides but not covered.
- Run the Electron tests with HARK_MODELS_DIR pointing at downloaded models (scratch/models here).
- tests/recover.mjs (crash recovery), tests/email.mjs, tests/groq.mjs, tests/phone.mjs still pass.

## Known limits / next tasks
- Exact next task: citations in outlines and Ask answers that name a lecture and time ([lecture, m:ss]) should be
  clickable and open that moment (today only plain [m:ss] in a lecture's own notes is clickable).
- Scanned PDFs (images only) are refused with a clear message: there is no OCR.
- Groq free plan is ~8,000 tokens/minute per model: long lectures are analysed in parts with waits (minutes, not seconds).
- "Research" tutor mode fetches statute text but has no general web search; other outside material is labelled "check this".
- Case law cannot be verified automatically (no free official case-law API); cases stay marked for checking.
- Official statute text is the current version; it may differ from the version in force at the time of a case.
