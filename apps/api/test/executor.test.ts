import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ActionRequest } from "@car/contracts";
import { Executor } from "../src/executor.js";
import { Adapters } from "../src/adapters.js";
import { Budget } from "../src/budget.js";
import { MemoryStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";

function setup(clock?: () => number) { return new Executor(randomUUID(), new Adapters(loadConfig({}), new Budget(new MemoryStore())), clock); }
const call = (name: ActionRequest["name"], args: Record<string, unknown> = {}): ActionRequest => ({ callId: randomUUID(), name, args });
describe("deterministic mock executor", () => {
  it("changes simulated vehicle state and validates all ranges/unknown properties", async () => {
    const executor = setup();
    const request = call("vehicle.set", { temperature: 24, seatHeat: true });
    const result = await executor.execute(request);
    expect(result.provider).toBe("mock"); expect(result.state?.vehicle.temperature).toBe(24);
    expect(await executor.execute(request)).toEqual(result);
    await expect(executor.execute({ ...request, args: { temperature: 25 } })).rejects.toMatchObject({ code: "call-conflict" });
    await expect(executor.execute(call("vehicle.set", { temperature: 99 }))).rejects.toThrow();
    await expect(executor.execute(call("vehicle.set", { brake: true }))).rejects.toThrow();
  });
  it("binds confirmations to snapshot, expires, rejects and executes exactly once", async () => {
    let time = 1000;
    const executor = setup(() => time);
    const request = call("work.sendMail", { to: "alex@example.test", subject: "Mock", body: "Fictional mail" });
    const preview = await executor.execute(request);
    expect(preview.status).toBe("confirmation-required"); expect(executor.state.mail).toHaveLength(1);
    expect(preview.data).toMatchObject({ action: request });
    await expect(executor.execute({ ...request, args: { ...request.args, subject: "changed" }, confirmationId: preview.confirmationId, confirm: true })).rejects.toMatchObject({ code: "call-conflict" });
    await expect(executor.execute({ ...request, confirmationId: randomUUID(), confirm: true })).rejects.toMatchObject({ code: "invalid-confirmation" });
    time += 60001;
    await expect(executor.execute({ ...request, confirmationId: preview.confirmationId, confirm: true })).rejects.toMatchObject({ code: "invalid-confirmation" });
    const renewed = await executor.execute(request);
    const accepted = { ...request, confirmationId: renewed.confirmationId, confirm: true };
    const results = await Promise.all([executor.execute(accepted), executor.execute(accepted)]);
    expect(results[0]).toEqual(results[1]); expect(executor.state.mail).toHaveLength(2);
    expect(results[0]?.data).toMatchObject({ delivery: "mock-sent-folder-only" });
    const reject = call("vehicle.set", { locked: false });
    const pending = await executor.execute(reject);
    expect((await executor.execute({ ...reject, confirmationId: pending.confirmationId, confirm: false })).status).toBe("cancelled");
    expect(executor.state.vehicle.locked).toBe(true);
  });
  it("uses fictional contacts and enforces simulated Bluetooth and call state", async () => {
    const executor = setup();
    const request = call("phone.call", { contact: "Alex Chen" });
    let result = await executor.execute(request);
    result = await executor.execute({ ...request, confirmationId: result.confirmationId, confirm: true });
    expect(result.status).toBe("unavailable");
    await executor.execute(call("phone.connect", { connected: true }));
    const second = call("phone.call", { contact: "Mei Tanaka" });
    result = await executor.execute(second);
    result = await executor.execute({ ...second, confirmationId: result.confirmationId, confirm: true });
    expect(result.state?.phone.activeContact).toBe("Mei Tanaka");
    expect((await executor.execute(call("phone.hangup"))).state?.phone.activeContact).toBeNull();
    await expect(executor.execute(call("phone.call", { contact: "Real Person" }))).rejects.toThrow();
  });
  it("creates, queries, modifies and summarizes fictional meetings with conflict validation", async () => {
    const executor = setup();
    const create = call("work.createMeeting", { title: "Mock sync", startsAt: "2026-10-02T09:00:00+08:00", durationMinutes: 30, attendees: ["alex@example.test"], location: "Fictional office", notes: "Alex prepares the mock demo." });
    const pending = await executor.execute(create);
    const created = await executor.execute({ ...create, confirmationId: pending.confirmationId, confirm: true });
    expect(created.status).toBe("completed");
    const id = (created.data as any).meeting.id;
    const update = call("work.updateMeeting", { id, title: "Updated mock sync" });
    const confirmation = await executor.execute(update);
    expect((await executor.execute({ ...update, confirmationId: confirmation.confirmationId, confirm: true })).status).toBe("completed");
    expect((await executor.execute(call("work.query", { kind: "meetings" }))).data).toMatchObject({ meetings: expect.arrayContaining([expect.objectContaining({ id, title: "Updated mock sync" })]) });
    expect((await executor.execute(call("work.summarize", { id }))).data).toMatchObject({ summary: "Alex prepares the mock demo." });
    const conflict = call("work.createMeeting", create.args);
    const conflicted = await executor.execute(conflict);
    expect((await executor.execute({ ...conflict, confirmationId: conflicted.confirmationId, confirm: true })).data).toMatchObject({ code: "meeting-conflict" });
  });
  it("never claims frontend media playback; blocks unverified providers and driving video", async () => {
    const executor = setup();
    expect((await executor.execute(call("media.control", { platform: "youtube", command: "open", url: "https://youtu.be/dQw4w9WgXcQ" }))).data).toMatchObject({ playbackConfirmed: false, execution: "requested" });
    for (const command of ["open", "play", "pause", "stop", "volume"]) {
      const spotify = await executor.execute(call("media.control", { platform: "spotify", command }));
      expect(spotify.status).toBe("unavailable");
      expect(spotify.data).toMatchObject({ code: "spotify-policy" });
    }
    expect((await executor.execute(call("media.control", { platform: "bilibili", command: "pause" }))).status).toBe("unavailable");
    await executor.execute(call("vehicle.set", { driving: true }));
    expect((await executor.execute(call("media.control", { platform: "youtube", command: "play" }))).data).toMatchObject({ code: "driving-lock" });
    expect((await executor.execute(call("video.search", { query: "cars", platform: "youtube" }))).status).toBe("unavailable");
    expect((await executor.execute(call("video.search", { query: "cars", platform: "all" }))).status).toBe("unavailable");
    expect((await executor.execute(call("navigation.search", { query: "coffee" }))).status).toBe("unavailable");
  });
  it("measures mock execution independently of user confirmation wait", async () => {
    const executor = setup();
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) samples.push((await executor.execute(call("work.query", { kind: "meetings" }))).durationMs);
    samples.sort((a, b) => a - b);
    expect(samples[94]).toBeLessThan(50);
    expect(samples.every(value => value >= 0)).toBe(true);
  });
  it("accepts frontend route coordinates and binds confirmation to normalized coordinates", async () => {
    const executor = setup();
    const request = call("navigation.route", { start: { lat: 47.6, lon: -122.3 }, end: { lat: 47.7, lon: -122.4 } });
    const pending = await executor.execute(request);
    expect(pending.status).toBe("confirmation-required");
    const result = await executor.execute({ ...request, args: { origin: { latitude: 47.6, longitude: -122.3 }, destination: { latitude: 47.7, longitude: -122.4 } }, confirmationId: pending.confirmationId, confirm: true });
    expect(result.status).toBe("unavailable");
    expect(result.data).toMatchObject({ code: "unconfigured" });
  });
});
