import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, HardDrive, Lock, Mic, Sparkles, WifiOff } from 'lucide-react';
import { api } from '../api';
import { go, run, saveSettings, useStore } from '../store';
import { Orb, gb } from '../ui/bits';

export function Onboarding() {
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const downloads = useStore((s) => s.downloads);
  const ram = useStore((s) => s.status.ramGb);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(settings.userName);
  const [asr, setAsr] = useState(settings.asrModel);
  const [llm, setLlm] = useState(settings.llmModel);
  const need = useMemo(() => [asr, 'speaker', 'embed', llm], [asr, llm]);
  const info = (id: string) => models.find((m) => m.id === id);
  const missing = need.filter((id) => !info(id)?.installed);
  const total = missing.reduce((n, id) => n + (info(id)?.bytes ?? 0), 0);
  const speechReady = [asr, 'speaker', 'embed'].every((id) => info(id)?.installed);
  const allReady = !missing.length;
  const failed = need.map((id) => downloads[id]).find((d) => d?.error && d.error !== 'Cancelled');

  const begin = async () => {
    await saveSettings({ userName: name.trim(), asrModel: asr, llmModel: llm });
    setStep(2);
    // Smallest first, so recording works within a minute while the language model keeps downloading.
    for (const id of [asr, 'speaker', 'embed', llm]) if (!info(id)?.installed) void api.downloadModel(id);
  };
  const finish = async (sample: boolean) => {
    await saveSettings({ onboarded: true });
    if (sample) {
      const m = await run(api.importSample());
      if (m) go({ name: 'meeting', id: m.id });
    }
  };
  useEffect(() => {
    if (step === 1 && allReady) setStep(2);
  }, [step, allReady]);

  return (
    <div className="onboard">
      <div className="onboard-drag" />
      <div className="onboard-orb"><Orb size={step === 0 ? 300 : 190} /></div>
      {step === 0 && (
        <div className="onboard-card">
          <h1>Hark</h1>
          <p className="tagline">Listen once. Remember everything.</p>
          <ul className="promises">
            <li><Lock size={16} /><span><b>Private by design.</b> Audio, transcripts and notes never leave this computer.</span></li>
            <li><WifiOff size={16} /><span><b>No account, no API key, no limits.</b> The AI is built in and works offline.</span></li>
            <li><Sparkles size={16} /><span><b>More than a transcript.</b> Speakers, summaries, action items, and answers across everything you have recorded.</span></li>
          </ul>
          <input className="name-in" value={name} placeholder="What should Hark call you? (optional)" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setStep(1)} autoFocus />
          <button className="btn primary big" onClick={() => setStep(1)}>Set up <ArrowRight size={16} /></button>
        </div>
      )}
      {step === 1 && (
        <div className="onboard-card wide">
          <h2>Choose your on-device AI</h2>
          <p className="dim">A one-time download. This computer has {ram} GB of memory, so the best fit is already selected.</p>
          <h5><Mic size={13} /> Speech to text</h5>
          <div className="choices">
            {models.filter((m) => m.kind === 'asr').map((m) => (
              <button key={m.id} className={`choice ${asr === m.id ? 'on' : ''}`} onClick={() => setAsr(m.id)}>
                <b>{m.name} {m.recommended && <span className="chip glow">Recommended</span>}</b><span>{m.blurb}</span><i className="mono">{m.installed ? 'Installed' : gb(m.bytes)}</i>
              </button>
            ))}
          </div>
          <h5><Sparkles size={13} /> Notes, chat and questions</h5>
          <div className="choices">
            {models.filter((m) => m.kind === 'llm').map((m) => (
              <button key={m.id} className={`choice ${llm === m.id ? 'on' : ''}`} onClick={() => setLlm(m.id)}>
                <b>{m.name} {m.recommended && <span className="chip glow">Recommended</span>}</b><span>{m.blurb}</span><i className="mono">{m.installed ? 'Installed' : gb(m.bytes)}</i>
              </button>
            ))}
          </div>
          <div className="onboard-foot">
            <span className="dim"><HardDrive size={14} /> {total ? `${gb(total)} to download` : 'Everything is already installed'}</span>
            <button className="btn primary big" onClick={() => void begin()}>{total ? 'Download and continue' : 'Continue'} <ArrowRight size={16} /></button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="onboard-card wide">
          <h2>{allReady ? 'Ready when you are' : speechReady ? 'Transcription is ready' : 'Setting up your private AI'}</h2>
          <p className="dim">{allReady ? 'Everything is installed and works offline from now on.' : speechReady ? 'You can start now. The notes model keeps downloading in the background.' : 'This happens once. You can start as soon as the speech model arrives.'}</p>
          <div className="dl-list">
            {need.map((id) => {
              const m = info(id), d = downloads[id];
              if (!m) return null;
              const pct = m.installed ? 1 : d ? d.received / Math.max(1, d.total) : 0;
              return (
                <div key={id} className={`dl-row ${m.installed ? 'done' : ''}`}>
                  <span className="dl-ic">{m.installed ? <Check size={14} strokeWidth={3} /> : <span className="mono">{Math.round(pct * 100)}</span>}</span>
                  <div className="grow">
                    <p><b>{m.kind === 'asr' ? `Speech: ${m.name}` : m.kind === 'llm' ? `Notes and chat: ${m.name}` : m.name}</b><span className="mono dim">{m.installed ? 'Installed' : d && !d.error ? `${gb(d.received)} / ${gb(d.total)}` : gb(m.bytes)}</span></p>
                    <div className="bar"><span style={{ width: `${pct * 100}%` }} /></div>
                  </div>
                </div>
              );
            })}
          </div>
          {failed && <p className="err-text">A download was interrupted ({failed.error}). <button className="link-btn" onClick={() => need.forEach((id) => !info(id)?.installed && void api.downloadModel(id))}>Resume</button></p>}
          <div className="onboard-foot">
            <button className="btn ghost" disabled={!speechReady} onClick={() => void finish(false)}>Go to my library</button>
            <button className="btn primary big" disabled={!speechReady} onClick={() => void finish(true)}>See it work on a sample <ArrowRight size={16} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
