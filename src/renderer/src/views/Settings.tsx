import { useEffect, useState } from 'react';
import { Check, Cpu, Download, FolderOpen, Mic, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../api';
import { run, saveSettings, set, useStore } from '../store';
import { Avatar, gb } from '../ui/bits';
import { LANGUAGES } from '../../../shared/types';
import type { ModelInfo, Voice } from '../../../shared/types';

export function ModelCard({ m, selected, onUse }: { m: ModelInfo; selected: boolean; onUse?: () => void }) {
  const dl = useStore((s) => s.downloads[m.id]);
  const ram = useStore((s) => s.status.ramGb);
  const tooBig = !!m.minRam && ram < m.minRam;
  const active = dl && !dl.error;
  return (
    <div className={`model ${selected ? 'sel' : ''}`}>
      <div className="model-top">
        <b>{m.name}</b>
        {m.recommended && <span className="chip glow">Recommended for this computer</span>}
        {selected && m.installed && <span className="chip ok"><Check size={11} /> In use</span>}
        <span className="grow" />
        <span className="dim mono">{gb(m.bytes)}</span>
      </div>
      <p>{m.blurb}{tooBig ? ` This computer has ${ram} GB of memory, so it may run slowly.` : ''}</p>
      {active ? (
        <div className="dl">
          <div className="bar"><span style={{ width: `${(dl.received / Math.max(1, dl.total)) * 100}%` }} /></div>
          <span className="mono dim">{gb(dl.received)} / {gb(dl.total)}</span>
          <button className="btn ghost small" onClick={() => void api.cancelDownload(m.id)}>Pause</button>
        </div>
      ) : (
        <div className="row">
          {!m.installed && <button className="btn small primary" onClick={() => void run(api.downloadModel(m.id))}><Download size={13} /> {dl?.error ? 'Resume download' : 'Download'}</button>}
          {m.installed && !selected && onUse && <button className="btn small" onClick={onUse}>Use this</button>}
          {m.installed && !selected && m.kind !== 'support' && <button className="btn ghost small danger" onClick={() => void run(api.removeModel(m.id)).then((models) => models && set({ models }))}><Trash2 size={13} /> Remove</button>}
          {dl?.error && dl.error !== 'Cancelled' && <span className="err-text">{dl.error}</span>}
        </div>
      )}
    </div>
  );
}

export function Settings() {
  const tab = useStore((s) => s.settingsOpen) || 'general';
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const status = useStore((s) => s.status);
  const version = useStore((s) => s.version);
  const [voices, setVoices] = useState<Voice[]>([]);
  useEffect(() => void api.listVoices().then(setVoices), [tab]);
  const of = (kind: string) => models.filter((m) => m.kind === kind);
  return (
    <div className="veil" onMouseDown={() => set({ settingsOpen: false })}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <aside>
          <h2>Settings</h2>
          <button className={tab === 'general' ? 'on' : ''} onClick={() => set({ settingsOpen: 'general' })}><Mic size={15} /> General</button>
          <button className={tab === 'models' ? 'on' : ''} onClick={() => set({ settingsOpen: 'models' })}><Cpu size={15} /> AI models</button>
          <button className={tab === 'voices' ? 'on' : ''} onClick={() => set({ settingsOpen: 'voices' })}><UserRound size={15} /> Voices</button>
          <span className="grow" />
          <p className="dim small">Hark {version}<br />{status.ramGb} GB memory{status.gpu ? ` · ${status.gpu === 'metal' ? 'Apple GPU' : status.gpu.toUpperCase()}` : ''}</p>
        </aside>
        <section>
          <button className="icon-btn close" onClick={() => set({ settingsOpen: false })}><X size={16} /></button>
          {tab === 'general' && (
            <>
              <h3>General</h3>
              <label className="field"><span>Your name<i>Used to greet you. Stays on this computer.</i></span><input value={settings.userName} placeholder="Optional" onChange={(e) => void saveSettings({ userName: e.target.value })} /></label>
              <label className="field"><span>Appearance</span>
                <div className="seg">{(['dark', 'light', 'system'] as const).map((t) => <button key={t} className={settings.theme === t ? 'on' : ''} onClick={() => void saveSettings({ theme: t })}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
              </label>
              <label className="field"><span>Spoken language<i>The language people speak in your recordings.</i></span>
                <select value={settings.language} onChange={(e) => void saveSettings({ language: e.target.value })}>{LANGUAGES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
              </label>
              <label className="field"><span>Write notes automatically<i>Summarise every conversation as soon as it is transcribed.</i></span><Toggle on={settings.autoSummary} set={(v) => void saveSettings({ autoSummary: v })} /></label>
              <label className="field"><span>Remember voices<i>When you name a speaker, recognise them in future conversations.</i></span><Toggle on={settings.rememberVoices} set={(v) => void saveSettings({ rememberVoices: v })} /></label>
              <label className="field"><span>Your library<i>Recordings, transcripts and notes live in a folder on this computer.</i></span><button className="btn small" onClick={() => void api.openDataFolder()}><FolderOpen size={14} /> Show in folder</button></label>
            </>
          )}
          {tab === 'models' && (
            <>
              <h3>AI models</h3>
              <p className="lead">Everything Hark does runs on this computer. Models are downloaded once, then work offline, with no account, no API key and no usage limits.</p>
              <h5><Mic size={13} /> Speech to text</h5>
              {of('asr').map((m) => <ModelCard key={m.id} m={m} selected={settings.asrModel === m.id} onUse={() => void saveSettings({ asrModel: m.id })} />)}
              <h5><Sparkles size={13} /> Notes, chat and questions</h5>
              {of('llm').map((m) => <ModelCard key={m.id} m={m} selected={settings.llmModel === m.id} onUse={() => void saveSettings({ llmModel: m.id })} />)}
              <h5><Cpu size={13} /> Helpers</h5>
              {of('support').map((m) => <ModelCard key={m.id} m={m} selected={m.installed} />)}
            </>
          )}
          {tab === 'voices' && (
            <>
              <h3>Voices Hark knows</h3>
              <p className="lead">Name a speaker in any transcript and Hark keeps a fingerprint of their voice, so they are labelled automatically from then on. Fingerprints never leave this computer.</p>
              {!voices.length && <p className="dim">No voices yet. Click a speaker's name in a transcript to name them.</p>}
              {voices.map((v) => (
                <div className="voice" key={v.id}>
                  <Avatar sp={{ id: v.id, name: v.name, color: v.color }} size={30} />
                  <b>{v.name}</b><span className="dim small">learned from {v.samples} conversation{v.samples > 1 ? 's' : ''}</span>
                  <span className="grow" />
                  <button className="btn ghost small danger" onClick={() => void api.deleteVoice(v.id).then(setVoices)}><Trash2 size={13} /> Forget</button>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function Toggle({ on, set: change }: { on: boolean; set: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); change(!on); }}><span /></button>;
}
