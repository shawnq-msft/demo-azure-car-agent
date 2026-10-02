import { useEffect, useState } from "react";
import type { ActionResult, Capability, VideoResult } from "@car/contracts";
import type { Messages } from "../i18n";
import { readVideos } from "../utils";
import { VideoPlayer } from "../player";
import type { MediaControl } from "../mediaControl";
import type { RunAction } from "./Vehicle";
import { Icon } from "./Icon";

export function Media({ t, capability, run, busy, blocked, selected, setSelected, result, control, focused, pending, failed, voiceActive }: { t: Messages; capability?: Capability; run: RunAction; busy: boolean; blocked: boolean; selected: VideoResult | null; setSelected: (video: VideoResult | null) => void; result: ActionResult | null; control: MediaControl; focused: boolean; pending: boolean; failed: boolean; voiceActive: boolean }) {
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState("all");
  const [results, setResults] = useState<VideoResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [directUrl, setDirectUrl] = useState("");
  const [directPlatform, setDirectPlatform] = useState("youtube");
  useEffect(() => {
    if (result?.provider === "web-iq" && result.status === "completed") { setResults(readVideos(result.data)); setSearched(true); }
  }, [result]);
  return <div className="panel-stack">
    <section className="card spotify-card"><div className="spotify-art" aria-hidden="true"><Icon name="media" size={64} /><span>SPOTIFY</span></div><div className="grow"><div className="eyebrow">SPOTIFY</div><h2>{t.spotifyTitle}</h2><p className="muted">{t.spotifyNote}</p><a className="button primary" href="https://open.spotify.com/" target="_blank" rel="noopener noreferrer" onClick={() => setSelected(null)}>{t.openSpotify}<Icon name="arrow" size={18} /></a><p className="muted" data-testid="spotify-policy">{t.spotifyPolicy}</p><a className="text-link" href="https://developer.spotify.com/policy" target="_blank" rel="noopener noreferrer">Spotify Developer Policy · III.3 / III.5 / III.7 ↗</a></div></section>
    <section className="card"><div className="section-heading"><div><div className="eyebrow">WEB IQ · YOUTUBE / BILIBILI</div><h2>{t.videos}</h2></div><span className={`badge ${capability?.status === "ready" ? "ready" : ""}`}>{t[capability?.status ?? "unconfigured"]}</span></div><p className="muted">{t.videoNote}</p>
      <form className="search-row" onSubmit={event => { event.preventDefault(); if (query.trim().length >= 2) void run("video.search", { query: query.trim(), platform }).then(result => { if (result?.status === "completed") { setResults(readVideos(result.data)); setSearched(true); } }); }}><label className="grow">{t.query}<input value={query} onChange={event => setQuery(event.target.value)} required minLength={2} maxLength={200} /></label><label>{t.videos}<select value={platform} onChange={event => setPlatform(event.target.value)}><option value="all">{t.all}</option><option value="youtube">YouTube</option><option value="bilibili">Bilibili</option></select></label><button className="primary" disabled={busy || capability?.status !== "ready" || query.trim().length < 2}>{t.search}</button></form>
      <form className="search-row" onSubmit={event => {
        event.preventDefault();
        void run("media.control", { platform: directPlatform, command: "open", url: directUrl.trim() });
      }}>
        <label className="grow">{t.external} · URL<input type="url" required maxLength={2000} value={directUrl} onChange={event => setDirectUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></label>
        <label>{t.videos}<select value={directPlatform} onChange={event => setDirectPlatform(event.target.value)}><option value="youtube">YouTube</option><option value="bilibili">Bilibili</option></select></label>
        <button disabled={busy || blocked || (voiceActive && directPlatform === "bilibili") || !directUrl.trim()}>{t.open}</button>
      </form>
      {(blocked || (voiceActive && directPlatform === "bilibili")) && <p className="notice">{t.videoBlocked}</p>}
      {failed && !selected && <p className="notice" role="status">{t.unavailableError}</p>}
      {selected && !blocked && <VideoPlayer video={selected} t={t} onStop={() => setSelected(null)} control={control} focused={focused} pending={pending} failed={failed} />}
      <div className="video-results">{results.map(video => <article key={video.platform + video.videoId} className="video-result"><div className="video-result-symbol"><Icon name="media" size={30} /><span>{video.platform === "youtube" ? "YouTube" : "Bilibili"}</span></div><div className="grow"><h3>{video.title}</h3><div className="button-row"><button disabled={blocked || (voiceActive && video.platform === "bilibili")} onClick={() => setSelected(video)}>{t.play}</button><a className="text-link" href={video.url} target="_blank" rel="noopener noreferrer" onClick={() => setSelected(null)}>{t.external} ↗</a></div></div></article>)}</div>
      {searched && results.length === 0 && <p className="muted">{t.noResults}</p>}
    </section>
  </div>;
}
