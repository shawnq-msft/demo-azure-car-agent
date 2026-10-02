export type IconName = "vehicle" | "navigation" | "media" | "work" | "metrics" | "mic" | "phone" | "arrow" | "check" | "fan" | "windowOpen" | "seatHeat" | "locked" | "driving" | "close";
const paths: Record<IconName, string> = {
  vehicle:"M5 17h14M5 17v3m14-3v3M3 16v-4l2-2 2-6h10l2 6 2 2v4H3Zm2-6h14M6 13h2m8 0h2",
  navigation:"m12 3 8 18-8-5-8 5 8-18Z",
  media:"m9 5 12-2v13M9 5v14M9 9l12-2M9 19c0 3-6 3-6 0s6-3 6 0Zm12-3c0 3-6 3-6 0s6-3 6 0Z",
  work:"M4 7h16v14H4V7Zm4 0V3h8v4M4 12h16m-10-2v4h4v-4",
  metrics:"M4 20V10m8 10V4m8 16v-7",
  mic:"M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-4 6a7 7 0 0 0 14 0m-7 7v4m-4 0h8",
  phone:"M6 3 3 6c-1 7 8 16 15 15l3-3-5-4-3 2-5-5 2-3-4-5Z",
  arrow:"M4 12h16m-6-6 6 6-6 6",check:"m5 12 4 4L19 6",fan:"M12 12c-8-7 1-13 2-7l-2 7Zm0 0c10-3 10 8 5 6l-5-6Zm0 0c-2 10-12 5-8 1l8-1Z",
  windowOpen:"M4 20V9l7-6h9v17H4Zm0-5h16",
  seatHeat:"M5 3v10a4 4 0 0 0 4 4h11v4M5 13h12M11 3c3 2-3 4 0 6m5-6c3 2-3 4 0 6",
  locked:"M5 10h14v11H5V10Zm3 0V6a4 4 0 0 1 8 0v4m-4 4v3",
  driving:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-8 8h16m-9 2-5 6m7-6 5 6",
  close:"m6 6 12 12M6 18 18 6"
};
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
