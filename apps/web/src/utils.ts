import type { VideoResult } from "@car/contracts";
import { ApiError } from "./api";
import type { Messages } from "./i18n";

export function errorMessage(error: unknown, t: Messages): string {
  if (error instanceof ApiError) {
    if (error.code === "spotify-policy" || error.code === "spotify-policy-restricted") return t.spotifyPolicy;
    if (error.status === 401 || error.status === 403) return t.unauthorized;
    if (error.status === 429) return t.quotaError;
    if (error.status === 503) return t.unavailableError;
    if (error.code === "network") return t.networkError;
    if (error.status === 400) return t.formError;
  }
  return t.genericError;
}
export function validCoordinates(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}
export function safeVideo(value: unknown): VideoResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.title !== "string" || typeof v.videoId !== "string") return null;
  if (v.platform === "youtube" && /^[a-zA-Z0-9_-]{11}$/.test(v.videoId)) {
    return { title: v.title, videoId: v.videoId, platform: "youtube", url: `https://www.youtube.com/watch?v=${v.videoId}` };
  }
  if (v.platform === "bilibili" && /^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(v.videoId)) {
    return { title: v.title, videoId: v.videoId, platform: "bilibili", url: `https://www.bilibili.com/video/${v.videoId}` };
  }
  return null;
}
export function readVideos(data: unknown): VideoResult[] {
  const candidates = Array.isArray(data) ? data : data && typeof data === "object" ? (data as Record<string, unknown>).results ?? (data as Record<string, unknown>).videos : [];
  return Array.isArray(candidates) ? candidates.map(safeVideo).filter((value): value is VideoResult => value !== null) : [];
}
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function formatSeconds(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
export function formatReportedCount(value: number | undefined, partial: boolean, unknown: string): string {
  if (value === undefined || (partial && value === 0)) return unknown;
  return `${partial ? ">= " : ""}${value.toLocaleString()}`;
}
export function percentile(values: readonly number[], quantile: number): number | null {
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) throw new RangeError("Quantile must be in (0, 1]");
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * quantile) - 1]! : null;
}
