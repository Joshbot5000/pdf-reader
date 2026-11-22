import { useEffect, useState } from 'react';
import { Check, Cpu, Download, FolderOpen, Mail, Mic, Smartphone, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../api';
import { run, saveSettings, set, useStore } from '../store';
import { Avatar, gb } from '../ui/bits';
import { LANGUAGES } from '../../../shared/types';
import type { ModelInfo, PhoneInfo, Voice } from '../../../shared/types';

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
          <button className={tab === 'phone' ? 'on' : ''} onClick={() => set({ settingsOpen: 'phone' })}><Smartphone size={15} /> Phone</button>
          <button className={tab === 'email' ? 'on' : ''} onClick={() => set({ settingsOpen: 'email' })}><Mail size={15} /> Email</button>
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
              <label className="field"><span>Text size<i>For transcripts and study notes.</i></span>
                <div className="seg">{([[0.9, 'Small'], [1, 'Normal'], [1.15, 'Large'], [1.3, 'Larger']] as const).map(([v, l]) => <button key={v} className={settings.readScale === v ? 'on' : ''} onClick={(e) => (e.preventDefault(), void saveSettings({ readScale: v }))}>{l}</button>)}</div>
              </label>
              <label className="field"><span>Analyse lectures automatically<i>After a lecture is transcribed, find its cases, statutes and exam points and write full notes.</i></span><Toggle on={settings.autoStudy} set={(v) => void saveSettings({ autoStudy: v })} /></label>
              <MicPicker />
              <label className="field"><span>Record shortcut<i>Starts and stops a recording from any app. Shown in the menu bar while recording.</i></span><input defaultValue={settings.recordShortcut} placeholder="Off" spellCheck={false} onBlur={(e) => void saveSettings({ recordShortcut: e.target.value.trim() })} /></label>
              <label className="field"><span>Notifications<i>When a recording starts or stops, when notes are ready, and when an interrupted recording is rescued.</i></span><Toggle on={settings.notify} set={(v) => void saveSettings({ notify: v })} /></label>
              <label className="field"><span>Your library<i>Recordings, transcripts and notes live in a folder on this computer.</i></span><button className="btn small" onClick={() => void api.openDataFolder()}><FolderOpen size={14} /> Show in folder</button></label>
            </>
          )}
          {tab === 'models' && (
            <>
              <h3>AI models</h3>
              <h5><Sparkles size={13} /> Who writes the notes</h5>
              <div className="seg engine">
                <button className={settings.aiEngine === 'auto' ? 'on' : ''} onClick={() => void saveSettings({ aiEngine: 'auto' })}>Groq when online</button>
                <button className={settings.aiEngine === 'local' ? 'on' : ''} onClick={() => void saveSettings({ aiEngine: 'local' })}>This Mac only</button>
              </div>
              <p className="lead">{settings.aiEngine === 'auto'
                ? `Notes, legal analysis, the tutor and revision questions are written by Groq's large model${status.cloud ? ` (${status.cloud.replace(/^.*\//, '')}, connected)` : ''}, which is far better at law than a model small enough for this Mac. Only the text of a transcript is sent, never the audio, and only when you use these features. Transcription and speaker recognition always stay on this Mac, and when the Mac is offline everything falls back to the model below.`
                : 'Everything is written by the model on this computer: fully private and offline, but less capable at legal reasoning.'}</p>
              {settings.aiEngine === 'auto' && <GroqKey />}
              <p className="lead">The models below run on this computer. They are downloaded once, then work offline, with no account and no usage limits.</p>
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
          {tab === 'phone' && <PhoneTab />}
          {tab === 'email' && <EmailTab />}
        </section>
      </div>
    </div>
  );
}

/** Email the notes of each conversation as soon as they are written. */
function EmailTab() {
  const s = useStore((x) => x.settings);
  const [to, setTo] = useState(s.emailTo);
  const [from, setFrom] = useState(s.emailFrom);
  const [pass, setPass] = useState('');
  const [hasPass, setHasPass] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.emailStatus().then((r) => setHasPass(r.hasPassword)), []);
  const ok = (v: string) => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(v.trim());
  const ready = (s.emailVia === 'mail' || (ok(s.emailFrom) && hasPass)) && ok(s.emailTo || s.emailFrom);
  const attempt = async (label: string, job: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMsg({ text: label });
    try {
      await job();
      setMsg({ text: done });
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), bad: true });
    }
    setBusy(false);
  };
  const savePass = () => attempt('Checking with Gmail…', async () => {
    await saveSettings({ emailFrom: from.trim() });
    await api.saveEmailPassword(pass);
    setPass('');
    setHasPass(true);
  }, 'Signed in. Gmail accepted the app password.');
  return (
    <>
      <h3>Email your notes</h3>
      <p className="lead">When a conversation's notes are written, Hark emails you the key points, decisions, action items and open questions. The email goes straight from your own account; nothing passes through anyone else.</p>
      <label className="field"><span>Email notes automatically<i>{ready ? 'Every conversation, as soon as its notes are written.' : 'Finish setting up below first.'}</i></span><Toggle on={s.emailNotes} set={(v) => void saveSettings({ emailNotes: v })} /></label>
      <label className="field"><span>Send them to<i>Your own address, or anyone's.{s.emailVia === 'gmail' ? ' Leave empty to send to the Gmail address below.' : ''}</i></span><input value={to} type="email" placeholder="you@gmail.com" spellCheck={false} onChange={(e) => setTo(e.target.value)} onBlur={() => void saveSettings({ emailTo: to.trim() })} /></label>
      <label className="field"><span>Send using</span>
        <div className="seg">{(['gmail', 'mail'] as const).map((v) => <button key={v} className={s.emailVia === v ? 'on' : ''} onClick={(e) => (e.preventDefault(), void saveSettings({ emailVia: v }))}>{v === 'gmail' ? 'My Gmail' : 'The Mail app'}</button>)}</div>
      </label>
      {s.emailVia === 'gmail' ? (
        <>
          <label className="field"><span>Your Gmail address</span><input value={from} type="email" placeholder="you@gmail.com" spellCheck={false} onChange={(e) => setFrom(e.target.value)} onBlur={() => void saveSettings({ emailFrom: from.trim() })} /></label>
          <label className="field"><span>App password<i>{hasPass ? 'Saved on this computer. Paste a new one to replace it.' : 'A 16-letter password Google makes for Hark. Your normal password will not work.'}</i></span><input value={pass} type="password" placeholder={hasPass ? '•••• •••• •••• ••••' : 'abcd efgh ijkl mnop'} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pass.trim() && void savePass()} /></label>
          <div className="row"><button className="btn small primary" disabled={busy || !pass.trim() || !ok(from)} onClick={() => void savePass()}>Save and check</button>{hasPass && <button className="btn ghost small danger" onClick={() => void api.saveEmailPassword('').then(() => (setHasPass(false), setMsg({ text: 'Removed.' })))}>Remove password</button>}</div>
          <ol className="steps">
            <li>Turn on <b>2-Step Verification</b> for your Google account, if it isn't already: <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">myaccount.google.com/signinoptions/twosv</a></li>
            <li>Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">myaccount.google.com/apppasswords</a>, type <b>Hark</b> as the name and click <b>Create</b>.</li>
            <li>Copy the 16 letters Google shows, paste them above and click <b>Save and check</b>.</li>
          </ol>
          <p className="dim small">If Google says app passwords aren't available for your account, choose <b>The Mail app</b> above instead and add your Google account to the Mail app on this Mac.</p>
        </>
      ) : (
        <p className="lead">Hark asks the Mail app on this Mac to send each email, from its default account. The first time, macOS asks whether Hark may control Mail: click <b>Allow</b>. Mail needs an account set up (System Settings → Internet Accounts, or Mail → Add Account).</p>
      )}
      <div className="row"><button className="btn small" disabled={busy || !ready} onClick={() => void attempt('Sending a test email…', () => api.testEmail(), `Sent. Check ${s.emailTo || s.emailFrom || 'your inbox'} (and the spam folder, the first time).`)}><Mail size={13} /> Send a test email</button></div>
      {msg && <p className={msg.bad ? 'err-text' : 'dim small'}>{msg.text}</p>}
    </>
  );
}

/** The Groq key a paired phone uses to work on its own while this Mac is off or out of reach. */
function GroqKey() {
  const [has, setHas] = useState(false);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => void api.groqStatus().then((r) => setHas(r.hasKey)), []);
  const save = async (k: string) => {
    setMsg({ text: k ? 'Checking with Groq…' : '' });
    try {
      await api.saveGroqKey(k);
      setHas(!!k);
      setKey('');
      setMsg({ text: k ? 'Saved. Your phone picks it up the next time it connects to this Mac.' : 'Removed from this Mac. A phone that already has it keeps it until you remove it there.' });
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), bad: true });
    }
  };
  return (
    <>
      <h5><Smartphone size={13} /> When this Mac is off {has && <span className="chip ok"><Check size={11} /> Groq key saved</span>}</h5>
      <p className="lead">With a free Groq key, your phone transcribes and writes the notes itself whenever it can't reach this Mac, then hands the recording and its notes over when the Mac is back; they are then emailed as usual. Get a key at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>. Recordings made away from the Mac are sent to Groq to be processed; everything else stays on your devices.</p>
      <div className="row"><input className="link-in" type="password" value={key} placeholder={has ? 'Key saved (paste a new one to replace it)' : 'gsk_…'} spellCheck={false} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && void save(key)} /><button className="btn small primary" disabled={!key.trim()} onClick={() => void save(key)}>Save key</button>{has && <button className="btn ghost small danger" onClick={() => void save('')}>Remove</button>}</div>
      {msg?.text && <p className={msg.bad ? 'err-text' : 'dim small'}>{msg.text}</p>}
    </>
  );
}

/** Pair a phone: it becomes a pocket recorder and a window onto this library. */
function PhoneTab() {
  const settings = useStore((s) => s.settings);
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [link, setLink] = useState(settings.phoneLink);
  useEffect(() => {
    let alive = true;
    const load = () => void api.phoneInfo().then((i) => alive && setInfo(i));
    load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [settings.phone, settings.phoneLink]);
  const saveLink = (v: string) => {
    setLink(v);
    const clean = v.trim();
    if (!clean || /^https:\/\/[^\s/]+/.test(clean)) void saveSettings({ phoneLink: clean });
  };
  return (
    <>
      <h3>Hark on your phone</h3>
      <p className="lead">Record anywhere with your phone, then read the notes, play back and ask questions from it. The phone talks only to this computer: recordings are transcribed here and nothing goes to the cloud.</p>
      <label className="field"><span>Allow a paired phone<i>Only a phone that has scanned your code can connect.</i></span><Toggle on={settings.phone} set={(v) => void saveSettings({ phone: v })} /></label>
      {settings.phone && info && (
        info.error ? <p className="err-text">The phone link could not start. {info.error}</p> : (
          <>
            <div className="pair">
              <div className="qr">{info.qr ? <img src={info.qr} alt="Pairing code" /> : <span className="dim small">No network found. Is Wi-Fi on?</span>}</div>
              <ol>
                <li>Make sure your phone is on the same Wi-Fi as this computer.</li>
                <li>Point the phone's camera at the code and open the link.</li>
                <li>In Safari tap <b>Share → Add to Home Screen</b>. Hark now opens like any app.</li>
                <li className="dim">{info.connected ? <span className="chip ok"><Check size={11} /> {info.connected === 1 ? 'A phone is connected' : `${info.connected} phones connected`}</span> : 'Waiting for a phone…'}</li>
              </ol>
            </div>
            <h5><Mic size={13} /> Record from anywhere {info.secure && <span className="chip ok"><Check size={11} /> Secure link in use</span>}</h5>
            <p className="lead">Phones only switch the microphone on for secure (https) addresses. On plain Wi-Fi the phone can browse your library and send voice memos; for one-tap recording, and to reach Hark when you are out, give it a secure link with Tailscale (free):</p>
            <ol className="steps">
              <li>Install <b>Tailscale</b> on this computer and on your phone, and sign in to both with the same account.</li>
              <li>On this computer, open Terminal and run <code>tailscale serve --bg {info.port}</code></li>
              <li>It prints an address starting with https. Paste it here, then scan the new code:</li>
            </ol>
            <input className="link-in" value={link} placeholder="https://your-mac.your-tailnet.ts.net" spellCheck={false} onChange={(e) => saveLink(e.target.value)} />
            <GroqKey />
            <p className="dim small">Keep the code private: anyone who scans it can open your library. This computer needs to be on and awake for the phone to reach it; recordings made while it is out of reach wait on the phone and arrive later.</p>
          </>
        )
      )}
    </>
  );
}

/** Pick the microphone (the list fills in once Hark has been allowed to use one). */
function MicPicker() {
  const micId = useStore((s) => s.settings.micId);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => void navigator.mediaDevices?.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications')));
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, []);
  return (
    <label className="field"><span>Microphone<i>{micId && !mics.some((m) => m.deviceId === micId) ? 'The chosen microphone is not connected; the default is used.' : 'Used for every recording.'}</i></span>
      <select value={micId} onChange={(e) => void saveSettings({ micId: e.target.value })}>
        <option value="">System default</option>
        {mics.map((m, i) => <option key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>)}
      </select>
    </label>
  );
}

function Toggle({ on, set: change }: { on: boolean; set: (v: boolean) => void }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={(e) => { e.preventDefault(); change(!on); }}><span /></button>;
}
