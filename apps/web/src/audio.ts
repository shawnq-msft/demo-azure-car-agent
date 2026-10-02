import type { ClientEvent } from "@car/contracts";

export class VoiceAudio {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  async prepare(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error("cancelled"); }
    this.stream = stream;
    this.audio = new Audio();
    this.audio.autoplay = true;
  }

  async offer(send: (event: ClientEvent) => void, onFailure: () => void, onConnected: () => void = () => {}): Promise<void> {
    if (!this.stream) throw new Error("No microphone");
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.timer = setTimeout(onFailure, 20000);
    peer.ontrack = event => {
      if (!this.audio || this.peer !== peer) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio.play().catch(onFailure);
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (peer.connectionState === "connected") { clearTimeout(this.timer); onConnected(); }
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) onFailure();
    };
    this.stream.getTracks().forEach(track => peer.addTrack(track, this.stream!));
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== "complete") {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { peer.removeEventListener("icegatheringstatechange", change); reject(new Error("ICE timeout")); }, 10000);
        const change = () => {
          if (peer.iceGatheringState === "complete") {
            clearTimeout(timeout); peer.removeEventListener("icegatheringstatechange", change); resolve();
          }
        };
        peer.addEventListener("icegatheringstatechange", change);
      });
    }
    if (this.peer !== peer || !peer.localDescription?.sdp) return;
    send({ type: "voice.signal", event: { type: "rtc.call.sdp.create", sdp_offer: peer.localDescription.sdp } });
  }

  async answer(event: Record<string, unknown>): Promise<void> {
    if (event.type !== "rtc.call.sdp.created" || !this.peer) return;
    const sdp = typeof event.sdp_answer === "string" ? event.sdp_answer : null;
    if (!sdp) throw new Error("Invalid SDP answer");
    await this.peer.setRemoteDescription({ type: "answer", sdp });
  }

  setCaptureEnabled(enabled: boolean): void {
    this.stream?.getTracks().forEach(track => { track.enabled = enabled; });
  }

  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.ontrack = null; this.peer.close(); this.peer = null; }
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; this.audio = null; }
  }
}
