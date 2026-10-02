import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRequest, MediaResultEvent, VideoResult } from "@car/contracts";
import { MediaControl, type ControlledPlayer } from "./mediaControl";

const video: VideoResult = { platform: "youtube", videoId: "dQw4w9WgXcQ", title: "Video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
const bili: VideoResult = { platform: "bilibili", videoId: "BV1xx411c7mD", title: "Video", url: "https://www.bilibili.com/video/BV1xx411c7mD" };
function setup() {
  const reports: MediaResultEvent[] = [];
  const select = vi.fn(), notify = vi.fn();
  const control = new MediaControl(select, event => reports.push(event), notify, 1000);
  let state = -1, volume = 50;
  const player: ControlledPlayer = {
    playVideo: vi.fn(), pauseVideo: vi.fn(),
    getPlayerState: () => state, setVolume: vi.fn(), getVolume: () => volume
  };
  const submit = (command: MediaRequest["command"], extra: Partial<MediaRequest> = {}) => {
    const request: MediaRequest = { callId: randomUUID(), platform: "youtube", command, ...extra };
    control.submit(request); return request;
  };
  const open = () => { submit("open", video); control.attached(video, player); reports.length = 0; };
  return { control, player, reports, select, notify, submit, open,
    state: (value: number) => { state = value; control.stateChanged(); },
    volume: (value: number) => { volume = value; }
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("document", { hidden: false }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("correlated browser media control", () => {
  it("opens only after readiness; opened is never playing; duplicate REST/WS requests do not reload", () => {
    const { control, submit, reports, select, player } = setup();
    const request = submit("open", video);
    expect(reports).toEqual([]);
    control.submit(request);
    expect(select).toHaveBeenCalledTimes(1);
    control.attached(video, player);
    expect(reports).toEqual([{ type: "media.result", callId: request.callId, command: "open", platform: "youtube", outcome: "opened", detail: "player-ready" }]);
    expect(player.playVideo).not.toHaveBeenCalled();
    control.submit(request);
    expect(reports).toHaveLength(1);
  });
  it("waits for actual YouTube play/pause states and observed volume rather than imperative calls", () => {
    const h = setup(); h.open();
    const play = h.submit("play"); h.control.submit(play);
    expect(h.player.playVideo).toHaveBeenCalledTimes(1); expect(h.reports).toEqual([]);
    h.state(3); expect(h.reports).toEqual([]);
    h.state(1); expect(h.reports.at(-1)?.outcome).toBe("playing");
    h.submit("pause"); expect(h.reports).toHaveLength(1);
    h.state(2); expect(h.reports.at(-1)?.outcome).toBe("paused");
    h.submit("volume", { volume: 23 });
    expect(h.player.setVolume).toHaveBeenCalledWith(23);
    expect(h.reports).toHaveLength(2);
    h.volume(23); vi.advanceTimersByTime(100);
    expect(h.reports.at(-1)?.outcome).toBe("volume-changed");
  });
  it("reports gesture-required and leaves a usable explicit play button after timeout", () => {
    const h = setup(); h.open(); h.submit("play");
    vi.advanceTimersByTime(1000);
    expect(h.reports.at(-1)).toMatchObject({ outcome: "blocked", detail: "gesture-required" });
    expect(h.notify).toHaveBeenLastCalledWith(false, true);
    h.control.userPlay(); h.state(1);
    expect(h.reports).toHaveLength(1); // late state cannot change the timed-out acknowledgement
    expect(h.player.playVideo).toHaveBeenCalledTimes(2);
  });
  it("does not claim loading timeout or player error is success", () => {
    const h = setup(); h.submit("open", video); vi.advanceTimersByTime(1000);
    expect(h.reports.at(-1)).toMatchObject({ outcome: "unavailable", detail: "timeout" });
    h.submit("open", video); h.control.playerError();
    expect(h.reports.at(-1)).toMatchObject({ outcome: "unavailable", detail: "player-error" });
  });
  it("confirms stop only after iframe removal and rejects absent or mismatched selections", () => {
    const h = setup(); h.submit("pause");
    expect(h.reports.at(-1)?.detail).toBe("no-selection");
    h.open(); h.submit("stop", { platform: "bilibili" });
    expect(h.reports.at(-1)?.detail).toBe("platform-mismatch");
    h.reports.length = 0; h.submit("stop");
    expect(h.reports).toEqual([]); expect(h.select).toHaveBeenLastCalledWith(null);
    h.control.detached(video); expect(h.reports.at(-1)?.outcome).toBe("stopped");
    h.submit("play"); expect(h.reports.at(-1)?.detail).toBe("no-selection");
  });
  it("supports Bilibili load/unmount only and blocks it throughout voice", () => {
    const h = setup(); h.submit("open", bili); h.control.attached(bili, null);
    expect(h.reports.at(-1)?.outcome).toBe("opened");
    h.submit("play", { platform: "bilibili" });
    expect(h.reports.at(-1)?.detail).toBe("unsupported");
    h.submit("stop", { platform: "bilibili" }); h.control.detached(bili);
    expect(h.reports.at(-1)?.outcome).toBe("stopped");
    h.control.setVoiceActive(true); h.submit("open", bili);
    expect(h.reports.at(-1)).toMatchObject({ outcome: "blocked", detail: "audio-focus" });
  });
  it("defers explicit play during assistant speech, resumes only requested playback, honors explicit pause", () => {
    const h = setup(); h.open(); h.control.setFocus(true); h.submit("play");
    expect(h.player.playVideo).not.toHaveBeenCalled();
    h.control.setFocus(false); h.state(1);
    expect(h.reports.at(-1)?.outcome).toBe("playing");
    h.control.setFocus(true); h.state(2); h.control.setFocus(false);
    expect(h.player.playVideo).toHaveBeenCalledTimes(2);
    h.control.setFocus(true); h.submit("pause"); h.state(2); h.control.setFocus(false);
    expect(h.player.playVideo).toHaveBeenCalledTimes(2);
  });
  it("stops on driving and refuses hidden or driving playback", () => {
    const h = setup(); h.open(); h.control.setDriving(true);
    expect(h.select).toHaveBeenLastCalledWith(null);
    h.submit("play"); expect(h.reports.at(-1)?.detail).toBe("driving");
    h.control.setDriving(false); vi.stubGlobal("document", { hidden: true }); h.submit("open", video);
    expect(h.reports.at(-1)?.detail).toBe("hidden");
  });
  it("does not resume native YouTube user-paused playback after assistant speech", () => {
    const h = setup(); h.open(); h.control.userPlay(); h.state(1);
    h.state(2);
    h.control.setFocus(true); h.control.setFocus(false);
    expect(h.player.playVideo).toHaveBeenCalledTimes(1);
  });
  it("supersedes pending controls, validates video ids, and ignores stale callbacks", () => {
    const h = setup(); h.open(); h.submit("play"); h.submit("pause");
    expect(h.reports.at(-1)?.detail).toBe("superseded");
    h.state(1); expect(h.reports).toHaveLength(1);
    h.state(2); expect(h.reports.at(-1)?.outcome).toBe("paused");
    h.submit("open", { ...video, videoId: "<script>" });
    expect(h.reports.at(-1)?.detail).toBe("unsupported");
    h.submit("play", { videoId: "aaaaaaaaaaa" });
    expect(h.reports.at(-1)?.detail).toBe("platform-mismatch");
  });
});
