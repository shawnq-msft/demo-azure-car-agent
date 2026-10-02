import type { Capabilities, Locale, UsageSummary } from "@car/contracts";
import type { Messages } from "../i18n";
import { formatReportedCount, formatSeconds, percentile } from "../utils";
import { DiagnosticsPanel } from "./Diagnostics";

export function Metrics({ t, usage, capabilities, refresh, token, locale = "en-US" }: { t: Messages; usage: UsageSummary | null; capabilities: Capabilities | null; refresh: () => void; token?: string; locale?: Locale }) {
  const samples = usage?.latencySamples.filter(value => Number.isFinite(value) && value >= 0) ?? [];
  const mean = samples.length ? Math.round(samples.reduce((total, value) => total + value, 0) / samples.length) : null;
  const formatPercentile = (quantile: number) => {
    const value = percentile(samples, quantile);
    return value === null ? t.unknown : `${Math.round(value)} ms`;
  };
  const cacheNotice: Record<Locale, string> = {
    "en-US": "Cached input is conservatively estimated at the uncached rate; cache discounts are not applied.",
    "zh-CN": "缓存输入按非缓存费率保守估算，未扣除缓存折扣。",
    "ja-JP": "キャッシュ入力は通常料金で保守的に見積もられ、割引は適用していません。",
    "ko-KR": "캐시 입력은 일반 요금으로 보수적으로 추정하며 캐시 할인은 적용하지 않습니다.",
    "de-DE": "Cache-Eingaben werden konservativ zum normalen Tarif geschätzt; Cache-Rabatte sind nicht abgezogen."
  };
  const timingNotice: Record<Locale, string> = {
    "en-US": "Latency starts when this browser receives the speech-end event and ends at the Web Audio output timestamp. It excludes speech-end detection/uplink time; GPT-Live and WebRTC do not fabricate missing samples.",
    "zh-CN": "延迟从浏览器收到语音结束事件起算，至 Web Audio 输出时间戳；不含语音结束检测及上行耗时。GPT-Live 与 WebRTC 不伪造缺失样本。",
    "ja-JP": "遅延はブラウザーの発話終了イベント受信から音声出力までです。終了検出と上り通信時間は含みません。未観測の値は生成しません。",
    "ko-KR": "지연은 브라우저의 발화 종료 이벤트 수신부터 오디오 출력까지이며 종료 감지와 업링크 시간은 제외합니다. 관측되지 않은 값은 생성하지 않습니다.",
    "de-DE": "Latenz vom Empfang des Sprachende-Ereignisses im Browser bis zur Audioausgabe, ohne Erkennung und Uplink. Fehlende Messwerte werden nicht erfunden."
  };
  const coverageNotice: Record<Locale, string> = {
    "en-US": "GPT-Live voice is billed by time and does not report voice tokens or authoritative turn counts. Counts shown are reported lower bounds; missing counts remain unknown.",
    "zh-CN": "GPT-Live 语音按时长计费，不报告语音 token 或权威轮次数。所示计数为已报告的下限，缺失计数仍显示未知。",
    "ja-JP": "GPT-Live 音声は時間課金で、音声トークンと確定したターン数は報告されません。表示値は報告済みの下限で、欠測値は不明です。",
    "ko-KR": "GPT-Live 음성은 시간 기반 요금이며 음성 토큰과 확정된 턴 수를 보고하지 않습니다. 표시된 수치는 보고된 하한이며 누락된 값은 알 수 없음으로 표시됩니다.",
    "de-DE": "GPT-Live-Sprache wird nach Zeit abgerechnet; Sprach-Token und verlässliche Rundenzahlen fehlen. Angezeigte Zähler sind gemeldete Untergrenzen; fehlende Werte bleiben unbekannt."
  };
  return <div className="panel-stack"><section className="card"><div className="section-heading"><div><div className="eyebrow">{t.metrics}</div><h2>{t.insightsTitle}</h2></div><button onClick={refresh}>{t.refresh}</button></div><p className="muted">{t.insightsNote}</p>
    <div className="metric-grid">{[
      [t.voiceTime, usage ? formatSeconds(usage.seconds) : t.unknown],
      [t.cost, usage?.estimatedUsd == null ? t.unknown : `$${usage.estimatedUsd.toFixed(4)}`],
      [t.tokensIn, formatReportedCount(usage?.inputTokens, usage?.tokenTurnCoverage === "partial", t.unknown)],
      [t.tokensOut, formatReportedCount(usage?.outputTokens, usage?.tokenTurnCoverage === "partial", t.unknown)],
      [t.turns, formatReportedCount(usage?.turns, usage?.tokenTurnCoverage === "partial", t.unknown)],
      [t.latency, mean === null ? t.unknown : `${mean} ms`],
      [`${t.latency} P50`, formatPercentile(0.5)],
      [`${t.latency} P95`, formatPercentile(0.95)]
    ].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
    <div className="metadata"><span>{t.sampleCount}</span><strong>{samples.length}</strong><span>{t.rateVersion}</span><strong>{usage?.rateVersion ?? t.unknown}</strong></div><p className="notice">{t.costNote}</p>
    {usage?.costBasis === "uncached-upper-bound" && <p className="notice">{cacheNotice[locale]}</p>}
    <p className="notice">{timingNotice[locale]}</p>
    {usage?.tokenTurnCoverage === "partial" && <p className="notice">{coverageNotice[locale]}</p>}
  </section><section className="card"><h3>{t.limits}</h3><div className="metadata"><span>{t.sessionLimit}</span><strong>{capabilities ? formatSeconds(capabilities.limits.sessionSeconds) : t.unknown}</strong><span>{t.dailyLimit}</span><strong>{capabilities ? formatSeconds(capabilities.limits.dailySeconds) : t.unknown}</strong></div></section>{token && <DiagnosticsPanel token={token} locale={locale} />}</div>;
}
