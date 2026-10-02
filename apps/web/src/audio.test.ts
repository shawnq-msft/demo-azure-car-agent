import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceAudio } from "./audio";
import { PcmAudio } from "./pcmAudio";

afterEach(() => vi.unstubAllGlobals());

describe("AudioWorklet PCM capture", () => {
  for (const sampleRate of [44100, 48000]) {
    it(`resamples ${sampleRate}Hz audio to little-endian-compatible 24kHz PCM16 chunks`, () => {
      const chunks: ArrayBuffer[] = [];
      let Processor: new () => { process(inputs: Float32Array[][]): boolean };
      class BaseProcessor { port = { postMessage: (buffer: ArrayBuffer) => chunks.push(buffer) }; }
      runInNewContext(readFileSync(new URL("./pcm-worklet.js", import.meta.url), "utf8"), {
        sampleRate, AudioWorkletProcessor: BaseProcessor,
        registerProcessor: (_: string, value: typeof Processor) => { Processor = value; }
      });
      const processor = new Processor!();
      for (let start = 0; start < sampleRate; start += 128) {
        processor.process([[new Float32Array(Math.min(128, sampleRate - start)).fill(0.5)]]);
      }
      expect(chunks).toHaveLength(10);
      expect(chunks.every(buffer => buffer.byteLength === 4800)).toBe(true);
      expect([...new Int16Array(chunks[0]!)]).toEqual(Array(2400).fill(16384));
    });
  }
  it("clamps high amplitude samples instead of overflowing PCM", () => {
    const chunks: ArrayBuffer[] = [];
    let Processor: new () => { process(inputs: Float32Array[][]): boolean };
    runInNewContext(readFileSync(new URL("./pcm-worklet.js", import.meta.url), "utf8"), {
      sampleRate: 24000, AudioWorkletProcessor: class { port = { postMessage: (buffer: ArrayBuffer) => chunks.push(buffer) }; },
      registerProcessor: (_: string, value: typeof Processor) => { Processor = value; }
    });
    new Processor!().process([[new Float32Array(2400).fill(-2)]]);
    expect(new Int16Array(chunks[0]!)[0]).toBe(-32768);
  });
});

describe("microphone lifecycle", () => {
  it("uses the documented WebRTC SDP fields and releases tracks", async () => {
    const stop = vi.fn(), remote = vi.fn(), send = vi.fn(), connected = vi.fn();
    const track = { stop, enabled: true };
    let peer: Peer | undefined;
    class Peer {
      constructor() { peer = this; }
      iceGatheringState = "complete";
      connectionState = "new";
      onconnectionstatechange: (() => void) | null = null;
      localDescription: RTCSessionDescriptionInit | null = null;
      addTrack = vi.fn();
      createOffer = async () => ({ type: "offer" as const, sdp: "browser-offer" });
      setLocalDescription = async (value: RTCSessionDescriptionInit) => { this.localDescription = value; };
      setRemoteDescription = remote;
      close = vi.fn();
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } });
    vi.stubGlobal("Audio", class { autoplay = false; srcObject = null; pause() {} });
    vi.stubGlobal("RTCPeerConnection", Peer);
    const audio = new VoiceAudio();
    await audio.prepare();
    await audio.offer(send, vi.fn(), connected);
    expect(send).toHaveBeenCalledWith({ type: "voice.signal", event: { type: "rtc.call.sdp.create", sdp_offer: "browser-offer" } });
    await audio.answer({ type: "rtc.call.sdp.created", sdp_answer: "service-answer" });
    expect(remote).toHaveBeenCalledWith({ type: "answer", sdp: "service-answer" });
    expect(connected).not.toHaveBeenCalled();
    peer!.connectionState = "connected";
    peer!.onconnectionstatechange!();
    expect(connected).toHaveBeenCalledOnce();
    audio.setCaptureEnabled(false);
    expect(track.enabled).toBe(false);
    audio.setCaptureEnabled(true);
    expect(track.enabled).toBe(true);
    audio.stop();
    expect(stop).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("stops tracks when permission resolves after cancellation", async () => {
    let resolve!: (stream: MediaStream) => void;
    const stop = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(done => { resolve = done; }) } });
    const audio = new VoiceAudio();
    const pending = audio.prepare();
    audio.stop();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expect(pending).rejects.toThrow("cancelled");
    expect(stop).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("explicit WebSocket PCM transport", () => {
  it("sends only after start, pauses for confirmation, plays PCM, and tears down", async () => {
    const trackStop = vi.fn(), contextClose = vi.fn(async () => {}), send = vi.fn();
    const play = vi.fn(), stop = vi.fn(), copy = vi.fn();
    let capture: Worklet | undefined;
    let context: Context | undefined;
    class Worklet {
      constructor() { capture = this; }
      port = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null, close: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
    }
    class Context {
      constructor() { context = this; }
      currentTime = 1;
      state = "running";
      destination = {};
      resume = vi.fn(async () => {});
      close = contextClose;
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
      createBuffer = (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: copy });
      createBufferSource = () => ({ connect: vi.fn(), disconnect: vi.fn(), start: play, stop });
    }
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop }] }) } });
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("AudioWorkletNode", Worklet);
    const pcm = new PcmAudio();
    await pcm.prepare(send, vi.fn());
    const frame = new Int16Array([16384, -16384]).buffer;
    capture!.port.onmessage!({ data: frame });
    expect(send).not.toHaveBeenCalled();
    pcm.start();
    capture!.port.onmessage!({ data: frame });
    expect(send).toHaveBeenCalledWith({ type: "voice.signal", event: { type: "input_audio_buffer.append", audio: "AEAAwA==" } });
    pcm.setCaptureEnabled(false);
    capture!.port.onmessage!({ data: frame });
    expect(send).toHaveBeenCalledTimes(1);
    pcm.append({ type: "response.audio.delta", item_id: "item-1", delta: "AEAAwA==" });
    expect([...copy.mock.calls[0]![0]]).toEqual([0.5, -0.5]);
    expect(play).toHaveBeenCalledWith(1.02);
    context!.currentTime = 1.03;
    pcm.interrupt(send);
    expect(send).toHaveBeenLastCalledWith({ type: "voice.signal", event: { type: "conversation.item.truncate", item_id: "item-1", content_index: 0, audio_end_ms: 0 } });
    expect(stop).toHaveBeenCalledOnce();
    pcm.stop();
    expect(trackStop).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    expect(capture!.port.onmessage).toBeNull();
  });
});
