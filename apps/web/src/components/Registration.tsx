import { useState, type FormEvent } from "react";
import { locales, registrationSchema, type Locale, type RegistrationResult } from "@car/contracts";
import { api } from "../api";
import { errorMessage } from "../utils";
import { languageNames, type Messages } from "../i18n";
import { Icon } from "./Icon";

export function Registration({ t, locale, setLocale, onRegistered }: { t: Messages; locale: Locale; setLocale: (locale: Locale) => void; onRegistered: (result: RegistrationResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const parsed = registrationSchema.safeParse({
      name: data.get("name"), company: data.get("company"), email: data.get("email"), scenario: data.get("scenario"),
      phone: data.get("phone") || undefined, timeline: data.get("timeline") || undefined,
      privacyConsent: data.get("privacyConsent") === "on", marketingConsent: data.get("marketingConsent") === "on", locale, website: ""
    });
    setInvalid(!parsed.success); setError(null);
    if (!parsed.success) return;
    setBusy(true);
    try { onRegistered(await api.register(parsed.data)); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return <main className="registration-screen">
    <section className="registration-story">
      <a className="wordmark" href="#">{t.brand}<span>{t.subtitle}</span></a>
      <div className="story-copy"><div className="eyebrow"><span className="status-dot" />{t.localOnly}</div><h1>{t.experience}</h1><p>{t.intro}</p></div>
      <div className="registration-orbit" aria-hidden="true"><div /><div /><span><Icon name="driving" size={104} /></span></div>
      <div className="story-bottom"><span>01 — {t.cockpit}</span><span>{t.localOnly}</span></div>
    </section>
    <section className="registration-form-area">
      <label className="locale-select">{t.language}<select data-testid="locale-select" value={locale} onChange={e => setLocale(e.target.value as Locale)}>{locales.map(code => <option value={code} key={code}>{languageNames[code]}</option>)}</select></label>
      <div className="form-intro"><div className="eyebrow">{t.welcome}</div><h2>{t.registration}</h2><p className="muted">{t.registrationHint}</p></div>
      <form data-testid="registration-form" onSubmit={submit} noValidate className="registration-form">
        <div className="form-grid">
          <label>{t.name} *<input data-testid="register-name" name="name" required maxLength={80} autoComplete="name" /></label>
          <label>{t.company} *<input data-testid="register-company" name="company" required maxLength={120} autoComplete="organization" /></label>
          <label className="span-2">{t.email} *<input data-testid="register-email" name="email" type="email" required maxLength={254} autoComplete="email" /></label>
          <label className="span-2">{t.scenario} *<textarea data-testid="register-scenario" name="scenario" required minLength={3} maxLength={1000} rows={3} /></label>
          <label>{t.phone} <span className="muted">({t.optional})</span><input name="phone" type="tel" maxLength={40} autoComplete="tel" /></label>
          <label>{t.timeline} <span className="muted">({t.optional})</span><input name="timeline" maxLength={120} /></label>
        </div>
        <details className="privacy-detail"><summary>{t.privacyLabel}</summary><p>{t.privacyNotice}</p></details>
        <label className="check-label"><input data-testid="register-privacy" type="checkbox" name="privacyConsent" required /><span>{t.privacy}</span></label>
        <label className="check-label"><input data-testid="register-marketing" type="checkbox" name="marketingConsent" /><span>{t.marketing}</span></label>
        {(invalid || error !== null) && <p role="alert" className="error-banner">{invalid ? t.required : errorMessage(error, t)}</p>}
        <button data-testid="register-submit" className="primary wide" disabled={busy} type="submit">{busy ? t.connecting : t.register}<Icon name="arrow" /></button>
      </form>
    </section>
  </main>;
}
