import { useEffect, useRef } from "react";
import type { ActionRequest } from "@car/contracts";
import type { Messages } from "../i18n";

export function ConfirmationDialog({ action, t, busy, onAnswer }: { action: ActionRequest; t: Messages; busy: boolean; onAnswer: (confirm: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog className="confirmation-dialog" ref={dialog} aria-labelledby="confirmation-title" onCancel={event => { event.preventDefault(); if (!busy) onAnswer(false); }}>
    <span className="badge warning">{t.confirmationRequired}</span><h2 id="confirmation-title">{t.confirmation}</h2><p className="muted">{t.confirmNote}</p>
    <div className="confirmation-action">{action.name}</div><pre className="data-block">{JSON.stringify(action.args, null, 2)}</pre>
    <div className="button-row"><button data-testid="action-confirm" className="primary" autoFocus disabled={busy} onClick={() => onAnswer(true)}>{t.confirm}</button><button data-testid="action-cancel" disabled={busy} onClick={() => onAnswer(false)}>{t.cancel}</button></div>
  </dialog>;
}
