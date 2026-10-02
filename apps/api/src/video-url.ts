import type { VideoResult } from "@car/contracts";

export function parseVideoUrl(value: string): Pick<VideoResult, "platform" | "videoId" | "url"> | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash) return null;
    const host = url.hostname.toLowerCase();
    if (["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
      let id: string | null = null;
      if (host === "youtu.be" && /^\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) id = url.pathname.slice(1);
      else if (host !== "youtu.be" && url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
      else if (host !== "youtu.be" && /^\/(shorts|embed)\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) id = url.pathname.split("/")[2] ?? null;
      if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return { platform: "youtube", videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
    }
    if (["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(host)) {
      const match = /^\/video\/(BV[A-Za-z0-9]{10})\/?$/.exec(url.pathname);
      if (match?.[1]) return { platform: "bilibili", videoId: match[1], url: `https://www.bilibili.com/video/${match[1]}` };
    }
    return null;
  } catch { return null; }
}
