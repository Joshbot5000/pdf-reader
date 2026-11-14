/**
 * Microphone capture. Lives outside React so a recording keeps going while you browse the app.
 * Audio is mixed once, then sent two ways: 16 kHz samples to the speech engine, and a compressed
 * recording for playback.
 */
import { api } from './api';
import { get, go, set, toast } from './store';
import type { TemplateId } from '../../shared/types';

type Rig = {
  id: string;
  streams: MediaStream[];
  mix: AudioContext;
  asr: AudioContext;
  tap: AudioWorkletNode;
  analyser: AnalyserNode;
  rec: MediaRecorder;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
  pausedFor: number;
  pausedAt: number;
};
let rig: Rig | null = null;
let starting = false;
const levelBuf = new Uint8Array(1024);
const freqBuf = new Uint8Array(64);

/** Current loudness 0..1 and a coarse spectrum, for the visualiser. */
export function levels(): { level: number; bands: Uint8Array } {
  if (!rig || get().rec?.paused) return { level: 0, bands: freqBuf.fill(0) };
  rig.analyser.getByteTimeDomainData(levelBuf);
  let sum = 0;
  for (let i = 0; i < levelBuf.length; i++) {
    const v = (levelBuf[i] - 128) / 128;
    sum += v * v;
  }
  rig.analyser.getByteFrequencyData(freqBuf);
  return { level: Math.min(1, Math.sqrt(sum / levelBuf.length) * 4.5), bands: freqBuf };
}

export async function startRecording(template: TemplateId, withSystemAudio = false): Promise<void> {
  if (rig || starting) return go({ name: 'record' });
  starting = true;
  const streams: MediaStream[] = [];
  try {
    if (!(await api.micAccess())) throw new Error('Hark needs microphone access. Allow it in System Settings → Privacy & Security → Microphone.');
    streams.push(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: !withSystemAudio, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }));
    let system = false;
    if (withSystemAudio) {
      try {
        const disp = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        disp.getVideoTracks().forEach((t) => t.stop());
        if (!disp.getAudioTracks().length) throw new Error('no audio');
        streams.push(disp);
        system = true;
      } catch {
        toast("Couldn't capture computer audio, recording the microphone only.", 'error');
      }
    }
    const mix = new AudioContext();
    const dest = mix.createMediaStreamDestination();
    const analyser = mix.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    for (const s of streams) {
      const src = mix.createMediaStreamSource(s);
      src.connect(dest);
      src.connect(analyser);
    }
    const asr = new AudioContext({ sampleRate: 16000 });
    await asr.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href);
    const tap = new AudioWorkletNode(asr, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    asr.createMediaStreamSource(dest.stream).connect(tap);

    const m = await api.recStart({ template });
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => api.recAudio(m.id, e.data);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 48000 });
    rec.ondataavailable = async (e) => {
      if (e.data.size) api.recBlob(m.id, new Uint8Array(await e.data.arrayBuffer()));
    };
    rec.start(2000);
    const startedAt = performance.now();
    const timer = setInterval(() => {
      if (!rig) return;
      const r = get().rec;
      if (r && !r.paused) set({ rec: { ...r, elapsed: (performance.now() - rig.startedAt - rig.pausedFor) / 1000 } });
    }, 250);
    rig = { id: m.id, streams, mix, asr, tap, analyser, rec, timer, startedAt, pausedFor: 0, pausedAt: 0 };
    set((s) => ({ rec: { id: m.id, paused: false, elapsed: 0, system }, transcripts: { ...s.transcripts, [m.id]: [] } }));
    go({ name: 'record' });
  } catch (err) {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    const msg = err instanceof Error ? err.message : String(err);
    toast(/Permission|NotAllowed/i.test(msg) ? 'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.' : /NotFound|Requested device/i.test(msg) ? 'No microphone was found.' : msg, 'error');
  } finally {
    starting = false;
  }
}

export function togglePause(): void {
  const r = get().rec;
  if (!rig || !r) return;
  if (r.paused) {
    rig.pausedFor += performance.now() - rig.pausedAt;
    rig.rec.resume();
    rig.tap.port.postMessage({ on: true });
  } else {
    rig.pausedAt = performance.now();
    rig.rec.pause();
    rig.tap.port.postMessage({ on: false });
    void api.recPause(rig.id);
  }
  set({ rec: { ...r, paused: !r.paused } });
}

export function bookmark(): void {
  const r = get().rec;
  if (!rig || !r) return;
  void api.recBookmark(rig.id, r.elapsed);
  toast('Moment bookmarked', 'ok');
}

async function teardown(): Promise<string | null> {
  if (!rig) return null;
  const r = rig;
  rig = null;
  clearInterval(r.timer);
  r.tap.port.postMessage({ on: false });
  // Let the recorder hand over its final chunk before the file is closed.
  await new Promise<void>((resolve) => {
    r.rec.onstop = () => setTimeout(resolve, 150);
    try {
      r.rec.stop();
    } catch {
      resolve();
    }
  });
  r.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  void r.mix.close();
  void r.asr.close();
  set({ rec: null });
  return r.id;
}

export async function stopRecording(): Promise<void> {
  const id = await teardown();
  if (!id) return;
  try {
    await api.recStop(id);
    go({ name: 'meeting', id });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    go({ name: 'home' });
  }
}

export async function discardRecording(): Promise<void> {
  const id = await teardown();
  if (id) await api.recDiscard(id).catch(() => undefined);
  go({ name: 'home' });
}
