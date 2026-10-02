import { useEffect, useState } from "react";
import type { DiagnosticPhase, DiagnosticSnapshot, Locale } from "@car/contracts";
import { api } from "../api";
import { errorMessage } from "../utils";
import { dictionaries } from "../i18n";

const labels: Record<Locale, { title: string; note: string; export: string; trace: string; phase: string; time: string; result: string; failure: string; phases: Record<DiagnosticPhase, string> }> = {
  "en-US": { title: "Conversation diagnostics", note: "Current-session metadata only. Browser playback durations and gateway offsets use separate clocks. Internal STT/LLM/TTS stages are not exposed.", export: "Export diagnostics", trace: "Trace", phase: "Phase", time: "Offset / duration", result: "Result", failure: "Failed tools", phases: { connection: "Connecting", "vad-end": "Speech end", "first-text": "First text", "audio-arrival": "First audio received", "response-complete": "Response complete", tool: "Tool", "client-playback-latency": "Browser playback latency", "session-end": "Session ended" } },
  "zh-CN": { title: "对话诊断", note: "仅记录当前会话元数据。浏览器播放耗时与网关时间偏移使用独立时钟，不能相减。服务内部 STT/LLM/TTS 阶段不可观测。", export: "导出诊断", trace: "追踪", phase: "阶段", time: "偏移 / 耗时", result: "结果", failure: "失败工具数", phases: { connection: "建立连接", "vad-end": "用户语音结束", "first-text": "首段文字", "audio-arrival": "首段音频到达", "response-complete": "响应完成", tool: "工具调用", "client-playback-latency": "浏览器播放延迟", "session-end": "会话结束" } },
  "ja-JP": { title: "会話の診断", note: "現在のセッションのメタデータのみ。ブラウザーとゲートウェイの時計は別です。内部の STT/LLM/TTS 時間は公開されません。", export: "診断を保存", trace: "トレース", phase: "段階", time: "オフセット / 時間", result: "結果", failure: "ツール失敗数", phases: { connection: "接続中", "vad-end": "発話終了", "first-text": "最初のテキスト", "audio-arrival": "最初の音声受信", "response-complete": "応答完了", tool: "ツール", "client-playback-latency": "ブラウザー再生遅延", "session-end": "セッション終了" } },
  "ko-KR": { title: "대화 진단", note: "현재 세션 메타데이터만 기록합니다. 브라우저와 게이트웨이는 별도 시계를 사용하며 내부 STT/LLM/TTS 단계는 공개되지 않습니다.", export: "진단 내보내기", trace: "추적", phase: "단계", time: "오프셋 / 소요 시간", result: "결과", failure: "도구 실패 수", phases: { connection: "연결 중", "vad-end": "발화 종료", "first-text": "첫 텍스트", "audio-arrival": "첫 오디오 수신", "response-complete": "응답 완료", tool: "도구", "client-playback-latency": "브라우저 재생 지연", "session-end": "세션 종료" } },
  "de-DE": { title: "Gesprächsdiagnose", note: "Nur Metadaten der aktuellen Sitzung. Browser und Gateway nutzen getrennte Uhren. Interne STT/LLM/TTS-Phasen sind nicht sichtbar.", export: "Diagnose exportieren", trace: "Trace", phase: "Phase", time: "Offset / Dauer", result: "Ergebnis", failure: "Fehlgeschlagene Tools", phases: { connection: "Verbindung", "vad-end": "Sprachende", "first-text": "Erster Text", "audio-arrival": "Erstes Audio empfangen", "response-complete": "Antwort vollständig", tool: "Tool", "client-playback-latency": "Browser-Wiedergabelatenz", "session-end": "Sitzungsende" } }
};
export function DiagnosticsPanel({ token, locale }: { token: string; locale: Locale }) {
  const [data, setData] = useState<DiagnosticSnapshot | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const t = dictionaries[locale], text = labels[locale];
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    void api.diagnostics(token).then(snapshot => { if (active) setData(snapshot); }).catch(reason => { if (active) setError(reason); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token, version]);
  const exportData = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "car-demo-diagnostics.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="card">
    <div className="section-heading"><h2>{text.title}</h2><button onClick={() => setVersion(value => value + 1)} disabled={loading}>{t.refresh}</button></div>
    <p className="muted">{text.note}</p>
    {error != null && <p role="alert">{errorMessage(error, t)}</p>}
    <div className="metadata"><span>{text.failure}</span><strong>{data?.tools.failed ?? t.unknown}</strong><span>{t.sampleCount}</span><strong>{data?.observations.length ?? t.unknown}</strong></div>
    {data?.sessions.map(session => <p className="small muted" key={session.traceId}>{text.trace} {session.traceId.slice(0, 8)} · {session.model} · {session.locale} · {session.transport}</p>)}
    <div style={{ overflowX: "auto", maxHeight: 400 }}>
      <table style={{ width: "100%", fontSize: "0.8rem", textAlign: "left" }}>
        <thead><tr><th>{text.trace}</th><th>{text.phase}</th><th>{text.time}</th><th>{text.result}</th></tr></thead>
        <tbody>{data?.observations.slice().reverse().map(row => <tr key={row.sequence}>
          <td>{row.traceId.slice(0, 8)}</td><td>{text.phases[row.phase]} {row.tool ?? ""}<br /><small>{row.provider ?? row.source}</small></td>
          <td>{Math.round(row.offsetMs)} ms{row.durationMs === undefined ? "" : ` / ${row.durationMs.toFixed(2)} ms`}</td>
          <td>{row.success === undefined ? "—" : row.success ? t.completed : t.unavailable}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <button disabled={!data} onClick={exportData}>{text.export}</button>
  </section>;
}
