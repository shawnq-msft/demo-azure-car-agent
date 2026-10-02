import type { MediaRequest, MediaResultEvent, VideoResult } from "@car/contracts";
import { safeVideo } from "./utils";

export interface ControlledPlayer {
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  setVolume(volume: number): void;
  getVolume(): number;
}
type Outcome = MediaResultEvent["outcome"];
type Detail = MediaResultEvent["detail"];
type Pending = { request: MediaRequest; timer: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval> };

// One controller survives player remounts and duplicate REST/WebSocket deliveries.
export class MediaControl {
  private seen = new Set<string>();
  private pending?: Pending;
  private selected: VideoResult | null = null;
  private player: ControlledPlayer | null = null;
  private ready = false;
  private focus = false;
  private driving = false;
  private voiceActive = false;
  private resumeRequested = false;
  private failed = false;
  constructor(
    private select: (video: VideoResult | null) => void,
    private report: (event: MediaResultEvent) => void,
    private notify: (pending: boolean, failed: boolean) => void,
    private timeoutMs = 12000
  ) {}
  submit(request: MediaRequest): void {
    if (this.seen.has(request.callId)) return;
    // Fail closed at the session bound instead of evicting IDs and replaying controls.
    if (this.seen.size >= 1000) { this.report({ type: "media.result", callId: request.callId, platform: request.platform, command: request.command, outcome: "unavailable", detail: "superseded" }); return; }
    this.seen.add(request.callId);
    this.finish("unavailable", "superseded");
    this.failed = false;
    const timer = setTimeout(() => this.finish(request.command === "play" ? "blocked" : "unavailable", request.command === "play" ? (this.focus ? "audio-focus" : "gesture-required") : "timeout"), this.timeoutMs);
    this.pending = { request, timer };
    this.notify(true, false);
    if (document.hidden) { this.finish("blocked", "hidden"); return; }
    if (this.driving && request.command !== "stop") { this.finish("blocked", "driving"); return; }
    if (this.voiceActive && request.platform === "bilibili" && request.command === "open") { this.finish("blocked", "audio-focus"); return; }
    if (request.command === "open") {
      const video = safeVideo({ ...request, title: request.platform === "youtube" ? "YouTube" : "Bilibili" });
      if (!video) { this.finish("unavailable", "unsupported"); return; }
      this.resumeRequested = false;
      if (this.selected?.platform === video.platform && this.selected.videoId === video.videoId && this.ready) {
        this.finish("opened", "player-ready"); return;
      }
      this.player?.pauseVideo();
      this.player = null; this.ready = false; this.selected = video;
      this.select(video);
      return;
    }
    if (!this.selected) { this.finish("unavailable", "no-selection"); return; }
    if (this.selected.platform !== request.platform || (request.videoId && request.videoId !== this.selected.videoId)) { this.finish("unavailable", "platform-mismatch"); return; }
    if (request.command === "stop") {
      this.resumeRequested = false;
      this.player?.pauseVideo();
      this.select(null); // Acknowledge only after the mounted iframe has been removed.
      return;
    }
    if (request.platform === "bilibili") { this.finish("unavailable", "unsupported"); return; }
    if (request.command === "play") this.resumeRequested = true;
    if (request.command === "pause") this.resumeRequested = false;
    this.execute();
  }
  choose(video: VideoResult | null): void {
    this.finish("unavailable", "superseded");
    this.resumeRequested = false;
    this.player?.pauseVideo();
    if (video && (this.driving || document.hidden || (this.voiceActive && video.platform === "bilibili"))) video = null;
    if (video?.platform === this.selected?.platform && video?.videoId === this.selected?.videoId && this.ready) { this.selected = video; this.select(video); return; }
    this.selected = video; this.ready = false; this.player = null;
    this.select(video);
  }
  attached(video: VideoResult, player: ControlledPlayer | null): void {
    if (this.selected?.videoId !== video.videoId || this.selected.platform !== video.platform) return;
    this.player = player; this.ready = true;
    if (this.pending?.request.command === "open") this.finish("opened", "player-ready");
    else this.execute();
    if (this.focus) this.player?.pauseVideo();
  }
  loading(video: VideoResult): void {
    if (this.selected?.videoId === video.videoId && this.selected.platform === video.platform) { this.player = null; this.ready = false; }
  }
  detached(video: VideoResult): void {
    if (this.selected?.videoId !== video.videoId || this.selected.platform !== video.platform) return;
    this.player = null; this.ready = false;
    if (this.pending?.request.command === "stop") { this.finish("stopped", "unmounted"); this.selected = null; }
    else this.finish("unavailable", "unmounted");
    this.resumeRequested = false;
  }
  playerError(): void { this.ready = false; this.resumeRequested = false; this.finish("unavailable", "player-error"); }
  stateChanged(): void {
    const state = this.player?.getPlayerState();
    if (this.focus && state === 1) { this.player?.pauseVideo(); return; }
    if (!this.focus && state === 2 && this.pending?.request.command !== "play") this.resumeRequested = false;
    if (!this.focus && state === 1) this.resumeRequested = true;
    this.observe();
  }
  setFocus(active: boolean): void {
    if (this.focus === active) return;
    this.focus = active;
    if (active) {
      if (this.selected?.platform === "bilibili") this.choose(null);
      this.player?.pauseVideo();
    } else {
      if (this.pending) this.execute();
      else if (this.resumeRequested && !this.driving) this.player?.playVideo();
    }
  }
  setDriving(active: boolean): void { this.driving = active; if (active) this.choose(null); }
  setVoiceActive(active: boolean): void {
    this.voiceActive = active;
    if (active && this.selected?.platform === "bilibili") this.choose(null);
  }
  userPlay(): void {
    if (this.focus || this.driving || document.hidden) return;
    this.resumeRequested = true;
    this.failed = false; this.notify(!!this.pending, false);
    this.player?.playVideo();
    this.observe();
  }
  userPause(): void {
    this.resumeRequested = false;
    if (this.pending?.request.command === "play") this.finish("unavailable", "superseded");
    this.player?.pauseVideo(); this.observe();
  }
  private execute(): void {
    if (!this.ready || !this.player || !this.pending) return;
    const { request } = this.pending;
    try {
      if (request.command === "play") {
        if (this.focus) return;
        this.player.playVideo();
      } else if (request.command === "pause") this.player.pauseVideo();
      else if (request.command === "volume") {
        if (typeof request.volume !== "number" || !Number.isFinite(request.volume) || request.volume < 0 || request.volume > 100) { this.finish("unavailable", "unsupported"); return; }
        this.player.setVolume(request.volume);
      }
      this.observe();
      if (this.pending && !this.pending.poll) this.pending.poll = setInterval(() => this.observe(), 100);
    } catch { this.finish("unavailable", "player-error"); }
  }
  private observe(): void {
    if (!this.pending || !this.player || !this.ready) return;
    try {
      const request = this.pending.request;
      if (request.command === "play" && !this.focus && this.player.getPlayerState() === 1) this.finish("playing", "player-state");
      else if (request.command === "pause" && this.player.getPlayerState() === 2) this.finish("paused", "player-state");
      else if (request.command === "volume" && Math.abs(this.player.getVolume() - request.volume!) < 1) this.finish("volume-changed", "player-volume");
    } catch { this.finish("unavailable", "player-error"); }
  }
  private finish(outcome: Outcome, detail: Detail): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer); clearInterval(pending.poll);
    if (outcome === "blocked" || outcome === "unavailable") {
      this.failed = true;
      if (pending.request.command === "play") this.resumeRequested = false;
    }
    this.notify(false, this.failed);
    const { callId, platform, command } = pending.request;
    this.report({ type: "media.result", callId, platform, command, outcome, detail });
  }
}
