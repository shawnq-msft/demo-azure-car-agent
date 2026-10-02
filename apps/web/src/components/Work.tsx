import { useState, type FormEvent } from "react";
import type { DemoState, Locale, Meeting } from "@car/contracts";
import type { Messages } from "../i18n";
import { localDateTime } from "../utils";
import type { RunAction } from "./Vehicle";

export function Work({ state, t, locale, run, busy }: { state: DemoState; t: Messages; locale: Locale; run: RunAction; busy: boolean }) {
  const [view, setView] = useState<"meetings" | "mail">("meetings");
  const [editing, setEditing] = useState<Meeting | "new" | null>(null);
  const [compose, setCompose] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [summary, setSummary] = useState<unknown>(null);
  const submitMeeting = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const date = new Date(String(data.get("startsAt")));
    const duration = Number(data.get("durationMinutes"));
    if (!String(data.get("title")).trim() || !String(data.get("location")).trim() || data.getAll("attendees").length === 0 || !Number.isFinite(date.getTime()) || !Number.isInteger(duration) || duration < 5 || duration > 480) { setInvalid(true); return; }
    setInvalid(false);
    const args = {
      title: String(data.get("title")).trim(), startsAt: date.toISOString(), durationMinutes: duration,
      attendees: data.getAll("attendees").map(String),
      location: String(data.get("location")), notes: String(data.get("notes"))
    };
    void run(editing === "new" ? "work.createMeeting" : "work.updateMeeting", { ...args, ...(editing && editing !== "new" ? { id: editing.id } : {}) }).then(result => { if (result && result.status !== "unavailable") setEditing(null); });
  };
  const submitMail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const args = { to: String(data.get("to")).trim(), subject: String(data.get("subject")).trim(), body: String(data.get("body")).trim() };
    if (!args.to || !args.subject || !args.body) { setInvalid(true); return; }
    setInvalid(false);
    void run("work.sendMail", args).then(result => { if (result && result.status !== "unavailable") setCompose(false); });
  };
  const meeting = editing && editing !== "new" ? editing : null;
  return <div className="panel-stack">
    <section className="card"><div className="section-heading"><div><div className="eyebrow">WORK IQ MOCKUP</div><h2>{t.workTitle}</h2></div><span className="badge mock">{t.simulation}</span></div><p className="muted">{t.workNote}</p>
      <div className="work-toolbar"><div className="segmented" aria-label={t.work}>{(["meetings", "mail"] as const).map(key => <button key={key} aria-pressed={view === key} className={view === key ? "selected" : ""} onClick={() => { setView(key); void run("work.query", { kind: key }); }}>{t[key]} <span>{state[key].length}</span></button>)}</div><button disabled={busy} onClick={() => void run("work.query", { kind: view })}>{t.refresh}</button></div>
      {view === "meetings" ? <>
        <button data-testid="work-create-meeting" className="primary" disabled={busy} onClick={() => { setEditing("new"); setCompose(false); setInvalid(false); }}>{t.createMeeting} +</button>
        <div className="record-list">{state.meetings.length === 0 && <p className="muted">{t.noMeeting}</p>}{state.meetings.map(item => <article className="meeting-record" key={item.id}>
          <div className="meeting-date"><strong>{new Date(item.startsAt).toLocaleDateString(locale, { day: "2-digit" })}</strong><span>{new Date(item.startsAt).toLocaleDateString(locale, { month: "short" })}</span></div>
          <div className="grow"><h3>{item.title}</h3><p className="muted small">{new Date(item.startsAt).toLocaleString(locale)} · {item.durationMinutes} {t.minute}</p><p className="muted small">{item.location} · {item.attendees.join(", ")}</p>{item.notes && <p className="small">{item.notes}</p>}
            <div className="button-row"><button disabled={busy} onClick={() => { setEditing(item); setInvalid(false); }}>{t.edit}</button><button disabled={busy} onClick={() => void run("work.summarize", { id: item.id }).then(result => { if (result?.status === "completed") setSummary(result.data); })}>{t.summarize}</button></div>
          </div>
        </article>)}</div>
      </> : <>
        <button data-testid="work-send-mail" className="primary" disabled={busy} onClick={() => { setCompose(true); setEditing(null); setInvalid(false); }}>{t.compose} +</button>
        <div className="record-list">{state.mail.length === 0 && <p className="muted">{t.noMail}</p>}{state.mail.map(item => <article className="mail-record" key={item.id}><div className="section-heading"><h3>{item.subject}</h3>{item.sent && <span className="badge mock">{t.sent}</span>}</div><p className="small muted">{item.from} → {item.to}</p><p className="mail-body">{item.body}</p></article>)}</div>
      </>}
      <button className="danger-text" disabled={busy} onClick={() => void run("work.reset", {})}>{t.reset}</button>
    </section>
    {editing && <section className="card" key={meeting?.id ?? "new"}><h3>{meeting ? t.editMeeting : t.createMeeting}</h3><form onSubmit={submitMeeting} noValidate><div className="form-grid">
      <label className="span-2">{t.title} *<input name="title" required maxLength={160} defaultValue={meeting?.title} /></label>
      <label>{t.startsAt} *<input type="datetime-local" name="startsAt" required defaultValue={meeting ? localDateTime(meeting.startsAt) : ""} /></label>
      <label>{t.durationMinutes} *<input type="number" name="durationMinutes" required min={5} max={480} defaultValue={meeting?.durationMinutes ?? 30} /></label>
      <fieldset className="span-2"><legend>{t.attendeesHint} *</legend>{["alex@example.test", "mei@example.test", "sam@example.test"].map(address => <label className="check-label" key={address}><input type="checkbox" name="attendees" value={address} defaultChecked={meeting ? meeting.attendees.includes(address) : address === "alex@example.test"} />{address}</label>)}</fieldset>
      <label className="span-2">{t.location} *<input name="location" required maxLength={200} defaultValue={meeting?.location} /></label>
      <label className="span-2">{t.notes}<textarea name="notes" rows={3} maxLength={2000} defaultValue={meeting?.notes} /></label>
    </div>{invalid && <p className="error-banner" role="alert">{t.formError}</p>}<div className="button-row"><button className="primary" disabled={busy}>{t.save}</button><button type="button" onClick={() => setEditing(null)}>{t.cancel}</button></div></form></section>}
    {compose && <section className="card"><h3>{t.compose}</h3><form onSubmit={submitMail} noValidate><div className="form-grid">
      <label className="span-2">{t.to} *<select name="to">{["alex@example.test", "mei@example.test", "sam@example.test"].map(address => <option key={address}>{address}</option>)}</select></label><label className="span-2">{t.subject} *<input name="subject" required maxLength={200} /></label><label className="span-2">{t.body} *<textarea name="body" rows={5} required maxLength={5000} /></label>
    </div>{invalid && <p className="error-banner" role="alert">{t.formError}</p>}<div className="button-row"><button className="primary" disabled={busy}>{t.send}</button><button type="button" onClick={() => setCompose(false)}>{t.cancel}</button></div></form></section>}
    {summary !== null && <section className="card"><div className="section-heading"><h3>{t.summary}</h3><button onClick={() => setSummary(null)}>{t.close}</button></div><pre className="data-block">{typeof summary === "string" ? summary : JSON.stringify(summary, null, 2)}</pre></section>}
  </div>;
}
