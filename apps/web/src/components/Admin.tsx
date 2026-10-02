import { useEffect, useRef, useState } from "react";
import { locales, type Locale } from "@car/contracts";
import { initialLocale, languageNames } from "../i18n";
import { formatReportedCount } from "../utils";
import { AdminError, createAdminSession, followUpStatuses, loadAdminConfig, validBillingRange, type AdminBillingReport, type AdminFilters, type AdminLead, type AdminOverview, type AdminPage, type AdminSession, type FollowUpStatus } from "../admin";
import "../admin.css";

const english = {
  title: "Administrator", back: "Back to demo", language: "Language", loading: "Checking administrator configuration…",
  unconfigured: "Administrator access is unavailable. Configure the Entra tenant, application, delegated API scope and administrator role. No sign-in or lead data is available until configuration is complete.",
  login: "Sign in with Microsoft", logout: "Sign out and clear data", privacy: "Authorized administrators only. Personal data is kept in memory; signing out clears this view. Exported files remain on your device. Leads expire 90 days after registration; editing does not extend retention.",
  company: "Company", scenario: "Scenario", status: "Follow-up status", all: "All", apply: "Apply filters", refresh: "Refresh", export: "Export filtered CSV",
  name: "Name", email: "Email", created: "Registered", detail: "Lead details", empty: "No leads on this page.", next: "Next page", first: "First page",
  new: "New", contacted: "Contacted", qualified: "Qualified", closed: "Closed", notes: "Operator notes (maximum 1,000 characters)",
  save: "Save follow-up", saved: "Follow-up saved. No email was sent.", noSend: "Follow-up records only. This console never sends email. Do not enter sensitive personal data in notes.",
  remove: "Delete lead and usage", deleteConfirm: "Permanently delete this lead and its usage records? The visitor session will also be revoked.",
  stop: "Emergency stop", stopConfirm: "Stop every active voice session and block new paid operations? A gateway restart with emergency stop disabled is required to resume.",
  confirm: "Confirm", cancel: "Cancel", active: "Active voice sessions", blocked: "Emergency stop is active", ready: "Emergency stop is inactive",
  estimate: "Application estimates — not an Azure invoice", cost: "Estimated USD", unknown: "Unavailable / incomplete", records: "Usage records", seconds: "Seconds", turns: "Turns",
  error: "The operation failed. Refresh and retry. Check administrator permissions or sign in again. An emergency stop may already be active.",
  authError: "Your administrator session expired or lacks the required role/scope. Personal data has been cleared. Sign in again.",
  phone: "Phone", timeline: "Timeline", marketing: "Marketing consent", yes: "Yes", no: "No", updated: "Last follow-up", close: "Close details", page: "Page"
};
type Labels = { [K in keyof typeof english]: string };
export const adminLabels: Record<Locale, Labels> = {
  "en-US": english,
  "zh-CN": {
    title: "管理后台", back: "返回演示", language: "语言", loading: "正在检查管理员配置…",
    unconfigured: "管理访问不可用。请配置 Entra 租户、应用、委托 API 权限和管理员角色。配置完成前无法登录或查看客户资料。",
    login: "使用 Microsoft 登录", logout: "退出并清除资料", privacy: "仅供授权管理员使用。个人资料仅保存在内存中，退出将清除此视图；导出文件仍保留在设备上。客户资料自登记起 90 天后过期，编辑不会延长保留期。",
    company: "公司", scenario: "应用场景", status: "跟进状态", all: "全部", apply: "应用筛选", refresh: "刷新", export: "导出筛选结果 CSV",
    name: "姓名", email: "邮箱", created: "登记时间", detail: "客户详情", empty: "本页没有客户资料。", next: "下一页", first: "第一页",
    new: "待跟进", contacted: "已联系", qualified: "已确认意向", closed: "已关闭", notes: "跟进备注（最多 1,000 字符）",
    save: "保存跟进", saved: "跟进已保存，未发送邮件。", noSend: "仅记录跟进，本后台不会发送邮件。请勿在备注中输入敏感个人资料。",
    remove: "删除客户及用量记录", deleteConfirm: "永久删除此客户及其用量记录？该访客会话也将失效。",
    stop: "紧急停止", stopConfirm: "停止所有语音会话并阻止新的付费操作？恢复需关闭紧急停止配置并重启网关。",
    confirm: "确认", cancel: "取消", active: "活跃语音会话", blocked: "紧急停止已启用", ready: "紧急停止未启用",
    estimate: "应用估算，不是 Azure 账单", cost: "估算美元费用", unknown: "不可用或不完整", records: "用量记录数", seconds: "秒数", turns: "轮次",
    error: "操作失败，请刷新重试并检查权限或重新登录。紧急停止可能已经生效。",
    authError: "管理员会话已过期或缺少角色/权限。个人资料已清除，请重新登录。",
    phone: "电话", timeline: "计划时间", marketing: "营销许可", yes: "是", no: "否", updated: "最近跟进", close: "关闭详情", page: "页"
  },
  "ja-JP": {
    title: "管理コンソール", back: "デモに戻る", language: "言語", loading: "管理者設定を確認中…",
    unconfigured: "管理機能は利用できません。Entra テナント、アプリ、委任 API スコープ、管理者ロールを設定してください。設定完了までサインインや顧客情報の表示はできません。",
    login: "Microsoft でサインイン", logout: "サインアウトして情報を消去", privacy: "認可された管理者専用です。個人情報はメモリ内のみで保持し、サインアウトで表示を消去します。エクスポートしたファイルは端末に残ります。登録から90日で期限切れとなり、編集しても延長されません。",
    company: "会社", scenario: "利用シナリオ", status: "対応状況", all: "すべて", apply: "絞り込む", refresh: "更新", export: "絞り込み結果を CSV 出力",
    name: "氏名", email: "メール", created: "登録日時", detail: "顧客の詳細", empty: "このページに顧客情報はありません。", next: "次のページ", first: "最初のページ",
    new: "新規", contacted: "連絡済み", qualified: "見込みあり", closed: "完了", notes: "担当者メモ（最大1,000文字）",
    save: "対応を保存", saved: "対応を保存しました。メールは送信していません。", noSend: "対応記録専用です。この画面からメールは送信されません。メモに機密個人情報を入力しないでください。",
    remove: "顧客と使用量を削除", deleteConfirm: "この顧客と使用量の記録を完全に削除しますか？訪問者セッションも失効します。",
    stop: "緊急停止", stopConfirm: "すべての音声セッションを停止し、新しい有料操作をブロックしますか？再開には緊急停止設定を無効にしてゲートウェイを再起動してください。",
    confirm: "確認", cancel: "キャンセル", active: "実行中の音声セッション", blocked: "緊急停止中", ready: "緊急停止は無効",
    estimate: "アプリの推定値 — Azure の請求書ではありません", cost: "推定費用（USD）", unknown: "不明 / 不完全", records: "使用量記録", seconds: "秒", turns: "ターン",
    error: "操作に失敗しました。更新して再試行し、権限を確認するか再度サインインしてください。緊急停止はすでに有効な場合があります。",
    authError: "セッションが期限切れか、必要なロール/スコープがありません。個人情報を消去しました。再度サインインしてください。",
    phone: "電話", timeline: "予定時期", marketing: "マーケティング同意", yes: "はい", no: "いいえ", updated: "最終対応", close: "詳細を閉じる", page: "ページ"
  },
  "ko-KR": {
    title: "관리자 콘솔", back: "데모로 돌아가기", language: "언어", loading: "관리자 구성을 확인하는 중…",
    unconfigured: "관리자 기능을 사용할 수 없습니다. Entra 테넌트, 앱, 위임 API 범위 및 관리자 역할을 구성하세요. 구성이 완료될 때까지 로그인하거나 고객 정보를 볼 수 없습니다.",
    login: "Microsoft로 로그인", logout: "로그아웃 및 정보 지우기", privacy: "승인된 관리자 전용입니다. 개인 정보는 메모리에만 유지되며 로그아웃하면 화면에서 지워집니다. 내보낸 파일은 기기에 남습니다. 등록 후 90일에 만료되며 수정해도 연장되지 않습니다.",
    company: "회사", scenario: "사용 시나리오", status: "후속 조치 상태", all: "전체", apply: "필터 적용", refresh: "새로 고침", export: "필터 결과 CSV 내보내기",
    name: "이름", email: "이메일", created: "등록일", detail: "고객 상세 정보", empty: "이 페이지에 고객 정보가 없습니다.", next: "다음 페이지", first: "첫 페이지",
    new: "신규", contacted: "연락 완료", qualified: "관심 확인", closed: "종료", notes: "담당자 메모 (최대 1,000자)",
    save: "후속 조치 저장", saved: "저장되었습니다. 이메일은 전송되지 않았습니다.", noSend: "후속 조치 기록 전용이며 이메일을 전송하지 않습니다. 메모에 민감한 개인 정보를 입력하지 마세요.",
    remove: "고객 및 사용량 삭제", deleteConfirm: "고객 정보와 사용량을 영구 삭제할까요? 방문자 세션도 취소됩니다.",
    stop: "긴급 중지", stopConfirm: "모든 음성 세션을 중지하고 새 유료 작업을 차단할까요? 재개하려면 긴급 중지 설정을 해제하고 게이트웨이를 다시 시작해야 합니다.",
    confirm: "확인", cancel: "취소", active: "활성 음성 세션", blocked: "긴급 중지 활성화됨", ready: "긴급 중지 비활성화됨",
    estimate: "앱 예상치 — Azure 청구서가 아닙니다", cost: "예상 USD", unknown: "알 수 없음 / 불완전", records: "사용량 기록", seconds: "초", turns: "턴",
    error: "작업에 실패했습니다. 새로 고침 후 다시 시도하고 권한을 확인하거나 다시 로그인하세요. 긴급 중지는 이미 적용되었을 수 있습니다.",
    authError: "관리자 세션이 만료되었거나 역할/범위가 없습니다. 개인 정보를 지웠습니다. 다시 로그인하세요.",
    phone: "전화", timeline: "예정 시기", marketing: "마케팅 동의", yes: "예", no: "아니요", updated: "최근 후속 조치", close: "상세 정보 닫기", page: "페이지"
  },
  "de-DE": {
    title: "Administration", back: "Zur Demo", language: "Sprache", loading: "Administratorkonfiguration wird geprüft…",
    unconfigured: "Administration ist nicht verfügbar. Entra-Mandant, Anwendung, delegierter API-Bereich und Administratorrolle müssen konfiguriert sein. Bis dahin sind Anmeldung und Kundendaten gesperrt.",
    login: "Mit Microsoft anmelden", logout: "Abmelden und Daten löschen", privacy: "Nur für berechtigte Administratoren. Personenbezogene Daten bleiben im Arbeitsspeicher; Abmelden leert diese Ansicht. Exportierte Dateien bleiben auf dem Gerät. Daten verfallen 90 Tage nach Registrierung; Änderungen verlängern die Frist nicht.",
    company: "Unternehmen", scenario: "Anwendungsfall", status: "Bearbeitungsstatus", all: "Alle", apply: "Filter anwenden", refresh: "Aktualisieren", export: "Gefilterte CSV exportieren",
    name: "Name", email: "E-Mail", created: "Registriert", detail: "Kontaktdetails", empty: "Keine Kontakte auf dieser Seite.", next: "Nächste Seite", first: "Erste Seite",
    new: "Neu", contacted: "Kontaktiert", qualified: "Qualifiziert", closed: "Abgeschlossen", notes: "Bearbeitungsnotizen (maximal 1.000 Zeichen)",
    save: "Bearbeitung speichern", saved: "Gespeichert. Es wurde keine E-Mail versendet.", noSend: "Nur Bearbeitungsvermerke. Diese Konsole versendet keine E-Mails. Keine sensiblen personenbezogenen Daten in Notizen eingeben.",
    remove: "Kontakt und Nutzung löschen", deleteConfirm: "Kontakt und Nutzungsdaten endgültig löschen? Die Besuchersitzung wird ebenfalls widerrufen.",
    stop: "Not-Aus", stopConfirm: "Alle Sprachsitzungen beenden und neue kostenpflichtige Vorgänge sperren? Zum Fortsetzen muss das Gateway mit deaktiviertem Not-Aus neu gestartet werden.",
    confirm: "Bestätigen", cancel: "Abbrechen", active: "Aktive Sprachsitzungen", blocked: "Not-Aus ist aktiv", ready: "Not-Aus ist inaktiv",
    estimate: "Anwendungsschätzungen — keine Azure-Rechnung", cost: "Geschätzte USD", unknown: "Nicht verfügbar / unvollständig", records: "Nutzungsdatensätze", seconds: "Sekunden", turns: "Dialogrunden",
    error: "Vorgang fehlgeschlagen. Aktualisieren und erneut versuchen. Berechtigungen prüfen oder erneut anmelden. Not-Aus kann bereits aktiv sein.",
    authError: "Sitzung abgelaufen oder Rolle/Bereich fehlen. Personenbezogene Daten wurden entfernt. Bitte erneut anmelden.",
    phone: "Telefon", timeline: "Zeitrahmen", marketing: "Marketingeinwilligung", yes: "Ja", no: "Nein", updated: "Letzte Bearbeitung", close: "Details schließen", page: "Seite"
  }
};

const emptyFilters: AdminFilters = { company: "", scenario: "", status: "" };
const billingEnglish = {
  title: "Azure Cost Management", notice: "Provisional scope-level costs, not per visitor or model and not a settled invoice. Reporting may be delayed or adjusted; unrelated resources in the configured scope may be included.",
  unconfigured: "Billing is unavailable until AZURE_COST_SCOPE and backend Cost Management Reader permissions are configured.",
  from: "From (UTC)", to: "To (UTC)", load: "Load billing report", range: "Choose 1–31 inclusive UTC days, no later than today.",
  scope: "ARM scope", fetched: "Fetched at", service: "Azure service", date: "Usage date (UTC)", currency: "Currency", cost: "Provisional cost", total: "Total by currency", empty: "No cost rows reported for this period. This does not prove that no charges exist."
};
export const billingLabels: Record<Locale, { [K in keyof typeof billingEnglish]: string }> = {
  "en-US": billingEnglish,
  "zh-CN": {
    title: "Azure 成本管理", notice: "范围级暂定费用，不是按访客或模型计算的费用，也不是已结算账单。报告可能延迟或调整，也可能包含该范围内无关资源的费用。",
    unconfigured: "请先配置 AZURE_COST_SCOPE 并为后端授予成本管理读取权限，才能查询费用。",
    from: "开始日期（UTC）", to: "结束日期（UTC）", load: "查询费用报告", range: "请选择含首尾共 1–31 天的 UTC 日期范围，最晚到今天。",
    scope: "ARM 资源范围", fetched: "查询时间", service: "Azure 服务", date: "用量日期（UTC）", currency: "币种", cost: "暂定费用", total: "按币种合计", empty: "此期间尚无费用行。这不代表没有产生费用。"
  },
  "ja-JP": {
    title: "Azure Cost Management", notice: "スコープ全体の暫定費用であり、訪問者別・モデル別の費用でも確定請求書でもありません。報告には遅延や調整があり、同じスコープの無関係なリソースも含まれる場合があります。",
    unconfigured: "AZURE_COST_SCOPE とバックエンドのコスト管理読み取り権限を設定するまで、費用の照会はできません。",
    from: "開始日（UTC）", to: "終了日（UTC）", load: "費用レポートを取得", range: "今日以前の、両端を含む1〜31日間の UTC 日付を選択してください。",
    scope: "ARM スコープ", fetched: "取得日時", service: "Azure サービス", date: "利用日（UTC）", currency: "通貨", cost: "暫定費用", total: "通貨別の合計", empty: "この期間の費用データは未報告です。課金がないことを意味しません。"
  },
  "ko-KR": {
    title: "Azure Cost Management", notice: "범위 전체의 잠정 비용이며 방문자별 또는 모델별 비용이나 확정 청구서가 아닙니다. 보고가 지연되거나 조정될 수 있으며 같은 범위의 관련 없는 리소스도 포함될 수 있습니다.",
    unconfigured: "AZURE_COST_SCOPE 및 백엔드 Cost Management Reader 권한을 구성해야 비용을 조회할 수 있습니다.",
    from: "시작일 (UTC)", to: "종료일 (UTC)", load: "비용 보고서 조회", range: "오늘 이전 날짜로 양 끝을 포함한 1–31일 UTC 범위를 선택하세요.",
    scope: "ARM 범위", fetched: "조회 시각", service: "Azure 서비스", date: "사용일 (UTC)", currency: "통화", cost: "잠정 비용", total: "통화별 합계", empty: "이 기간에 보고된 비용 행이 없습니다. 요금이 발생하지 않았다는 뜻은 아닙니다."
  },
  "de-DE": {
    title: "Azure Cost Management", notice: "Vorläufige Kosten des gesamten Bereichs, nicht je Besucher oder Modell und keine abschließende Rechnung. Berichte können verzögert oder angepasst werden und fremde Ressourcen im Bereich enthalten.",
    unconfigured: "Kosten sind erst nach Einrichtung von AZURE_COST_SCOPE und Cost-Management-Leserechten für das Backend verfügbar.",
    from: "Von (UTC)", to: "Bis (UTC)", load: "Kostenbericht laden", range: "1–31 UTC-Tage einschließlich beider Grenzen wählen, spätestens bis heute.",
    scope: "ARM-Bereich", fetched: "Abgerufen am", service: "Azure-Dienst", date: "Nutzungsdatum (UTC)", currency: "Währung", cost: "Vorläufige Kosten", total: "Summe je Währung", empty: "Für diesen Zeitraum wurden keine Kostenzeilen gemeldet. Das bedeutet nicht, dass keine Kosten entstanden sind."
  }
};
export function AdminBilling({ locale, configured, busy, report, onLoad }: {
  locale: Locale; configured: boolean; busy: boolean; report: AdminBillingReport | null; onLoad: (from: string, to: string) => void;
}) {
  const t = billingLabels[locale], today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)), [to, setTo] = useState(today);
  const valid = validBillingRange(from, to);
  return <section className="admin-card" aria-label={t.title}><h2>{t.title}</h2><p>{t.notice}</p>
    {!configured && <p role="status">{t.unconfigured}</p>}
    <form className="admin-filters" onSubmit={event => { event.preventDefault(); if (configured && valid && !busy) onLoad(from, to); }}>
      <label>{t.from}<input type="date" required disabled={!configured || busy} max={to < today ? to : today} value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>{t.to}<input type="date" required disabled={!configured || busy} min={from} max={today} value={to} onChange={event => setTo(event.target.value)} /></label>
      <button disabled={!configured || busy || !valid} type="submit">{t.load}</button>
    </form><p>{t.range}</p>
    {configured && report && <>
      <dl className="admin-detail"><div><dt>{t.scope}</dt><dd>{report.scope}</dd></div><div><dt>{t.fetched}</dt><dd>{new Date(report.fetchedAt).toLocaleString(locale)}</dd></div>
        <div><dt>{t.from}</dt><dd>{report.from}</dd></div><div><dt>{t.to}</dt><dd>{report.to}</dd></div>
      </dl>
      <h3>{t.total}</h3><ul>{report.totals.map(total => <li key={total.currency}>{total.currency}: {total.cost.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</li>)}</ul>
      <div className="admin-table"><table><thead><tr><th>{t.date}</th><th>{t.service}</th><th>{t.currency}</th><th>{t.cost}</th></tr></thead>
        <tbody>{report.rows.map((row, index) => <tr key={`${row.date}:${row.service}:${row.currency}:${index}`}><td>{row.date}</td><td>{row.service}</td><td>{row.currency}</td><td>{row.cost.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td></tr>)}</tbody>
      </table>{report.rows.length === 0 && <p>{t.empty}</p>}</div>
    </>}
  </section>;
}
export function Admin({ initialLanguage }: { initialLanguage?: Locale }) {
  const [locale, setLocale] = useState<Locale>(() => initialLanguage ?? initialLocale(typeof navigator === "undefined" ? "en-US" : navigator.language));
  const t = adminLabels[locale];
  const [configured, setConfigured] = useState<"loading" | "ready" | "unconfigured">("loading");
  const [signedIn, setSignedIn] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<"error" | "authError" | null>(null), [saved, setSaved] = useState(false);
  const [filters, setFilters] = useState<AdminFilters>(emptyFilters), [applied, setApplied] = useState<AdminFilters>(emptyFilters);
  const [page, setPage] = useState<AdminPage | null>(null), [pageNumber, setPageNumber] = useState(1);
  const [overview, setOverview] = useState<AdminOverview | null>(null), [selected, setSelected] = useState<AdminLead | null>(null);
  const [billing, setBilling] = useState<AdminBillingReport | null>(null);
  const [status, setStatus] = useState<FollowUpStatus>("new"), [notes, setNotes] = useState("");
  const [confirmation, setConfirmation] = useState<"delete" | "stop" | null>(null);
  const session = useRef<AdminSession | null>(null), epoch = useRef(0), requests = useRef(new AbortController());
  const clearData = () => {
    epoch.current++; requests.current.abort(); requests.current = new AbortController();
    setSignedIn(false); setPage(null); setOverview(null); setBilling(null); setSelected(null); setNotes(""); setStatus("new");
    setFilters(emptyFilters); setApplied(emptyFilters); setPageNumber(1); setConfirmation(null); setSaved(false); setBusy(false);
  };
  useEffect(() => {
    let alive = true;
    requests.current = new AbortController();
    const controller = new AbortController();
    void loadAdminConfig(controller.signal).then(async config => {
      if (!config) { if (alive) setConfigured("unconfigured"); return; }
      const auth = await createAdminSession(config);
      if (!alive) { await auth.clear(); return; }
      session.current = auth; setConfigured("ready");
    }).catch(() => { if (alive) setConfigured("unconfigured"); });
    return () => { alive = false; controller.abort(); epoch.current++; requests.current.abort(); void session.current?.clear(); };
  }, []);
  async function run<T>(operation: (auth: AdminSession, signal: AbortSignal) => Promise<T>, commit: (value: T) => void) {
    const auth = session.current;
    if (!auth) return;
    const current = epoch.current;
    setBusy(true); setError(null); setSaved(false);
    try {
      const value = await operation(auth, requests.current.signal);
      if (epoch.current === current) commit(value);
    } catch (cause) {
      if (epoch.current !== current) return;
      if (cause instanceof AdminError && [401, 403].includes(cause.status)) { clearData(); void auth.clear(); setError("authError"); }
      else setError("error");
    } finally { if (epoch.current === current) setBusy(false); }
  }
  const showPage = (value: AdminPage, number: number) => { setPage(value); setPageNumber(number); setSelected(null); setNotes(""); setConfirmation(null); };
  const refresh = (nextFilters = applied) => void run(async (auth, signal) => ({
    page: await auth.page(nextFilters, signal), overview: await auth.overview(signal)
  }), value => { showPage(value.page, 1); setApplied({ ...nextFilters }); setOverview(value.overview); });
  const login = () => void run(async (auth, signal) => {
    await auth.login();
    return { page: await auth.page(emptyFilters, signal), overview: await auth.overview(signal) };
  }, value => { setSignedIn(true); showPage(value.page, 1); setOverview(value.overview); });
  const logout = () => {
    clearData(); setError(null); setBusy(true);
    void session.current?.logout().catch(() => setError("error")).finally(() => setBusy(false));
  };
  const choose = (lead: AdminLead) => { setSelected(lead); setStatus(lead.followUp?.status ?? "new"); setNotes(lead.followUp?.notes ?? ""); setSaved(false); setConfirmation(null); };
  const download = () => void run((auth, signal) => auth.export(applied, signal), blob => {
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "leads.csv"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const confirm = () => {
    if (confirmation === "delete" && selected) void run(async (auth, signal) => {
      await auth.delete(selected.id, signal);
      return { page: await auth.page(applied, signal), overview: await auth.overview(signal) };
    }, value => { showPage(value.page, 1); setOverview(value.overview); });
    if (confirmation === "stop") void run(async (auth, signal) => {
      await auth.stop(signal); return auth.overview(signal);
    }, value => { setOverview(value); setConfirmation(null); });
  };
  return <main className="admin-shell" lang={locale}>
    <header className="admin-toolbar"><h1>{t.title}</h1><a href="#/">{t.back}</a>
      <label>{t.language}<select value={locale} onChange={event => setLocale(event.target.value as Locale)}>{locales.map(value => <option key={value} value={value}>{languageNames[value]}</option>)}</select></label>
      {signedIn && <button onClick={logout}>{t.logout}</button>}
    </header>
    <p className="admin-disclosure">{t.privacy}</p>
    {error && <p role="alert">{t[error]}</p>}
    {configured === "loading" && <p role="status">{t.loading}</p>}
    {configured === "unconfigured" && <p role="status">{t.unconfigured}</p>}
    {configured === "ready" && !signedIn && <button disabled={busy} onClick={login}>{t.login}</button>}
    {signedIn && <>
      <section className="admin-card" aria-label={t.estimate}>
        <h2>{t.estimate}</h2>
        {overview && <><dl className="admin-summary">
          <div><dt>{t.active}</dt><dd>{overview.activeSessions}</dd></div><div><dt>{t.cost}</dt><dd>{overview.usage.estimatedUsd === null ? t.unknown : overview.usage.estimatedUsd.toFixed(4)}</dd></div>
          <div><dt>{t.records}</dt><dd>{overview.usage.records}</dd></div><div><dt>{t.seconds}</dt><dd>{overview.usage.seconds.toFixed(1)}</dd></div><div><dt>{t.turns}</dt><dd>{formatReportedCount(overview.usage.turns, (overview.usage.partialCountRecords ?? 0) > 0, t.unknown)}</dd></div>
        </dl><p role="status">{overview.killSwitch ? t.blocked : t.ready}</p></>}
        <button className="admin-danger" disabled={busy || overview?.killSwitch} onClick={() => setConfirmation("stop")}>{t.stop}</button>
      </section>
      <AdminBilling locale={locale} configured={overview?.billingConfigured === true} busy={busy} report={billing} onLoad={(from, to) => {
        if (!overview?.billingConfigured) return;
        setBilling(null); void run((auth, signal) => auth.billing(from, to, signal), setBilling);
      }} />
      <form className="admin-filters" onSubmit={event => { event.preventDefault(); refresh(filters); }}>
        <label>{t.company}<input maxLength={200} value={filters.company} onChange={event => setFilters({ ...filters, company: event.target.value })} /></label>
        <label>{t.scenario}<input maxLength={500} value={filters.scenario} onChange={event => setFilters({ ...filters, scenario: event.target.value })} /></label>
        <label>{t.status}<select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value as AdminFilters["status"] })}><option value="">{t.all}</option>{followUpStatuses.map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
        <button disabled={busy} type="submit">{t.apply}</button><button disabled={busy} type="button" onClick={() => refresh()}>{t.refresh}</button><button disabled={busy} type="button" onClick={download}>{t.export}</button>
      </form>
      <div className="admin-table"><table><thead><tr><th>{t.name}</th><th>{t.company}</th><th>{t.scenario}</th><th>{t.status}</th><th>{t.created}</th></tr></thead><tbody>
        {page?.leads.map(lead => <tr key={lead.id}><td><button disabled={busy} onClick={() => choose(lead)}>{lead.registration.name}</button></td><td>{lead.registration.company}</td><td>{lead.registration.scenario}</td><td>{t[lead.followUp?.status ?? "new"]}</td><td>{new Date(lead.createdAt).toLocaleString(locale)}</td></tr>)}
      </tbody></table>{page?.leads.length === 0 && <p>{t.empty}</p>}</div>
      <nav className="admin-toolbar" aria-label={t.page}><span>{t.page} {pageNumber}</span><button disabled={busy || pageNumber === 1} onClick={() => refresh()}>{t.first}</button>
        <button disabled={busy || !page?.nextCursor} onClick={() => void run((auth, signal) => auth.page(applied, signal, page?.nextCursor ?? undefined), value => showPage(value, pageNumber + 1))}>{t.next}</button></nav>
      {selected && <section className="admin-card" aria-label={t.detail}><h2>{t.detail}</h2>
        <dl className="admin-detail">{([
          [t.name, selected.registration.name], [t.company, selected.registration.company], [t.email, selected.registration.email], [t.scenario, selected.registration.scenario],
          [t.phone, selected.registration.phone ?? "—"], [t.timeline, selected.registration.timeline ?? "—"], [t.marketing, selected.registration.marketingConsent ? t.yes : t.no],
          [t.created, new Date(selected.createdAt).toLocaleString(locale)], [t.updated, selected.followUp ? new Date(selected.followUp.updatedAt).toLocaleString(locale) : "—"]
        ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <form onSubmit={event => { event.preventDefault(); void run((auth, signal) => auth.update(selected.id, status, notes, signal), value => {
          setSelected(value.lead); setNotes(value.lead.followUp?.notes ?? ""); setSaved(true);
          setPage(previous => previous ? { ...previous, leads: previous.leads.map(lead => lead.id === value.lead.id ? value.lead : lead).filter(lead => !applied.status || (lead.followUp?.status ?? "new") === applied.status) } : previous);
        }); }}>
          <p>{t.noSend}</p><label>{t.status}<select disabled={busy} value={status} onChange={event => setStatus(event.target.value as FollowUpStatus)}>{followUpStatuses.map(value => <option key={value} value={value}>{t[value]}</option>)}</select></label>
          <label>{t.notes}<textarea disabled={busy} rows={4} maxLength={1000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
          <div className="admin-toolbar"><button disabled={busy} type="submit">{t.save}</button><button disabled={busy} type="button" onClick={() => { setSelected(null); setNotes(""); setConfirmation(null); }}>{t.close}</button>
            <button disabled={busy} type="button" className="admin-danger" onClick={() => setConfirmation("delete")}>{t.remove}</button></div>
          {saved && <p role="status">{t.saved}</p>}
        </form>
      </section>}
      {confirmation && <section className="admin-confirm admin-card" role="alertdialog" aria-modal="false" aria-labelledby="admin-confirm-title">
        <h2 id="admin-confirm-title">{confirmation === "delete" ? t.deleteConfirm : t.stopConfirm}</h2>
        <button autoFocus disabled={busy} onClick={() => setConfirmation(null)}>{t.cancel}</button> <button className="admin-danger" disabled={busy} onClick={confirm}>{t.confirm}</button>
      </section>}
    </>}
  </main>;
}
export default Admin;
