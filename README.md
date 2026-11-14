# Hark

**Listen once. Remember everything.** A private AI notetaker that runs entirely on
your own computer: it records or imports a conversation, transcribes it live, tells
the speakers apart, writes the notes, and answers questions about anything you have
ever recorded. No account, no API key, no subscription, no usage limits, and nothing
is uploaded.

It rebuilds the core of [Otter.ai](https://otter.ai) as a local desktop app.

## What it does

| | |
|---|---|
| **Record** | Live transcript as people speak, with an audio-reactive orb, pause, and ⌘B to bookmark a moment. Optionally also captures what the computer is playing (a Zoom/Meet/Teams call), in beta |
| **Import** | Drop any audio or video file on the window (mp3, m4a, wav, mp4, mov, …). Any length |
| **Speakers** | Each voice gets its own colour. Click a name to say who it is, and Hark **remembers that voice** and labels it automatically in future conversations. When the conversation makes a name obvious ("George, can you…" / "Yes, I'll take that"), Hark suggests it |
| **Notes** | Written automatically when a conversation ends: overview, key points, **action items with owner and due date**, decisions, open questions, clickable chapters, topics. Four styles: Meeting, Lecture (study notes + flashcards), Interview, Voice memo |
| **Playback** | Click any word to hear it. Words light up as they are spoken. Waveform tinted by speaker, 0.75–2× speed |
| **Chat** | Ask about one conversation; answers cite timestamps you can click |
| **Ask Hark** | Ask a question across *every* conversation. Searches by meaning, answers with links to the exact moments |
| **Action items** | One list of every task from every conversation, tick them off |
| **Search** | ⌘K finds any word ever said and jumps to that second of audio |
| **Edit** | Fix transcript text, reassign or merge speakers, highlight, add notes |
| **Insights** | Talk-time share, words per minute, turn-taking timeline |
| **Export** | Markdown, PDF, plain text, subtitles (.srt), audio; copy notes or transcript |
| **Organise** | Folders, stars, light and dark themes |

## Installing on a Mac

1. Install Node.js (LTS) from https://nodejs.org (one-off; skip if you already have it).
2. Download this repository (green **Code** button → **Download ZIP**) and unzip it.
3. Double-click **Install Hark.command**. If macOS says it can't be opened,
   right-click it → **Open** → **Open**.

It builds the app, puts it in Applications and opens it. On first launch Hark
downloads its AI models once (about 1.6 GB to 3 GB depending on the model it
recommends for your Mac); after that it works with no internet connection.
To update later, download a fresh ZIP and run the installer again: your library
and models are kept.

The first time you record, macOS asks for microphone access.

## How the AI is built in

Hark does not call any online service. Three small models run on your machine:

| Job | Model | Runs on |
|---|---|---|
| Speech to text, with a timestamp for every word | OpenAI Whisper (base or small), via ONNX Runtime | CPU |
| Voice fingerprints (who is speaking) | WeSpeaker ResNet34 | CPU |
| Notes, chat, questions | Qwen 3.5 (2B, 4B or 9B, 4-bit), via llama.cpp | Apple GPU (Metal) on Apple Silicon, CPU elsewhere |
| Search by meaning | MiniLM sentence embeddings | CPU |

Models are fetched from Hugging Face on first run and stored in
`~/Library/Application Support/hark/models`. Your recordings, transcripts and notes
are plain files in `~/Library/Application Support/hark/library`
(Settings → General → Show in folder).

Pick models in **Settings → AI models**. *Sharp* speech and the *Balanced* notes
model are the defaults on a 16 GB Mac; *Light* is chosen automatically on 8 GB.

### How a recording becomes notes

1. Audio is cut into utterances at natural pauses.
2. Whisper transcribes each utterance with per-word timing.
3. Every sentence gets a voice fingerprint; fingerprints that match are the same
   speaker, and are compared with the voices you have named before.
4. When the conversation ends, the language model writes the notes. Long
   conversations are read in parts, then summarised from those notes.
5. The transcript is indexed so *Ask Hark* can find passages by meaning.

## Honest limits

- Summaries come from a small on-device model. They are good, not infallible:
  check names, numbers and dates against the transcript (every chapter and
  citation links to the audio).
- Speaker separation works best when people take turns. Two people talking over
  each other, or a very short interjection, can be attributed to the wrong person;
  click the name to fix it.
- Otter features that need an online service are not included: a bot that joins
  calls by itself, calendar sync, shared team workspaces, and mobile apps. To
  capture a call, record with **+ computer audio** or simply let the microphone
  hear your speakers.
- "Computer audio" capture depends on macOS screen-and-audio recording permission
  and has not been tested on every macOS version.

## Development

Requires Node.js 22+.

```bash
npm install
npm run dev          # run with hot reload
npm test             # unit tests (pause detection, speaker clustering, parsers, exports)
npm run test:e2e     # drives the real app: sample → notes → chat → search → live recording
npm run dist         # package for the current platform
```

Layout: `src/main` (Electron main: library, pipeline, AI orchestration),
`src/workers` (speech and language engines, each its own process),
`src/shared` (pure logic, unit-tested), `src/renderer` (React interface).
