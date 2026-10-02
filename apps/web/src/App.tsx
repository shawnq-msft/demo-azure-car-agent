import { useCallback, useEffect, useRef, useState } from "react";
import { actionSchema, locales, modelIds, type MediaRequest, type ActionRequest, type ActionResult, type Capabilities, type ClientEvent, type DemoState, type Locale, type ModelId, type RegistrationResult, type ServerEvent, type UsageSummary, type VideoResult } from "@car/contracts";
import { api, ApiError, socketUrl } from "./api";
import { VoiceAudio } from "./audio";
import { PcmAudio } from "./pcmAudio";
import { dictionaries, initialLocale, languageNames } from "./i18n";
import { errorMessage } from "./utils";
import { MediaControl } from "./mediaControl";
import { Icon, type IconName } from "./components/Icon";
import { Registration } from "./components/Registration";
import { Vehicle, type RunAction } from "./components/Vehicle";
import { Navigation } from "./components/Navigation";
import { Media } from "./components/Media";
import { Work } from "./components/Work";
import { Metrics } from "./components/Metrics";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { Admin, adminLabels } from "./components/Admin";
import "./styles.css";

type Tab = "vehicle" | "navigation" | "media" | "work" | "metrics";
type VoiceStatus = "off" | "starting" | "on";
type Transcript = { id: string; role: "you" | "aria"; text: string };
type Confirmation = { action: ActionRequest; id: string };

export default function App() {
  const [adminRoute, setAdminRoute] = useState(() => window.location.hash === "#/admin");
  useEffect(() => {
    const route = () => setAdminRoute(window.location.hash === "#/admin");
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  return adminRoute ? <Admin /> : <Cockpit />;
}

function Cockpit() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [registration, setRegistration] = useState<RegistrationResult | null>(null);
  const [state, setState] = useState<DemoState | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [tab, setTab] = useState<Tab>("vehicle");
  const [model, setModel] = useState<ModelId>("gpt-realtime-2.1");
  const [actualModel, setActualModel] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceStatus>("off");
  const [transport, setTransport] = useState<"webrtc" | "websocket">("websocket");
  const transportChosen = useRef(false);
  const [socketReady, setSocketReady] = useState(false);
  const [socketAttempt, setSocketAttempt] = useState(0);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<"voiceEnded" | "mediaStopped" | null>(null);
  const [selected, setSelected] = useState<VideoResult | null>(null);
  const [mediaPending, setMediaPending] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [mediaFocused, setMediaFocused] = useState(false);
  const responses = useRef(new Set<string>());
  const speechEndReceived = useRef<number | null>(null);
  const liveTranscriptSequence = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const audio = useRef(new VoiceAudio());
  const pcmAudio = useRef(new PcmAudio());
  const voiceRef = useRef<VoiceStatus>("off");
  const tokenRef = useRef<string | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const t = dictionaries[locale];
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const stateRef = useRef(state); stateRef.current = state;
  const handleResultRef = useRef<(result: ActionResult, action?: ActionRequest) => void>(() => {});
  const activeModel = capabilities?.models.find(item => item.id === model);
  const token = registration?.token ?? null;
  tokenRef.current = token;

  const send = useCallback((event: ClientEvent) => {
    if (socket.current?.readyState !== WebSocket.OPEN) throw new ApiError("network");
    if (socket.current.bufferedAmount > 256000) throw new ApiError("network");
    socket.current.send(JSON.stringify(event));
  }, []);
  const [media] = useState(() => new MediaControl(
    video => { setSelected(video); if (video) setTab("media"); },
    event => { try { send(event); } catch { setError(new ApiError("network")); } },
    (pending, failed) => { setMediaPending(pending); setMediaFailed(failed); }
  ));
  const focusMedia = useCallback((active: boolean) => { media.setFocus(active); setMediaFocused(active); }, [media]);
  const releaseMedia = useCallback(() => {
    if (!responses.current.size && !pcmAudio.current.playbackPending && ((transport !== "webrtc" && model !== "gpt-live-1") || voiceRef.current === "off")) focusMedia(false);
  }, [focusMedia, transport, model]);
  pcmAudio.current.onPlaybackDrained = releaseMedia;
  pcmAudio.current.onPlaybackStarted = time => {
    const start = speechEndReceived.current;
    speechEndReceived.current = null;
    if (start !== null && time >= start && time - start <= 120000) {
      try { send({ type: "metrics", latencyMs: time - start, basis: "browser-vad-receipt-to-audio-output" }); }
      catch { setError(new ApiError("network")); }
    }
  };
  const stopVoice = useCallback((notify = true) => {
    if (notify && voiceRef.current !== "off" && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "voice.stop" }));
    voiceRef.current = "off"; setVoice("off");
    clearTimeout(idleTimer.current); clearTimeout(startTimer.current); clearTimeout(sessionTimer.current);
    audio.current.stop();
    speechEndReceived.current = null;
    pcmAudio.current.stop();
    responses.current.clear(); media.setVoiceActive(false); focusMedia(false);
  }, [focusMedia, media]);
  const refreshUsage = useCallback(() => {
    const currentToken = tokenRef.current;
    if (currentToken) void api.usage(currentToken).then(value => { if (tokenRef.current === currentToken) setUsage(value); }).catch(e => { if (tokenRef.current === currentToken) setError(e); });
  }, []);
  const resetIdle = useCallback(() => {
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => { stopVoice(); setNotice("voiceEnded"); refreshUsage(); }, (capabilities?.limits.idleSeconds ?? 60) * 1000);
  }, [capabilities?.limits.idleSeconds, refreshUsage, stopVoice]);
  const failVoice = useCallback(() => { stopVoice(); setError(new ApiError("voice")); }, [stopVoice]);
  const refreshCapabilities = useCallback(() => {
    setError(null);
    void api.capabilities().then(value => {
      setCapabilities(value);
      if (!transportChosen.current) setTransport(value.voiceTransports?.webrtc.status === "ready" ? "webrtc" : "websocket");
    }).catch(setError);
  }, []);

  useEffect(() => { refreshCapabilities(); }, [refreshCapabilities]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => { stopVoice(); }, [locale, model, transport, stopVoice]);
  useEffect(() => { if (model !== "gpt-realtime-2.1" && transport !== "websocket") setTransport("websocket"); }, [model, transport]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { media.choose(null); stopVoice(); } };
    const pagehide = () => { media.choose(null); stopVoice(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", pagehide); media.choose(null); stopVoice(); };
  }, [stopVoice, media]);
  useEffect(() => {
    pcmAudio.current.setCaptureEnabled(confirmations.length === 0);
    audio.current.setCaptureEnabled(confirmations.length === 0);
  }, [confirmations.length]);
  useEffect(() => {
    media.setDriving(!!state?.vehicle.driving);
    if (state?.vehicle.driving && selectedRef.current) setNotice("mediaStopped");
  }, [state?.vehicle.driving, media]);
  useEffect(() => {
    if (tab !== "media") media.choose(null);
  }, [tab, media]);

  handleResultRef.current = (next, original) => {
    if (next.state && (!stateRef.current || next.state.revision >= stateRef.current.revision)) {
      stateRef.current = next.state; setState(next.state);
      media.setDriving(next.state.vehicle.driving);
    }
    setResult(next);
    if (next.status === "confirmation-required" && next.confirmationId) {
      speechEndReceived.current = null;
      pcmAudio.current.setCaptureEnabled(false);
      audio.current.setCaptureEnabled(false);
      const data = next.data as { preview?: { name: string; args: Record<string, unknown> }; action?: ActionRequest } | undefined;
      const parsed = actionSchema.safeParse(data?.action ?? original ?? { callId: next.callId, ...data?.preview });
      if (parsed.success) setConfirmations(previous => [...previous.filter(item => item.action.callId !== next.callId), { action: parsed.data, id: next.confirmationId! }]);
    } else setConfirmations(previous => previous.filter(item => item.action.callId !== next.callId));
    if (next.provider === "client") {
      const data = next.data as { code?: string; execution?: string; request?: MediaRequest | { platform: "spotify" } } | undefined;
      const request = data?.request;
      if (request?.platform === "spotify" || data?.code === "spotify-policy" || data?.code === "spotify-policy-restricted") {
        setError(new ApiError("spotify-policy-restricted"));
        setResult(null);
        return;
      }
      if (request && next.status === "completed" && data?.execution === "requested") media.submit({ ...request, callId: next.callId } as MediaRequest);
    }
  };

  useEffect(() => {
    if (!token) return;
    const currentToken = token;
    let disposed = false;
    setSocketReady(false);
    const ws = new WebSocket(socketUrl());
    socket.current = ws;
    const authTimeout = setTimeout(() => { if (!disposed) { ws.close(); setError(new ApiError("network")); } }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: currentToken }));
    ws.onmessage = message => {
      if (disposed || tokenRef.current !== currentToken) return;
      let event: ServerEvent;
      try { event = JSON.parse(String(message.data)) as ServerEvent; } catch { return; }
      if (event.type === "authenticated") {
        clearTimeout(authTimeout); setSocketReady(true); setState(event.demo); return;
      }
      if (event.type === "action.result") { handleResultRef.current(event.result); return; }
      if (event.type === "usage") { setUsage(event.usage); return; }
      if (event.type === "error") { setError(new ApiError(event.code)); if (voiceRef.current !== "off") stopVoice(); return; }
      if (event.type === "voice.ended") { stopVoice(false); setNotice("voiceEnded"); refreshUsage(); return; }
      if (event.type === "voice.started") {
        if (voiceRef.current !== "starting") { ws.send(JSON.stringify({ type: "voice.stop" })); return; }
        setActualModel(event.model);
        if (event.transport === "webrtc") void audio.current.offer(send, failVoice, () => {
          if (voiceRef.current === "off" || disposed) return;
          clearTimeout(startTimer.current); voiceRef.current = "on"; setVoice("on"); resetIdle();
        }).catch(failVoice);
        else {
          pcmAudio.current.start(); clearTimeout(startTimer.current); voiceRef.current = "on"; setVoice("on");
        }
        sessionTimer.current = setTimeout(() => { stopVoice(); setNotice("voiceEnded"); refreshUsage(); }, (capabilities?.limits.sessionSeconds ?? 600) * 1000);
        resetIdle();
        return;
      }
      if (event.type !== "voice.event" || voiceRef.current === "off") return;
      const upstream = event.event;
      if (upstream.type === "response.created") {
        const response = upstream.response as { id?: string } | undefined;
        if (response?.id) responses.current.add(response.id);
        focusMedia(true);
      }
      if (upstream.type === "response.audio.delta" || upstream.type === "response.output_audio.delta" || upstream.type === "session.output_audio.delta") {
        focusMedia(true);
        try { pcmAudio.current.append(upstream); } catch { failVoice(); }
      }
      if (upstream.type === "input_audio_buffer.speech_started") {
        speechEndReceived.current = null;
        try { pcmAudio.current.interrupt(send); } catch { failVoice(); }
      }
      if (upstream.type === "input_audio_buffer.speech_stopped" && transport === "websocket") {
        speechEndReceived.current = performance.now();
        pcmAudio.current.observeNextPlayback();
      }
      if (upstream.type === "session.input_transcript.delta" || upstream.type === "session.output_transcript.delta") {
        resetIdle();
        if (typeof upstream.delta === "string" && upstream.delta) {
          const item: Transcript = { id: `live-fragment-${++liveTranscriptSequence.current}`, role: upstream.type === "session.input_transcript.delta" ? "you" : "aria", text: upstream.delta };
          setTranscripts(previous => [...previous, item].slice(-80));
        }
      }
      if (upstream.type === "rtc.call.sdp.created") {
        void audio.current.answer(upstream).catch(failVoice);
      }
      if (upstream.type === "response.done") {
        const response = upstream.response as { id?: string } | undefined;
        if (response?.id) responses.current.delete(response.id);
        releaseMedia();
      }
      if (typeof upstream.type !== "string") return;
      if (upstream.type === "input_audio_buffer.speech_started" || upstream.type === "input_audio_buffer.speech_stopped" || upstream.type === "response.done") resetIdle();
      const userTranscript = upstream.type === "conversation.item.input_audio_transcription.completed";
      const assistantDelta = upstream.type === "response.audio_transcript.delta" || upstream.type === "response.output_audio_transcript.delta";
      const assistantDone = upstream.type === "response.audio_transcript.done" || upstream.type === "response.output_audio_transcript.done";
      if (userTranscript || assistantDelta || assistantDone) {
        resetIdle();
        const text = typeof upstream.transcript === "string" ? upstream.transcript : typeof upstream.delta === "string" ? upstream.delta : "";
        if (!text) return;
        const id = `${userTranscript ? "user" : "assistant"}-${String(upstream.item_id ?? upstream.response_id ?? "current")}`;
        setTranscripts(previous => {
          const existing = previous.find(item => item.id === id);
          const item: Transcript = { id, role: userTranscript ? "you" : "aria", text: assistantDelta ? (existing?.text ?? "") + text : text };
          return (existing ? previous.map(value => value.id === id ? item : value) : [...previous, item]).slice(-80);
        });
      }
    };
    ws.onerror = () => { if (!disposed) { stopVoice(false); setError(new ApiError("network")); } };
    ws.onclose = () => { clearTimeout(authTimeout); if (!disposed) { setSocketReady(false); stopVoice(false); setError(new ApiError("connectionLost")); } };
    return () => { disposed = true; clearTimeout(authTimeout); stopVoice(); ws.close(); if (socket.current === ws) socket.current = null; };
  }, [token, socketAttempt, send, stopVoice, failVoice, refreshUsage, resetIdle, capabilities?.limits.sessionSeconds, focusMedia, releaseMedia]);

  const run: RunAction = async (name, args) => {
    const currentToken = tokenRef.current;
    if (!currentToken || busy || confirmations.length) return undefined;
    setBusy(true); setError(null); setResult(null);
    const action: ActionRequest = { callId: crypto.randomUUID(), name, args };
    try {
      if (name === "media.control" && args.platform === "spotify") throw new ApiError("spotify-policy-restricted");
      const next = await api.action(currentToken, action);
      if (tokenRef.current === currentToken) handleResultRef.current(next, action);
      return next;
    } catch (e) { if (tokenRef.current === currentToken) setError(e); return undefined; }
    finally { if (tokenRef.current === currentToken) setBusy(false); }
  };
  const confirmAction = async (confirmation: Confirmation, confirm: boolean) => {
    if (!token || busy) return;
    setBusy(true); setError(null);
    try {
      const next = await api.action(token, { ...confirmation.action, confirmationId: confirmation.id, confirm });
      if (tokenRef.current === token) handleResultRef.current(next, confirmation.action);
    } catch (e) {
      if (tokenRef.current === token) {
        setError(e);
        if (e instanceof ApiError && e.status === 409) setConfirmations(previous => previous.filter(item => item.id !== confirmation.id));
      }
    } finally { if (tokenRef.current === token) setBusy(false); }
  };
  const startVoice = async () => {
    if (voiceRef.current !== "off") { stopVoice(); refreshUsage(); return; }
    if (activeModel?.status !== "ready" || !socketReady || busy || confirmations.length) return;
    media.userPause();
    media.setVoiceActive(true);
    focusMedia(true);
    if (selectedRef.current?.platform === "bilibili") media.choose(null);
    setError(null); setNotice(null); setActualModel(null);
    voiceRef.current = "starting"; setVoice("starting");
    startTimer.current = setTimeout(failVoice, 30000);
    try {
      if (transport === "webrtc") await audio.current.prepare();
      else await pcmAudio.current.prepare(send, failVoice);
      if (document.hidden || voiceRef.current !== "starting") { stopVoice(); return; }
      send({ type: "voice.start", model, locale, transport });
      if (transport === "websocket") releaseMedia();
    } catch {
      if ((voiceRef.current as VoiceStatus) !== "off") { stopVoice(); setError(new ApiError("microphone")); }
    }
  };
  const registered = (value: RegistrationResult) => { setRegistration(value); setState(value.demo); setError(null); setResult(null); };
  const logout = () => {
    media.choose(null);
    stopVoice(); socket.current?.close(); tokenRef.current = null;
    setRegistration(null); setState(null); setUsage(null); setTranscripts([]); setConfirmations([]); setResult(null); setSelected(null); setError(null); setNotice(null); setBusy(false); setTab("vehicle");
  };
  useEffect(() => { if (token) refreshUsage(); }, [token, refreshUsage]);
  useEffect(() => {
    if (!registration) return;
    const timer = setTimeout(() => { stopVoice(); setError(new ApiError("expired", 401)); }, Math.max(0, Date.parse(registration.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [registration, stopVoice]);

  if (!registration || !state) return <>
    <Registration t={t} locale={locale} setLocale={setLocale} onRegistered={registered} />
    <footer className="main-footer"><a href="#/admin">{adminLabels[locale].title}</a></footer>
  </>;
  const errorText = error instanceof ApiError && ["voice", "microphone", "connectionLost"].includes(error.code)
    ? error.code === "voice" ? t.voiceError : error.code === "microphone" ? t.microphoneError : t.connectionLost
    : errorMessage(error, t);
  const locked = busy || confirmations.length > 0;
  return <div className="app-shell" data-testid="cockpit">
    <header className="topbar"><a href="#" className="wordmark" onClick={event => { event.preventDefault(); setTab("vehicle"); }}>{t.brand}<span>{t.subtitle}</span></a><div className="topbar-center"><span className="status-dot" /><span>{t.localOnly}</span><span className="separator">/</span><span>{t.simulation}</span></div><div className="topbar-controls"><label><span className="sr-only">{t.language}</span><select data-testid="locale-select" value={locale} onChange={event => setLocale(event.target.value as Locale)}>{locales.map(code => <option key={code} value={code}>{languageNames[code]}</option>)}</select></label><button className="icon-button" aria-label={t.logout} title={t.logout} onClick={logout}><Icon name="close" size={18} /></button></div></header>
    <div className="cockpit-layout"><nav className="sidebar" aria-label={t.cockpit}><div className="nav-items">{(["vehicle", "navigation", "media", "work", "metrics"] as Tab[]).map(name => <button key={name} data-testid={`${name}-tab`} className={`nav-item ${tab === name ? "selected" : ""}`} aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)}><Icon name={name as IconName} size={23} /><span>{t[name]}</span></button>)}</div><div className="sidebar-bottom"><span className="status-dot" /><span>{t[state.vehicle.driving ? "moving" : "parked"]}</span></div></nav>
      <main className="main-panel"><div className="page-title"><div><p className="eyebrow">{t.welcome}</p><h1>{t.headline}</h1></div><span className="revision">{t.revision} {state.revision.toString().padStart(2, "0")}</span></div>
        {error !== null && <div className="error-banner" role="alert"><span>{errorText}</span><button onClick={() => setError(null)} aria-label={t.close}><Icon name="close" size={16} /></button></div>}
        {notice && <div className="notice" role="status">{t[notice]}<button onClick={() => setNotice(null)} aria-label={t.close}><Icon name="close" size={16} /></button></div>}
        {result && result.status !== "confirmation-required" && <div className={`result-banner ${result.status === "unavailable" ? "error-banner" : ""}`} role="status"><span>{result.provider === "client" && result.data && typeof result.data === "object" && "execution" in result.data && result.data.execution === "requested" ? t.mediaRequested : result.status === "completed" ? t.completed : result.status === "cancelled" ? t.cancelled : t.unavailableError}{result.provider === "mock" ? ` · ${t.simulation}` : ""}</span><button onClick={() => setResult(null)} aria-label={t.close}><Icon name="close" size={16} /></button></div>}
        {tab === "vehicle" && <Vehicle state={state} t={t} run={run} busy={locked} />}
        {tab === "navigation" && <Navigation t={t} capability={capabilities?.maps} run={run} busy={locked} result={result} />}
        {tab === "media" && <Media t={t} capability={capabilities?.webIq} run={run} busy={locked} blocked={state.vehicle.driving} selected={selected} setSelected={video => media.choose(video)} result={result} control={media} focused={mediaFocused} pending={mediaPending} failed={mediaFailed} voiceActive={voice !== "off"} />}
        {tab === "work" && <Work state={state} t={t} locale={locale} run={run} busy={locked} />}
        {tab === "metrics" && <Metrics t={t} usage={usage} capabilities={capabilities} refresh={refreshUsage} token={token ?? undefined} locale={locale} />}
        <footer className="main-footer"><span>ARIA · AZURE VOICE LIVE</span><a href="#/admin">{adminLabels[locale].title}</a><span>{voice === "off" ? t.localOnly : transport === "webrtc" ? t.preview : t.transportFallback}</span></footer>
      </main>
      <aside className="assistant-panel"><div className="assistant-top"><div className="eyebrow"><span className="status-dot" />{t.assistant}</div><span className="badge">VOICE LIVE</span></div><h2>{t.assistantTitle}</h2>
        <div className={`voice-orb ${voice !== "off" ? "awake" : ""}`} aria-hidden="true"><div className="orb-ring" /><div className="orb-core"><span /><span /><span /><span /><span /><span /><span /></div><div className="orb-ring outer" /></div>
        <button className={`wake-button ${voice !== "off" ? "awake" : ""}`} disabled={voice === "off" && (!socketReady || activeModel?.status !== "ready" || locked)} onClick={() => void startVoice()}><Icon name="mic" size={20} />{voice === "off" ? t.wake : voice === "starting" ? t.starting : t.endVoice}</button>
        <p className="voice-status" aria-live="polite">{voice === "on" ? t.listening : voice === "starting" ? t.connecting : activeModel?.status === "ready" ? t.ready : t.voiceUnconfigured}</p>
        {!socketReady && <button onClick={() => { setError(null); setSocketAttempt(value => value + 1); }}>{t.retry}</button>}
        <label className="model-label">{t.model}<select value={model} onChange={event => setModel(event.target.value as ModelId)}>{modelIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <div className="model-facts"><span>{t.status}</span><strong>{t[activeModel?.status ?? "unconfigured"]}</strong><span>{t.mode}</span><strong>{activeModel ? t[activeModel.mode] : t.unknown}</strong><span>{t.actualModel}</span><strong>{actualModel ?? activeModel?.actualModel ?? t.unknown}</strong></div>
        <label className="model-label">{t.transport}<select value={transport} onChange={event => { transportChosen.current = true; setTransport(event.target.value as "webrtc" | "websocket"); }}><option value="websocket">{t.transportFallback}</option><option value="webrtc" disabled={model !== "gpt-realtime-2.1" || capabilities?.voiceTransports?.webrtc.status !== "ready"}>WebRTC · {model === "gpt-realtime-2.1" && capabilities?.voiceTransports?.webrtc.status === "ready" ? t.preview : t["pending-verification"]}</option></select></label>
        <p className="small muted transport-note">{transport === "websocket" ? t.fallbackNote : t.webrtcPending}</p>
        {activeModel?.status === "pending-verification" && <p className="small muted">{t.voicePending}</p>}
        {activeModel?.reason && <p className="small muted">{activeModel.reason}</p>}
        {!capabilities && <button onClick={refreshCapabilities}>{t.retry}</button>}
        <div className="conversation"><h3>{t.transcript}<span>{transcripts.length.toString().padStart(2, "0")}</span></h3><div className="transcript-list" aria-live="polite" aria-relevant="additions text">{transcripts.length ? transcripts.map(item => <article key={item.id} className={`transcript ${item.role}`}><span>{t[item.role]}</span><p>{item.text}</p></article>) : <p className="muted small">{t.emptyTranscript}</p>}</div></div>
        <div className="examples"><span className="eyebrow">{t.example}</span>{t.examples.map(example => <p key={example}>“{example}”</p>)}</div><p className="wake-note">{t.wakeNote}</p>
      </aside>
    </div>
    {confirmations[0] && <ConfirmationDialog key={confirmations[0].id} action={confirmations[0].action} t={t} busy={busy} onAnswer={answer => void confirmAction(confirmations[0]!, answer)} />}
  </div>;
}
