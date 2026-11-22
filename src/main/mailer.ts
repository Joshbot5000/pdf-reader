/**
 * Emailing the notes. Two ways to send, both without any service of ours in the middle:
 *  - straight from the user's Gmail, signed in with a Google app password (SMTP);
 *  - through the Mail app on this Mac, using whatever account is set up there.
 */
import { execFile } from 'node:child_process';
import nodemailer from 'nodemailer';
import { fmtDuration } from '../shared/text';
import { TEMPLATES } from '../shared/summaryFormat';
import type { Meeting } from '../shared/types';

export type NotesEmail = { subject: string; text: string; html: string };

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Notes may carry light markdown and [m:ss] timestamps; an email wants neither. */
const plain = (s: string): string => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*\s][^*]*)\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s*\[\d{1,2}(?::\d{2}){1,2}\]/g, '').trim();

/** The email for one conversation: its key points first, then decisions, actions and open questions. */
export function notesEmail(m: Meeting): NotesEmail {
  const s = m.summary;
  if (!s) throw new Error('This conversation has no notes yet.');
  const when = new Date(m.createdAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
  const who = m.speakers.filter((x) => x.named).map((x) => x.name);
  const meta = [when, m.duration ? fmtDuration(m.duration) : '', who.length ? `with ${who.join(', ')}` : ''].filter(Boolean).join(' · ');
  const actionLine = (a: NonNullable<Meeting['summary']>['actions'][number]): string => `${a.owner ? `${a.owner}: ` : ''}${plain(a.text)}${a.due ? ` (due ${a.due})` : ''}`;
  const sections: [string, string[]][] = [
    ['Key points', s.keyPoints.map(plain)],
    ['Decisions', s.decisions.map(plain)],
    [s.template === 'lecture' ? 'To do' : 'Action items', s.actions.filter((a) => !a.done).map(actionLine)],
    ['Open questions', s.questions.map(plain)],
  ];
  const kept = sections.filter(([, items]) => items.length);
  const text = [
    m.title,
    meta,
    '',
    ...(s.overview ? [plain(s.overview), ''] : []),
    ...kept.flatMap(([h, items]) => [h.toUpperCase(), ...items.map((x) => `• ${x}`), '']),
    `${TEMPLATES[s.template]?.name ?? 'Meeting'} notes written by Hark on your Mac. Check names, numbers and dates against the recording.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1b24">
<div style="max-width:620px;margin:0 auto;background:#fffdf9;border-radius:14px;padding:28px 30px;border:1px solid #e6e0d4">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8d8a9c">Hark notes</p>
<h1 style="margin:0 0 6px;font:600 24px/1.25 Georgia,'Times New Roman',serif">${esc(m.title)}</h1>
<p style="margin:0 0 18px;font-size:13px;color:#56546b">${esc(meta)}</p>
${s.overview ? `<p style="margin:0 0 20px;font:17px/1.55 Georgia,'Times New Roman',serif">${esc(plain(s.overview))}</p>` : ''}
${kept.map(([h, items]) => `<h2 style="margin:22px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5c47ea">${esc(h)}</h2>
<ul style="margin:0;padding-left:20px;font-size:15px;line-height:1.55">${items.map((x) => `<li style="margin:0 0 6px">${esc(x)}</li>`).join('')}</ul>`).join('\n')}
<p style="margin:26px 0 0;font-size:12px;color:#8d8a9c">${esc(TEMPLATES[s.template]?.name ?? 'Meeting')} notes written by Hark on your Mac. Check names, numbers and dates against the recording.</p>
</div></body></html>`;
  return { subject: `Notes: ${m.title}`, text, html };
}

export type GmailLogin = { from: string; pass: string };

const smtp = (login: GmailLogin) =>
  nodemailer.createTransport({
    host: process.env.HARK_SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.HARK_SMTP_PORT) || 465,
    secure: process.env.HARK_SMTP_SECURE !== '0',
    auth: { user: login.from, pass: login.pass.replace(/\s+/g, '') },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    ...(process.env.HARK_SMTP_HOST ? { tls: { rejectUnauthorized: false } } : {}),
  });

/** Turn a mail server's refusal into something a person can act on. */
function explain(err: unknown): Error {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
  const said = String(e.response ?? e.message ?? '').replace(/\s+/g, ' ').trim();
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534)
    return new Error(`Gmail refused the password. It must be a 16-letter app password from myaccount.google.com/apppasswords (2-Step Verification has to be on); your normal Google password will not work${said ? ` [Gmail said: ${said.slice(0, 160)}]` : ''}`);
  if (/ECONNECTION|ETIMEDOUT|ENOTFOUND|EDNS|ESOCKET|ECONNREFUSED|EHOSTUNREACH/.test(`${e.code} ${said}`)) return new Error("Couldn't reach Gmail. Is the internet connected? Hark will try again.");
  return new Error(said || 'The email could not be sent.');
}

/** Check a Gmail address and app password work, without sending anything. */
export async function checkGmail(login: GmailLogin): Promise<void> {
  const t = smtp(login);
  try {
    await t.verify();
  } catch (err) {
    throw explain(err);
  } finally {
    t.close();
  }
}

export async function sendGmail(login: GmailLogin, to: string, mail: NotesEmail): Promise<void> {
  const t = smtp(login);
  try {
    await t.sendMail({ from: `Hark <${login.from}>`, to, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    throw explain(err);
  } finally {
    t.close();
  }
}

/** Send through the Mail app on this Mac (whichever account it sends from by default). */
export function sendWithMailApp(to: string, mail: NotesEmail): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('The Mail app is only available on a Mac.'));
  // Values are passed as arguments, never pasted into the script, so nothing in the notes can change what it does.
  const script = `on run argv
  set theSubject to item 1 of argv
  set theBody to item 2 of argv
  set theAddress to item 3 of argv
  tell application "Mail"
    set newMessage to make new outgoing message with properties {subject:theSubject, content:theBody, visible:false}
    tell newMessage to make new to recipient at end of to recipients with properties {address:theAddress}
    send newMessage
  end tell
end run`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, mail.subject, mail.text, to], { timeout: 60000 }, (err, _out, stderr) => {
      if (!err) return resolve();
      const why = String(stderr || err.message);
      reject(new Error(/-1743|not authori[sz]ed|not allowed/i.test(why) ? 'Hark is not allowed to control Mail. Allow it in System Settings → Privacy & Security → Automation → Hark → Mail.' : /account|-1728|-10000/i.test(why) ? 'The Mail app has no account it can send from. Add one in Mail, or switch to sending from Gmail.' : `The Mail app couldn't send it: ${why.trim().split('\n')[0]}`));
    });
  });
}

export const validEmail = (s: string): boolean => /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s.trim());
