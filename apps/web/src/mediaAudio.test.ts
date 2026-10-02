import { afterEach, expect, it, vi } from "vitest";
import { PcmAudio } from "./pcmAudio";
import { MediaControl } from "./mediaControl";

afterEach(() => vi.unstubAllGlobals());

it("releases video focus only after response completion AND the real PCM source queue drains", async () => {
  const sources: Array<{ onended?: () => void; stop: () => void }> = [];
  class Context {
    currentTime = 1; state = "running"; destination = {};
    resume = async () => {}; close = async () => {};
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createGain = () => ({ gain: { value: 1 }, connect() {}, disconnect() {} });
    createBuffer = (_: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel() {} });
    createBufferSource = () => {
      const source = { connect() {}, disconnect() {}, start() {}, stop() {}, onended: undefined as (() => void) | undefined };
      sources.push(source); return source;
    };
  }
  vi.stubGlobal("document", { hidden: false });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", class { port = { onmessage: null, close() {} }; connect() {} disconnect() {} });
  const pcm = new PcmAudio();
  const media = new MediaControl(vi.fn(), vi.fn(), vi.fn());
  const video = { platform: "youtube" as const, videoId: "dQw4w9WgXcQ", title: "Video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
  const play = vi.fn(), pause = vi.fn();
  media.choose(video);
  media.attached(video, { playVideo: play, pauseVideo: pause, getPlayerState: () => 1, setVolume() {}, getVolume: () => 50 });
  media.userPlay(); play.mockClear();
  let responsePending = true;
  const release = () => { if (!responsePending && !pcm.playbackPending) media.setFocus(false); };
  pcm.onPlaybackDrained = release;
  await pcm.prepare(vi.fn(), vi.fn()); pcm.start();
  media.setFocus(true);
  pcm.append({ delta: "AEAAwA==" }); pcm.append({ delta: "AEAAwA==" });
  responsePending = false; release();
  expect(play).not.toHaveBeenCalled();
  sources[0]!.onended!();
  expect(pcm.playbackPending).toBe(true); expect(play).not.toHaveBeenCalled();
  sources[1]!.onended!();
  expect(pcm.playbackPending).toBe(false); expect(play).toHaveBeenCalledOnce();
  pcm.stop();
});
