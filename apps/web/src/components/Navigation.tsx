import { useEffect, useState, type FormEvent } from "react";
import type { ActionResult, Capability } from "@car/contracts";
import type { Messages } from "../i18n";
import { validCoordinates } from "../utils";
import type { RunAction } from "./Vehicle";
import { Icon } from "./Icon";

type Place = { name: string; address: string; lat: number; lon: number };
function readPlaces(data: unknown): Place[] {
  if (!data || typeof data !== "object") return [];
  const normalized = (data as { places?: { name: string; address: string; latitude: number; longitude: number }[] }).places;
  if (Array.isArray(normalized)) return normalized.filter(item => validCoordinates(item.latitude, item.longitude)).map(item => ({ name: item.name, address: item.address, lat: item.latitude, lon: item.longitude }));
  const results = Array.isArray(data) ? data : (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((item: { poi?: { name?: string }; address?: { freeformAddress?: string } | string; position?: { lat: number; lon: number }; name?: string }) => {
    if (!item?.position || !validCoordinates(item.position.lat, item.position.lon)) return [];
    return [{ name: item.poi?.name ?? item.name ?? (typeof item.address === "object" ? item.address.freeformAddress : item.address) ?? "", address: typeof item.address === "object" ? item.address.freeformAddress ?? "" : item.address ?? "", ...item.position }];
  });
}
function readRoute(data: unknown): { meters?: number; seconds?: number; points: { latitude: number; longitude: number }[] } {
  if (!data || typeof data !== "object") return { points: [] };
  const normalized = data as { distanceMeters?: number; durationSeconds?: number; points?: { latitude: number; longitude: number }[] };
  if (Array.isArray(normalized.points)) return { meters: normalized.distanceMeters, seconds: normalized.durationSeconds, points: normalized.points.filter(point => validCoordinates(point.latitude, point.longitude)) };
  const routes = (data as { routes?: { summary?: { lengthInMeters?: number; travelTimeInSeconds?: number }; legs?: { points?: { latitude: number; longitude: number }[] }[] }[] }).routes;
  const route = routes?.[0];
  return { meters: route?.summary?.lengthInMeters, seconds: route?.summary?.travelTimeInSeconds, points: route?.legs?.flatMap(leg => leg.points ?? []).filter(point => validCoordinates(point.latitude, point.longitude)) ?? [] };
}
export function Navigation({ t, capability, run, busy, result }: { t: Messages; capability?: Capability; run: RunAction; busy: boolean; result: ActionResult | null }) {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [raw, setRaw] = useState<unknown>(null);
  const [routeData, setRouteData] = useState<unknown>(null);
  const [coordinates, setCoordinates] = useState({ startLat: "", startLon: "", endLat: "", endLon: "" });
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (result?.status !== "completed" || result.provider !== "azure-maps" || !result.data) return;
    if (readRoute(result.data).points.length) setRouteData(result.data);
    else { setPlaces(readPlaces(result.data)); setRaw(result.data); }
  }, [result]);
  const enabled = capability?.status === "ready";
  const route = readRoute(routeData);
  const routeSubmit = (event: FormEvent) => {
    event.preventDefault();
    const { startLat, startLon, endLat, endLon } = coordinates;
    if (Object.values(coordinates).some(value => !value.trim()) || !validCoordinates(Number(startLat), Number(startLon)) || !validCoordinates(Number(endLat), Number(endLon))) { setInvalid(true); return; }
    setInvalid(false);
    void run("navigation.route", { origin: { latitude: Number(startLat), longitude: Number(startLon) }, destination: { latitude: Number(endLat), longitude: Number(endLon) } }).then(result => { if (result?.status === "completed") setRouteData(result.data); });
  };
  const points = route.points;
  let polyline = "";
  if (points.length) {
    const lats = points.map(point => point.latitude), lons = points.map(point => point.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
    polyline = points.map(point => `${30 + (point.longitude - minLon) / (maxLon - minLon || 1) * 540},${270 - (point.latitude - minLat) / (maxLat - minLat || 1) * 240}`).join(" ");
  }
  return <div className="panel-stack"><section className="card"><div className="section-heading"><div><div className="eyebrow">AZURE MAPS</div><h2>{t.mapIntro}</h2></div><span className={`badge ${enabled ? "ready" : ""}`}>{t[capability?.status ?? "unconfigured"]}</span></div><p className="muted">{t.mapNote}</p>
    {!enabled && <div className="map-empty"><Icon name="navigation" size={48} /><h3>{t.unconfigured}</h3><p>{t.unavailableError}</p><div className="map-grid" aria-hidden="true" /></div>}
    <form className="search-row" onSubmit={event => { event.preventDefault(); if (query.trim()) void run("navigation.search", { query: query.trim() }).then(result => { if (result?.status === "completed") { setPlaces(readPlaces(result.data)); setRaw(result.data); } }); }}><label className="grow">{t.destination}<input value={query} onChange={event => setQuery(event.target.value)} maxLength={200} required /></label><button className="primary" disabled={!enabled || busy || !query.trim()}>{t.search}</button></form>
    {places.length > 0 && <div className="record-list">{places.map((place, index) => <button className="place-result" key={`${place.lat}-${place.lon}-${index}`} onClick={() => setCoordinates(value => ({ ...value, endLat: String(place.lat), endLon: String(place.lon) }))}><Icon name="navigation" /><span><strong>{place.name}</strong><small>{place.address}</small></span><span>{place.lat.toFixed(4)}, {place.lon.toFixed(4)}</span></button>)}</div>}
    {raw !== null && <details><summary>{t.rawData}</summary><pre className="data-block">{JSON.stringify(raw, null, 2)}</pre></details>}
  </section><section className="card"><h3>{t.route}</h3><form onSubmit={routeSubmit} noValidate><div className="form-grid">{(["startLat", "startLon", "endLat", "endLon"] as const).map(key => <label key={key}>{t[key]}<input type="number" step="any" required value={coordinates[key]} onChange={event => setCoordinates(value => ({ ...value, [key]: event.target.value }))} /></label>)}</div>{invalid && <p className="error-banner" role="alert">{t.coordinateError}</p>}<button className="primary" disabled={!enabled || busy}>{t.route}</button></form>
    {routeData !== null && <><div className="metric-grid">{route.meters !== undefined && <div className="metric"><span>{t.distance}</span><strong>{(route.meters / 1000).toFixed(1)} <small>km</small></strong></div>}{route.seconds !== undefined && <div className="metric"><span>{t.duration}</span><strong>{Math.ceil(route.seconds / 60)} <small>{t.minute}</small></strong></div>}</div>{polyline && <figure className="route-figure"><svg viewBox="0 0 600 300" role="img" aria-label={t.routeGeometry}><polyline points={polyline} fill="none" stroke="var(--accent)" strokeWidth={3} strokeLinejoin="round" /></svg><figcaption>{t.routeGeometryNote}</figcaption></figure>}<details><summary>{t.rawData}</summary><pre className="data-block">{JSON.stringify(routeData, null, 2)}</pre></details></>}
  </section></div>;
}
