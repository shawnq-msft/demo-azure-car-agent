import { useEffect, useRef, useState } from "react";
import type { VideoResult } from "@car/contracts";
import type { Messages } from "./i18n";
import type { ControlledPlayer, MediaControl } from "./mediaControl";

interface YouTubePlayer extends ControlledPlayer {
  stopVideo(): void; destroy(): void;
}
interface YouTubeApi {
  Player: new (element: HTMLElement, options: { videoId: string; playerVars: Record<string, string | number>; events: { onReady: () => void; onStateChange: (event: { data: number }) => void; onError: () => void } }) => YouTubePlayer;
}
declare global { interface Window { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void } }
let youtubePromise: Promise<YouTubeApi> | null = null;
function youtube(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!youtubePromise) youtubePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = setTimeout(() => { youtubePromise = null; script.remove(); reject(new Error("YouTube timeout")); }, 15000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timeout); if (window.YT) resolve(window.YT); };
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { clearTimeout(timeout); youtubePromise = null; script.remove(); reject(new Error("YouTube unavailable")); };
    document.head.appendChild(script);
  });
  return youtubePromise;
}
export function VideoPlayer({ video, onStop, t, control, focused, pending, failed }: { video: VideoResult; onStop: () => void; t: Messages; control: MediaControl; focused: boolean; pending: boolean; failed: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const generation = useRef(0);
  const [status, setStatus] = useState<"loading" | "playing" | "paused" | "stopped" | "embedded" | "playerError">("loading");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const epoch = ++generation.current;
    const detached = () => queueMicrotask(() => { if (generation.current === epoch) control.detached(video); });
    control.loading(video);
    setReady(false);
    setStatus(video.platform === "bilibili" ? "embedded" : "loading");
    if (video.platform !== "youtube") return detached;
    let cancelled = false;
    let instance: YouTubePlayer | null = null;
    const slot = document.createElement("div");
    mount.current?.appendChild(slot);
    void youtube().then(YT => {
      if (cancelled) return;
      instance = new YT.Player(slot, {
        videoId: video.videoId,
        playerVars: { autoplay: 0, playsinline: 1, origin: location.origin, rel: 0 },
        events: {
          onReady: () => { if (!cancelled && instance) { setReady(true); setStatus("stopped"); control.attached(video, instance); } },
          onStateChange: event => { if (!cancelled) { setStatus(event.data === 1 ? "playing" : event.data === 2 ? "paused" : event.data === 3 ? "loading" : "stopped"); control.stateChanged(); } },
          onError: () => { if (!cancelled) { setStatus("playerError"); control.playerError(); } }
        }
      });
      player.current = instance;
    }).catch(() => { if (!cancelled) { setStatus("playerError"); control.playerError(); } });
    return () => { cancelled = true; instance?.destroy(); player.current = null; slot.remove(); detached(); };
  }, [video, control]);
  return <section className="video-player" aria-label={video.title}>
    {video.platform === "youtube" ? <div className="video-frame" ref={mount} /> :
      <iframe className="video-frame" src={`https://player.bilibili.com/player.html?bvid=${video.videoId}&autoplay=0`} title={video.title} allow="fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" onLoad={() => control.attached(video, null)} onError={() => control.playerError()} />}
    <div className="player-bar"><span aria-live="polite">{t[status]}</span><div className="button-row">
      {video.platform === "youtube" && <><button disabled={!ready || focused} onClick={() => control.userPlay()}>{t.play}</button><button disabled={!ready} onClick={() => control.userPause()}>{t.pause}</button></>}
      <button onClick={onStop}>{t.stop}</button>
    </div></div>
    {(pending || failed || focused) && <p className="notice" role="status">{pending ? t.loading : focused ? t.paused : t.unavailableError} · {t.play}</p>}
    {video.platform === "bilibili" && <p className="muted small">{t.bilibiliNote}</p>}
  </section>;
}
