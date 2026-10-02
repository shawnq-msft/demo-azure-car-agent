import type { ClientEvent } from "@car/contracts";
import { PlaybackTiming } from "./playbackTiming";
import workletUrl from "./pcm-worklet.js?url&no-inline";

export class PcmAudio {
  onPlaybackDrained: () => void = () => {};
  onPlaybackStarted: (time: number) => void = () => {};
  private timing = new PlaybackTiming(time => this.onPlaybackStarted(time));
  observeNextPlayback(): void { this.timing.arm(); }
  get playbackPending(): boolean { return this.playback.size > 0; }
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private silent: GainNode | null = null;
  private generation = 0;
  private accepting = false;
  private captureEnabled = true;
  private playback = new Set<AudioBufferSourceNode>();
  private nextStart = 0;
  private itemId: string | null = null;
  private playedStart = 0;
  private playedOffset = 0;

  async prepare(send: (event: ClientEvent) => void, onFailure: () => void): Promise<void> {
    this.stop();
    const generation = this.generation;
    const context = new AudioContext();
    this.context = context;
    await context.resume();
    if (generation !== this.generation) throw new Error("cancelled");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error("cancelled"); }
    this.stream = stream;
    await context.audioWorklet.addModule(workletUrl);
    if (generation !== this.generation) return;
    const capture = new AudioWorkletNode(context, "pcm-capture");
    this.capture = capture;
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!this.accepting || !this.captureEnabled || generation !== this.generation) return;
      try {
        const bytes = new Uint8Array(event.data);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        send({ type: "voice.signal", event: { type: "input_audio_buffer.append", audio: btoa(binary) } });
      } catch { onFailure(); }
    };
    capture.onprocessorerror = onFailure;
    const source = context.createMediaStreamSource(stream);
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture); capture.connect(silent); silent.connect(context.destination);
    this.source = source; this.silent = silent;
  }
  start(): void { this.accepting = true; }
  setCaptureEnabled(enabled: boolean): void { this.captureEnabled = enabled; }
  append(event: Record<string, unknown>): void {
    if (!this.context || !this.accepting || typeof event.delta !== "string") return;
    const binary = atob(event.delta);
    if (binary.length % 2 !== 0 || binary.length > 2 * 1024 * 1024) throw new Error("Invalid PCM");
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const context = this.context;
    if (this.nextStart > context.currentTime + 30) throw new Error("Playback queue overflow");
    const buffer = context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer; source.connect(context.destination);
    const at = Math.max(context.currentTime + 0.02, this.nextStart);
    const itemId = typeof event.item_id === "string" ? event.item_id : null;
    if (itemId !== this.itemId) { this.itemId = itemId; this.playedStart = at; this.playedOffset = 0; }
    this.nextStart = at + buffer.duration;
    this.playedOffset += buffer.duration;
    this.playback.add(source);
    source.onended = () => { this.playback.delete(source); source.disconnect(); if (!this.playback.size) this.onPlaybackDrained(); };
    source.start(at);
    this.timing.scheduled(context, at);
  }
  interrupt(send: (event: ClientEvent) => void): void {
    if (this.context && this.itemId && this.playback.size) {
      const heard = Math.max(0, Math.min(this.context.currentTime - this.playedStart, this.playedOffset));
      send({ type: "voice.signal", event: { type: "conversation.item.truncate", item_id: this.itemId, content_index: 0, audio_end_ms: Math.floor(heard * 1000) } });
    }
    this.clearPlayback();
  }
  private clearPlayback(): void {
    this.timing.cancel();
    for (const source of this.playback) { try { source.stop(); } catch { /* An already-ended source needs no further action. */ } source.disconnect(); }
    this.playback.clear(); this.nextStart = 0; this.itemId = null; this.playedOffset = 0;
    this.onPlaybackDrained();
  }
  stop(): void {
    this.generation++; this.accepting = false; this.captureEnabled = true;
    this.clearPlayback();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.capture) { this.capture.port.onmessage = null; this.capture.onprocessorerror = null; this.capture.port.close(); this.capture.disconnect(); this.capture = null; }
    this.source?.disconnect(); this.source = null; this.silent?.disconnect(); this.silent = null;
    const context = this.context; this.context = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }
}
