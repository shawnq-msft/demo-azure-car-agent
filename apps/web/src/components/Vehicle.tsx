import { useState } from "react";
import type { ActionName, ActionResult, DemoState } from "@car/contracts";
import type { Messages } from "../i18n";
import { Icon, type IconName } from "./Icon";

export type RunAction = (name: ActionName, args: Record<string, unknown>) => Promise<ActionResult | undefined>;
export function Vehicle({ state, t, run, busy }: { state: DemoState; t: Messages; run: RunAction; busy: boolean }) {
  const [contact, setContact] = useState("Alex Chen");
  return <div className="panel-stack">
    <section className="card climate-card">
      <div className="section-heading"><div><div className="eyebrow">{t.vehicle} / 01</div><h2>{t.climate}</h2></div><span className="badge mock">{t.simulation}</span></div>
      <div className="climate-scene">
        <div className="temperature"><span className="muted">{t.temperature}</span><strong data-testid="vehicle-temperature">{state.vehicle.temperature}<sup>°</sup></strong><div className="temperature-controls"><button aria-label={`${t.temperature} −`} disabled={busy || state.vehicle.temperature <= 16} onClick={() => void run("vehicle.set", { temperature: state.vehicle.temperature - 1 })}>−</button><span>°C</span><button aria-label={`${t.temperature} +`} disabled={busy || state.vehicle.temperature >= 30} onClick={() => void run("vehicle.set", { temperature: state.vehicle.temperature + 1 })}>+</button></div></div>
        <div className="car-visual" aria-hidden="true"><svg viewBox="0 0 430 230"><defs><linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b4c6be" /><stop offset=".5" stopColor="#526960" /><stop offset="1" stopColor="#263b32" /></linearGradient><linearGradient id="glass"><stop stopColor="#11241c" /><stop offset="1" stopColor="#263d32" /></linearGradient></defs><ellipse cx="211" cy="193" rx="173" ry="15" fill="#07100c" /><path d="M36 161 53 126 110 111 151 65Q207 40 267 63L318 107l54 14 29 40-13 24H47Z" fill="url(#body)" stroke="#a4baaf" strokeWidth="1.5"/><path d="m119 109 36-37q47-20 101-2l46 39Z" fill="url(#glass)" stroke="#8ea99c"/><path d="M204 65v45m-90 16h195m-99-15v62m102-60 10 49M72 142H45m315-3 29 4" fill="none" stroke="#a3b9ae" strokeWidth="2"/><path d="m50 149 38-6m251-10 36 8" stroke="#d3ffae" strokeWidth="6"/><circle cx="109" cy="179" r="31" fill="#101815" stroke="#53675d" strokeWidth="5"/><circle cx="109" cy="179" r="17" fill="#7a8f85"/><circle cx="324" cy="179" r="31" fill="#101815" stroke="#53675d" strokeWidth="5"/><circle cx="324" cy="179" r="17" fill="#7a8f85"/><path d="m109 162 0 34m-17-17h34m198-17v34m-17-17h34" stroke="#21382c" strokeWidth="6"/></svg><span className="car-label">ARIA / CONCEPT 01</span></div>
      </div>
      <div className="control-grid">{(["fan", "windowOpen", "seatHeat", "locked"] as const).map(key => {
        const active = state.vehicle[key];
        const value = key === "locked" ? active ? t.lockedLabel : t.unlocked : key === "windowOpen" ? active ? t.open : t.closed : active ? t.on : t.off;
        return <button className={`control-tile ${active ? "active" : ""}`} key={key} disabled={busy} aria-pressed={active} onClick={() => void run("vehicle.set", { [key]: !active })}><Icon name={key as IconName} size={26} /><span>{t[key]}</span><small>{value}</small><span className="tiny-toggle" /></button>;
      })}</div>
      <div className="driving-row"><div><Icon name="driving" /><span>{t.driving}</span><span className={`badge ${state.vehicle.driving ? "warning" : ""}`}>{state.vehicle.driving ? t.moving : t.parked}</span></div><button className="toggle" role="switch" aria-checked={state.vehicle.driving} aria-label={t.driving} disabled={busy} onClick={() => void run("vehicle.set", { driving: !state.vehicle.driving })}><span /></button></div>
      <p className="muted small">{t.simulationNote} {t.drivingNote}</p>
    </section>
    <section className="card phone-card"><div className="section-heading"><div className="icon-title"><span className="icon-box"><Icon name="phone" /></span><div><h3>{t.phone}</h3><p className="muted small">{state.phone.connected ? t.connected : t.disconnected}</p></div></div><span className="badge mock">{t.simulation}</span></div>
      <div className="button-row"><button disabled={busy} onClick={() => void run("phone.connect", { connected: !state.phone.connected })}>{state.phone.connected ? t.disconnect : t.connectPhone}</button></div>
      {state.phone.connected && <form className="search-row" onSubmit={event => { event.preventDefault(); if (contact.trim()) void run("phone.call", { contact: contact.trim() }); }}><label className="grow">{t.contact}<select value={contact} onChange={event => setContact(event.target.value)}>{["Alex Chen", "Mei Tanaka", "Sam Rivera"].map(name => <option key={name}>{name}</option>)}</select></label><button disabled={busy || !contact.trim()} type="submit">{t.call}</button></form>}
      <p className="muted">{state.phone.activeContact ? `${t.calling} ${state.phone.activeContact}` : t.noCall}</p>
      {state.phone.activeContact && <button disabled={busy} onClick={() => void run("phone.hangup", {})}>{t.hangup}</button>}
    </section>
  </div>;
}
