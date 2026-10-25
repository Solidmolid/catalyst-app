/* Catalyst App – liest Depot-Lage, Meldungen und Tages-Radar aus Supabase.
 *
 * Geschrieben werden die Daten ausschließlich vom Catalyst selbst (GitHub Actions
 * bzw. die tägliche Routine). Diese App liest nur — und Supabase gibt die Zeilen
 * nur an das eine berechtigte Konto heraus (Row Level Security).
 *
 * Alle Texte gehen über textContent ins DOM, nie als HTML.
 */
"use strict";

const SUPABASE_URL = "https://uytacdogqercenlgbpgb.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_NmRBqjT43mYeYS_WJNsx2w_NmhfzIkg";
const SEEN_KEY = "catalyst.meldungen.gesehen";
// Öffentlicher Schlüssel für Push-Mitteilungen (der private liegt nur beim Catalyst).
const VAPID_PUBLIC = "BHyvpkkybomq01QLWJiOKOSI0XP-swCz4HoswEylu09-YTxN76PxSPDa25_xkoFPWtZqf5G9TFeLq6T-RKPE3_M";

const $ = (id) => document.getElementById(id);
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const state = { view: "depot", feed: {}, meldungen: [], trades: [], verlauf: [], range: "Max",
  depotWert: 0, loading: false, live: null,
  pruefung: { aktiv: false, text: "", timer: null }, aktieOeffnen: {},
  chat: { gespraech: null, zeilen: [], bereit: false, pcAn: null, weg: null, timer: null, sendet: false, fehler: "" } };

// --------------------------------------------------------------------------- //
// Formatierung
// --------------------------------------------------------------------------- //
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const pctFmt = new Intl.NumberFormat("de-DE", {
  signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1,
});

function fmtEur(n) { return n == null ? "—" : eur.format(n); }
const shareFmt = new Intl.NumberFormat("de-DE", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
function fmtShare(x) { return x == null || !isFinite(x) ? "—" : shareFmt.format(x); }
const eur0 = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
function fmtPct(n) { return n == null ? "—" : `${pctFmt.format(n)} %`; }
function trend(n) { return n == null ? "" : n >= 0 ? "up" : "down"; }

function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

function fmtStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Routine läuft alle 3 Std. (plus ein paar Minuten Versatz) -- ab 4 Std. fehlt ein Lauf.
const RADAR_ALT_STD = 4;

function fmtAgo(ts) {
  const min = Math.floor((Date.now() - new Date(ts)) / 60000);
  if (min < 2) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const std = Math.floor(min / 60);
  if (std < 24) return `vor ${std} Std.`;
  const tage = Math.floor(std / 24);
  return tage === 1 ? "vor 1 Tag" : `vor ${tage} Tagen`;
}

function daysUntil(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(`${iso}T00:00:00`);
  return Math.round((d - today) / 86400000);
}

function inDays(iso) {
  const n = daysUntil(iso);
  if (n < 0) return "vorbei";
  if (n === 0) return "heute";
  if (n === 1) return "morgen";
  return `in ${n} Tagen`;
}

// --------------------------------------------------------------------------- //
// DOM-Helfer (nur textContent)
// --------------------------------------------------------------------------- //
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function add(parent, ...children) {
  for (const c of children) if (c) parent.appendChild(c);
  return parent;
}

function empty(text) { return el("div", "card empty", text); }

// --------------------------------------------------------------------------- //
// Depot
// --------------------------------------------------------------------------- //
function renderDepot() {
  const view = $("view-depot");
  view.replaceChildren();
  const entry = state.feed.depot;
  const rows = entry?.payload?.rows || [];
  const positions = rows.filter((r) => r.art === "position");
  const watch = rows.filter((r) => r.art === "watchlist");

  if (!positions.length && !watch.length) {
    view.appendChild(empty("Noch keine Depot-Daten. Der Catalyst schreibt sie beim nächsten Lauf."));
    return;
  }

  const aktien = positions.filter((r) => r.typ !== "etf");
  const etfs = positions.filter((r) => r.typ === "etf");
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

  // Kopf: Depotwert groß, darunter heute / seit Einstand, Aufteilung als ein Balken
  const priced = positions.filter((r) => r.wert_eur != null);
  state.depotWert = sum(priced, "wert_eur");
  if (priced.length) {
    const wert = sum(priced, "wert_eur");
    const einstand = sum(priced, "einstand_eur");
    const heute = priced.reduce((s, r) => (r.tag_pct == null ? s : s + r.wert_eur - r.wert_eur / (1 + r.tag_pct / 100)), 0);
    const gesamtPct = einstand ? (wert / einstand - 1) * 100 : null;
    const hero = el("div", "hero");
    add(hero, el("div", "hero-label", "Depotwert"), el("div", "hero-value", fmtEur(wert)));
    const sub = el("div", "hero-sub");
    const a = el("span", trend(heute)); add(a, el("b", null, `${heute >= 0 ? "+" : "−"}${fmtEur(Math.abs(heute))}`), document.createTextNode(" heute"));
    const b = el("span", trend(gesamtPct)); add(b, el("b", null, fmtPct(gesamtPct)), document.createTextNode(" seit Einstand"));
    add(sub, a, b);
    hero.appendChild(sub);

    const cash = entry.payload.cash;
    const teile = [
      ["a-aktien", "Aktien", sum(aktien.filter((r) => r.wert_eur != null), "wert_eur")],
      ["a-etf", "ETFs", sum(etfs.filter((r) => r.wert_eur != null), "wert_eur")],
      ["a-cash", cash?.geschaetzt ? "Cash (geschätzt)" : "Cash", cash?.eur > 0 ? cash.eur : 0],
    ].filter(([, , w]) => w > 0);
    const gesamt = teile.reduce((s, [, , w]) => s + w, 0);
    if (gesamt > 0) {
      const alloc = el("div", "alloc");
      const bar = el("div", "alloc-bar");
      const legend = el("div", "alloc-legend");
      for (const [cls, name, w] of teile) {
        const seg = el("span", cls);
        seg.style.flex = String(w / gesamt);
        bar.appendChild(seg);
        const item = el("span");
        add(item, el("i", cls), document.createTextNode(`${name} ${fmtShare(w / gesamt)}`));
        legend.appendChild(item);
      }
      add(alloc, bar, legend);
      hero.appendChild(alloc);
    }
    const stand = state.live?.ok ? `Live-Kurse · ${fmtStamp(state.live.zeit)}` : `Stand · ${fmtStamp(entry.updated_at)}`;
    hero.appendChild(el("div", "hero-stand", stand));
    view.appendChild(hero);
  }

  if (state.verlauf.length > 1) view.appendChild(verlaufCard());

  // Aktive Hinweise (deine Marken, große Bewegung, naher Termin)
  for (const h of entry.payload.hinweise || []) view.appendChild(el("div", "alert", h.text));

  const fokus = hinschauenKarte(aktien);
  if (fokus) view.appendChild(fokus);

  const liste = (titel, rows, mitTermin) => {
    if (!rows.length) return;
    view.appendChild(el("div", "section-title", titel));
    const box = el("div", "ledger");
    for (const r of [...rows].sort((x, y) => (y.wert_eur || 0) - (x.wert_eur || 0))) box.appendChild(positionRow(r, mitTermin));
    view.appendChild(box);
  };
  liste("Einzelaktien", aktien, true);
  liste("ETFs", etfs, false);

  if (watch.length) {
    view.appendChild(el("div", "section-title", "Watchlist"));
    const box = el("div", "ledger");
    for (const r of watch) {
      const sumRow = el("div", "pos-sum");
      add(sumRow, el("div", "pos-name", r.name), el("div", "pos-value", fmtEur(r.kurs_eur)),
        el("div", "pos-line2", r.ticker), el("div", `pos-pct ${trend(r.tag_pct)}`, `${fmtPct(r.tag_pct)} heute`));
      box.appendChild(add(el("div", "pos-row"), sumRow));
    }
    view.appendChild(box);
  }

  if (state.trades.length) view.appendChild(tradeList());

  if (positions.some((r) => r.geschaetzt)) {
    view.appendChild(el("p", "note", "Stückzahl und Einstand sind teils geschätzt (Sparpläne, Einträge). Einmal im Monat mit dem Trade-Republic-Auszug abgleichen."));
  }
  if (!rows.some((r) => r.regeln && Object.keys(r.regeln).length)) {
    view.appendChild(el("p", "note", "Noch keine eigenen Marken gesetzt — gemeldet werden große Tagesbewegungen und nahe Termine."));
  }

  // Kauf / Verkauf: schwebender Knopf, Formular als Blatt von unten
  let fab = $("fab");
  if (!fab) {
    fab = el("button", "fab");
    fab.id = "fab";
    fab.type = "button";
    fab.setAttribute("aria-label", "Kauf oder Verkauf eintragen");
    fab.appendChild(svgIcon("M12 5v14M5 12h14"));
    fab.addEventListener("click", () => openTradeSheet());
    document.body.appendChild(fab);
  }
  fab.hidden = state.view !== "depot" || $("app").hidden;
}

/** "Genauer hinschauen": deine Aktien nach Dringlichkeit — aus Fakten, nicht aus Prognosen.
 *  Punkte: gelbe Lage-Signale, Zahlen in ≤ 7 Tagen, letzter KI-Check "Risiko", großer Tagesausschlag. */
function hinschauenKarte(aktien) {
  const liste = aktien.map((r) => {
    const gruende = [];
    let punkte = 0;
    for (const sg of r.signale || []) {
      if (sg.ton === "achtung") { punkte += 2; gruende.push(sg.kurz); }
    }
    if (r.termin) {
      const tage = daysUntil(r.termin);
      if (tage >= 0 && tage <= 7) { punkte += 1; gruende.push(`Zahlen ${inDays(r.termin)}`); }
    }
    const check = state.feed.checks?.payload?.checks?.[r.ticker]?.[0];
    if (check?.label === "Risiko") { punkte += 2; gruende.push("KI-Check: Risiko"); }
    if (r.tag_pct != null && Math.abs(r.tag_pct) >= 5) { punkte += 1; gruende.push(`heute ${fmtPct(r.tag_pct)}`); }
    return { r, punkte, gruende };
  }).filter((x) => x.punkte > 0).sort((a, b) => b.punkte - a.punkte);

  const card = el("div", "card fokus");
  card.appendChild(el("div", "hero-label", "Genauer hinschauen"));
  if (!liste.length) {
    card.appendChild(el("p", "chart-sub", "Alles ruhig — keine deiner Aktien zeigt gerade ein Warnsignal."));
    return card;
  }
  for (const { r, gruende } of liste.slice(0, 4)) {
    const zeile = el("div", "fokus-zeile");
    add(zeile, el("span", "fokus-name", r.name), el("span", "fokus-grund", gruende.join(" · ")));
    zeile.addEventListener("click", () => state.aktieOeffnen[r.ticker]?.());
    card.appendChild(zeile);
  }
  card.appendChild(el("p", "sig-hinweis", "Sortiert nach Warnsignalen, nahen Zahlen und KI-Lage — kein Verkaufsrat."));
  return card;
}

function svgIcon(d) {
  const s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  s.appendChild(svg("path", { d }));
  return s;
}

/** Eine Position als aufklappbare Zeile: oben das Wichtigste, aufgeklappt die Details. */
function positionRow(r, mitTermin) {
  const row = el("div", "pos-row");
  row.dataset.ticker = r.ticker;
  const s = el("div", "pos-sum tippbar");
  const anteil = state.depotWert && r.wert_eur != null ? r.wert_eur / state.depotWert : null;
  const line2 = [r.ticker, anteil != null ? fmtShare(anteil) : null,
    mitTermin && r.termin ? `${r.termin_art || "Termin"} ${inDays(r.termin)}` : null].filter(Boolean).join(" · ");
  add(s, el("div", "pos-name", r.name), el("div", "pos-value", fmtEur(r.wert_eur)),
    el("div", "pos-line2", line2), el("div", `pos-pct ${trend(r.gewinn_pct)}`, fmtPct(r.gewinn_pct)));
  // Lage-Signale (neutral): kurz an der Zeile, ausführlich beim Aufklappen
  const signale = r.signale || [];
  if (signale.length || (r.radar_brille && r.radar_brille.score >= 45)) {
    const chips = el("div", "sig-row");
    if (r.radar_brille && r.radar_brille.score >= 45) chips.appendChild(el("span", "sig gut", `Radar ${r.radar_brille.score} · wie ein Pick`));
    for (const sg of signale) chips.appendChild(el("span", `sig ${sg.ton === "achtung" ? "achtung" : ""}`, sg.kurz));
    s.appendChild(chips);
  }
  if (anteil != null) {
    const track = el("div", "pos-share");
    const bar = el("span");
    bar.style.width = `${Math.max(1, Math.min(100, anteil * 100))}%`;
    track.appendChild(bar);
    s.appendChild(track);
  }
  row.appendChild(s);

  const d = el("div", "pos-detail");
  const chartBox = el("div", "aktien-chart");
  d.appendChild(chartBox);
  // Tippen öffnet die eigene Seite der Aktie (Chart oben, wie bei Trade Republic)
  const oeffnen = () => openAktieSheet(r, d, chartBox);
  state.aktieOeffnen[r.ticker] = oeffnen;
  s.addEventListener("click", (e) => { e.preventDefault(); oeffnen(); });
  const grid = el("div", "pos-grid");
  add(grid,
    cell("heute", fmtPct(r.tag_pct), trend(r.tag_pct)),
    cell("Einstand", fmtEur(r.einstand_eur), ""),
    mitTermin
      ? cell(r.termin_art ? `nächste ${r.termin_art}` : "nächster Termin", r.termin ? fmtDay(r.termin) : "—", "")
      : cell("Kurs", fmtEur(r.kurs_eur), ""));
  d.appendChild(grid);
  const rb = r.radar_brille;
  if (rb) {
    const box = el("div", "sig-box brille");
    const kopf = el("div", "brille-kopf");
    add(kopf, el("span", "check-title", "Radar-Brille · wie bei den Kaufideen"), el("span", "brille-wert", `${rb.score}/100`));
    const bar = el("div", "brille-bar");
    const fill = el("span", rb.score >= 45 ? "gut" : "");
    fill.style.width = `${Math.max(2, rb.score)}%`;
    bar.appendChild(fill);
    add(box, kopf, bar, el("p", "sig-text", rb.text));
    d.appendChild(box);
  }
  if (signale.length) {
    const box = el("div", "sig-box");
    box.appendChild(el("div", "check-title", "Lage-Signale"));
    for (const sg of signale) box.appendChild(el("p", `sig-text ${sg.ton === "achtung" ? "achtung" : ""}`, sg.text));
    box.appendChild(el("p", "sig-hinweis", "Neutrale Hinweise aus Kursverlauf und Einstand — kein Verkaufsrat. Die Entscheidung liegt bei dir."));
    d.appendChild(box);
  }
  if (r.sparplan) {
    const tage = (r.sparplan.tage || []).map((t) => `${t}.`).join(" & ");
    const neu = r.sparplan_neu ? ` · ${r.sparplan_neu} Ausführung(en) seit Auszug eingerechnet (geschätzt)` : "";
    d.appendChild(el("p", "pos-note", `Sparplan ${fmtEur(r.sparplan.betrag_eur)} am ${tage}${neu}`));
  }
  if (r.app_eintraege) d.appendChild(el("p", "pos-note", `inkl. ${r.app_eintraege} Eintrag/Einträge aus der App`));
  const checks = state.feed.checks?.payload?.checks?.[r.ticker] || [];
  if (checks.length) d.appendChild(checkBlock(checks[0], checks.length - 1));
  return row;
}

/** Eigene Seite je Aktie: Chart groß oben, darunter Zahlen, Radar-Brille, Signale, KI-Check. */
function openAktieSheet(r, inhalt, chartBox) {
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet aktie-sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", r.name);
  const close = () => { back.remove(); sheet.remove(); };
  back.addEventListener("click", close);
  const head = el("div", "sheet-head");
  const titel = el("div");
  add(titel, el("h2", null, r.name), el("div", "pos-line2", [r.ticker, r.wert_eur != null ? `${fmtEur(r.wert_eur)} im Depot` : null, r.gewinn_pct != null ? `${fmtPct(r.gewinn_pct)} seit Einstand` : null].filter(Boolean).join(" · ")));
  const x = el("button", "icon-btn", "×");
  x.type = "button";
  x.setAttribute("aria-label", "Schließen");
  x.addEventListener("click", close);
  const knoepfe = el("div", "sheet-knoepfe");
  add(knoepfe, claudePunkt({ art: "aktie", ticker: r.ticker, name: r.name, r }, close), x);
  add(head, titel, knoepfe);
  add(sheet, el("div", "sheet-grip"), head, inhalt);
  document.body.append(back, sheet);
  aktienChart(chartBox, r);
}

// --------------------------------------------------------------------------- //
// Kurs-Chart je Aktie (wie bei Trade Republic): Zeitraum wählen, Finger drauf = Kurs
// --------------------------------------------------------------------------- //
const CHART_ZEITRAEUME = [["1T", "1T", 0], ["1W", "1W", 0], ["1M", "1J", 31], ["6M", "1J", 183], ["1J", "1J", 0], ["5J", "5J", 0]];

function chartPunkte(ticker, zeitraum) {
  const daten = state.feed.charts?.payload?.ticker?.[ticker];
  if (!daten) return null;
  const [, quelle, tage] = CHART_ZEITRAEUME.find(([k]) => k === zeitraum);
  let pts = daten[quelle] || [];
  if (tage && pts.length) {
    const grenze = pts[pts.length - 1][0] - tage * 86400000;
    pts = pts.filter(([t]) => t >= grenze);
  }
  return pts;
}

function aktienChart(box, r) {
  box.replaceChildren();
  const zeitraum = state.chartZeitraum || "1M";
  let pts = chartPunkte(r.ticker, zeitraum);
  if (!pts) {
    box.appendChild(el("p", "chart-sub", "Kursverlauf kommt mit dem nächsten Depot-Lauf (Mo–Fr stündlich)."));
    return;
  }
  pts = pts.slice();
  // Live-Kurs als letzter Punkt (wenn frischer als der letzte gespeicherte)
  if (state.live?.ok && r.kurs_eur != null && (zeitraum === "1T" || zeitraum === "1W")) {
    const jetzt = Date.now();
    if (!pts.length || jetzt - pts[pts.length - 1][0] > 5 * 60000) pts.push([jetzt, r.kurs_eur]);
  }
  if (pts.length < 2) {
    box.appendChild(el("p", "chart-sub", "Für diesen Zeitraum gibt es noch keine Kurse."));
  }
  const kopf = el("div", "ac-kopf");
  const wert = el("div", "ac-wert num");
  const diff = el("div", "ac-diff");
  add(kopf, wert, diff);
  const holder = el("div", "ac-holder");
  const seg = el("div", "range-seg ac-seg");
  for (const [k] of CHART_ZEITRAEUME) {
    const b = el("button", k === zeitraum ? "is-active" : "", k);
    b.type = "button";
    b.addEventListener("click", (e) => { e.preventDefault(); state.chartZeitraum = k; aktienChart(box, r); });
    seg.appendChild(b);
  }
  add(box, kopf, holder, seg);
  if (pts.length < 2) return;

  const start = pts[0][1], ende = pts[pts.length - 1][1];
  const zeigeKopf = (kurs, t) => {
    wert.textContent = fmtEur(kurs);
    const d = kurs - start, p = (kurs / start - 1) * 100;
    diff.textContent = `${d >= 0 ? "+" : "−"}${fmtEur(Math.abs(d))} (${fmtPct(p)})` + (t ? ` · ${zeitText(t, zeitraum)}` : ` · ${zeitraum}`);
    diff.className = `ac-diff ${trend(d)}`;
  };
  zeigeKopf(ende, null);

  requestAnimationFrame(() => {
    const W = Math.max(260, holder.clientWidth || 300), H = 170, pad = 8;
    const werte = pts.map((p) => p[1]);
    const lo = Math.min(...werte), hi = Math.max(...werte);
    const x = (i) => (i / (pts.length - 1)) * W;
    const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo || 1));
    const farbe = ende >= start ? "var(--up)" : "var(--down)";
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "ac-svg" });
    const linie = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    const grad = `g${r.ticker.replace(/[^A-Za-z0-9]/g, "")}`;
    const defs = svg("defs");
    const lg = svg("linearGradient", { id: grad, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.appendChild(svg("stop", { offset: "0", "stop-color": farbe, "stop-opacity": "0.22" }));
    lg.appendChild(svg("stop", { offset: "1", "stop-color": farbe, "stop-opacity": "0" }));
    defs.appendChild(lg);
    root.appendChild(defs);
    root.appendChild(svg("path", { d: `${linie}L${W},${H}L0,${H}Z`, fill: `url(#${grad})` }));
    // Startlinie (gestrichelt) wie bei TR: Bezugspunkt des Zeitraums
    root.appendChild(svg("line", { x1: 0, x2: W, y1: y(start), y2: y(start), class: "ac-start" }));
    root.appendChild(svg("path", { d: linie, fill: "none", stroke: farbe, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const cross = svg("line", { y1: 0, y2: H, class: "ac-cross", visibility: "hidden" });
    const dot = svg("circle", { r: 4.5, fill: farbe, stroke: "var(--surface-2)", "stroke-width": 2, visibility: "hidden" });
    add(root, cross, dot);
    const zeige = (clientX) => {
      const rect = root.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((clientX - rect.left) / rect.width) * (pts.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(pts[i][1]));
      cross.setAttribute("visibility", "visible"); dot.setAttribute("visibility", "visible");
      zeigeKopf(pts[i][1], pts[i][0]);
    };
    const weg = () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); zeigeKopf(ende, null); };
    root.addEventListener("pointerdown", (e) => zeige(e.clientX));
    root.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "mouse") zeige(e.clientX); });
    root.addEventListener("pointerup", weg);
    root.addEventListener("pointerleave", weg);
    root.addEventListener("touchmove", (e) => { e.preventDefault(); zeige(e.touches[0].clientX); }, { passive: false });
    root.addEventListener("touchend", weg);
    holder.appendChild(root);
  });
}

function zeitText(t, zeitraum) {
  const d = new Date(t);
  if (zeitraum === "1T") return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) + " Uhr";
  if (zeitraum === "1W") return d.toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function openTradeSheet() {
  const positions = (state.feed.depot?.payload?.rows || []).filter((r) => r.art === "position");
  const back = el("div", "sheet-backdrop");
  const sheet = el("div", "sheet");
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Kauf oder Verkauf eintragen");
  const close = () => { back.remove(); sheet.remove(); };
  back.addEventListener("click", close);
  const head = el("div", "sheet-head");
  const x = el("button", "icon-btn", "×");
  x.type = "button";
  x.setAttribute("aria-label", "Schließen");
  x.addEventListener("click", close);
  add(head, el("h2", null, "Eintragen"), x);
  add(sheet, el("div", "sheet-grip"), head, tradeForm(positions, close));
  document.body.append(back, sheet);
}

// --------------------------------------------------------------------------- //
// Verlauf: Depotwert und Einstand über die Zeit (eine y-Achse, beides in €)
// --------------------------------------------------------------------------- //
const RANGES = [["1W", 7], ["1M", 31], ["3M", 92], ["Max", 0]];
const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function verlaufPunkte() {
  const tage = RANGES.find(([k]) => k === state.range)?.[1] || 0;
  if (!tage) return state.verlauf;
  const grenze = new Date(Date.now() - tage * 86400000).toISOString().slice(0, 10);
  const pts = state.verlauf.filter((p) => p.datum >= grenze);
  return pts.length > 1 ? pts : state.verlauf.slice(-2);
}

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < hi) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function verlaufCard() {
  const card = el("div", "card chart-card");
  const pts = verlaufPunkte();
  const last = pts[pts.length - 1];
  const head = el("div", "chart-head");
  const titel = el("div");
  add(titel, el("div", "hero-label", "Verlauf"),
    el("p", "pos-note chart-sub", `Depotwert ${fmtEur(last.wert)} · eingezahlt ${fmtEur(last.einstand)}`));
  const seg = el("div", "range-seg");
  for (const [key] of RANGES) {
    const b = el("button", key === state.range ? "is-active" : "", key);
    b.type = "button";
    b.setAttribute("aria-pressed", String(key === state.range));
    b.addEventListener("click", () => { state.range = key; renderDepot(); });
    seg.appendChild(b);
  }
  add(head, titel, seg);

  const legend = el("div", "chart-legend");
  for (const [cls, text] of [["k-wert", "Depotwert"], ["k-einstand", "Eingezahlt (Einstand)"]]) {
    const item = el("span", "legend-item");
    add(item, el("span", `legend-key ${cls}`), document.createTextNode(text));
    legend.appendChild(item);
  }

  const holder = el("div", "chart-holder");
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  holder.appendChild(tip);
  add(card, head, legend, holder, verlaufTabelle(pts));
  requestAnimationFrame(() => drawVerlauf(holder, tip, pts));
  return card;
}

function drawVerlauf(holder, tip, pts) {
  holder.querySelector("svg")?.remove();
  const W = Math.max(280, holder.clientWidth || 320);
  const H = 150;
  const pad = { l: 42, r: 66, t: 8, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const werte = pts.flatMap((p) => [p.wert, p.einstand]);
  const ticks = niceTicks(Math.min(...werte), Math.max(...werte), 3);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const x = (i) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", tabindex: "0",
    "aria-label": `Verlauf: Depotwert ${fmtEur(pts[pts.length - 1].wert)}, eingezahlt ${fmtEur(pts[pts.length - 1].einstand)}` });

  for (const t of ticks) {
    root.appendChild(svg("line", { x1: pad.l, x2: pad.l + iw, y1: y(t), y2: y(t), class: "grid" }));
    const lab = svg("text", { x: pad.l - 6, y: y(t) + 4, "text-anchor": "end", class: "axis" });
    lab.textContent = eur0.format(t).replace(/\s?€/, "");
    root.appendChild(lab);
  }
  const xl = (i, anchor) => {
    const t = svg("text", { x: x(i), y: H - 6, "text-anchor": anchor, class: "axis" });
    t.textContent = fmtDay(pts[i].datum);
    root.appendChild(t);
  };
  xl(0, "start");
  if (pts.length > 2) xl(Math.floor((pts.length - 1) / 2), "middle");
  xl(pts.length - 1, "end");

  const linie = (key) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  root.appendChild(svg("path", { d: `${linie("wert")}L${x(pts.length - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`, class: "area-wert" }));
  root.appendChild(svg("path", { d: linie("einstand"), class: "line-einstand" }));
  root.appendChild(svg("path", { d: linie("wert"), class: "line-wert" }));

  // Werte am Linienende (Text in Text-Farbe, nie in der Serienfarbe)
  const n = pts.length - 1;
  let yW = y(pts[n].wert), yE = y(pts[n].einstand);
  const ankerW = yW, ankerE = yE;
  if (Math.abs(yW - yE) < 14) {
    if (yW <= yE) { yW -= (14 - (yE - yW)) / 2; yE = yW + 14; } else { yE -= (14 - (yW - yE)) / 2; yW = yE + 14; }
    root.appendChild(svg("line", { x1: x(n) + 2, y1: ankerW, x2: x(n) + 8, y2: yW, class: "leader" }));
    root.appendChild(svg("line", { x1: x(n) + 2, y1: ankerE, x2: x(n) + 8, y2: yE, class: "leader" }));
  }
  for (const [key, yy, cls] of [["wert", yW, "end-label strong"], ["einstand", yE, "end-label"]]) {
    const t = svg("text", { x: x(n) + 10, y: yy + 4, class: cls });
    t.textContent = eur0.format(pts[n][key]);
    root.appendChild(t);
  }
  root.appendChild(svg("circle", { cx: x(n), cy: ankerW, r: 4, class: "dot-wert" }));

  // Fadenkreuz: rastet auf den nächsten Tag ein, zeigt beide Werte
  const cross = svg("line", { y1: pad.t, y2: pad.t + ih, class: "cross", visibility: "hidden" });
  const dW = svg("circle", { r: 4, class: "dot-wert", visibility: "hidden" });
  const dE = svg("circle", { r: 4, class: "dot-einstand", visibility: "hidden" });
  const hit = svg("rect", { x: pad.l, y: 0, width: iw, height: H, fill: "transparent" });
  add(root, cross, dE, dW, hit);
  let idx = n;
  const zeige = (i) => {
    idx = Math.max(0, Math.min(n, i));
    const p = pts[idx];
    for (const [node, attr] of [[cross, ["x1", "x2"]], [dW, ["cx"]], [dE, ["cx"]]]) {
      for (const a of attr) node.setAttribute(a, x(idx));
      node.setAttribute("visibility", "visible");
    }
    dW.setAttribute("cy", y(p.wert));
    dE.setAttribute("cy", y(p.einstand));
    tip.replaceChildren();
    const diff = p.wert - p.einstand;
    add(tip, el("div", "tip-date", new Date(`${p.datum}T00:00:00`).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })),
      tipRow("k-wert", fmtEur(p.wert), "Depotwert"),
      tipRow("k-einstand", fmtEur(p.einstand), "Eingezahlt"),
      el("div", `tip-diff ${trend(diff)}`, `${diff >= 0 ? "+" : "−"}${fmtEur(Math.abs(diff))} Gewinn`));
    tip.hidden = false;
    const tx = x(idx) + 12;
    tip.style.left = `${Math.min(tx, W - tip.offsetWidth - 4)}px`;
    if (tx + tip.offsetWidth > W - 4) tip.style.left = `${Math.max(4, x(idx) - tip.offsetWidth - 12)}px`;
  };
  const verstecke = () => {
    for (const node of [cross, dW, dE]) node.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  const ausZeiger = (e) => {
    const r = root.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width);
    zeige(Math.round(((px - pad.l) / iw) * n));
  };
  hit.addEventListener("pointermove", ausZeiger);
  hit.addEventListener("pointerdown", ausZeiger);
  hit.addEventListener("pointerleave", verstecke);
  root.addEventListener("focus", () => zeige(idx));
  root.addEventListener("blur", verstecke);
  root.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); zeige(idx - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); zeige(idx + 1); }
  });
  holder.insertBefore(root, tip);
}

function tipRow(cls, wert, label) {
  const row = el("div", "tip-row");
  add(row, el("span", `legend-key ${cls}`), el("b", null, wert), el("span", "muted", label));
  return row;
}

function verlaufTabelle(pts) {
  const det = el("details", "chart-table");
  det.appendChild(el("summary", null, "Werte als Tabelle"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["Datum", "Depotwert", "Eingezahlt", "Gewinn"]) head.appendChild(el("th", null, h));
  table.appendChild(head);
  for (const p of [...pts].reverse()) {
    const tr = el("tr");
    add(tr, el("td", null, fmtDay(p.datum)), el("td", null, fmtEur(p.wert)),
      el("td", null, fmtEur(p.einstand)), el("td", trend(p.wert - p.einstand), fmtEur(p.wert - p.einstand)));
    table.appendChild(tr);
  }
  det.appendChild(table);
  return det;
}

const ANLASS = { vor: "vor dem Termin", nach: "nach dem Termin", bewegung: "starke Kursbewegung", woche: "Wochen-Check", aenderung: "Lage geändert" };

/** Neuester KI-Depot-Check zu einer Position: Lage-Einordnung, kein Kauf-/Verkaufsrat. */
function checkBlock(c, aeltere) {
  const lbl = (c.label || "").toLowerCase();
  const box = el("div", `check ${lbl}`);
  const head = el("div", "check-head");
  add(head,
    el("span", "check-title", `KI-Depot-Check · ${ANLASS[c.anlass] || c.anlass} · ${fmtDay(c.erstellt)}`),
    c.label ? el("span", `label ${lbl}`, c.label) : null);
  add(box, head, el("div", null, c.kurz));
  if (c.text) {
    const det = el("details");
    add(det, el("summary", "mehr", aeltere ? `Ganze Einordnung (+${aeltere} ältere)` : "Ganze Einordnung"),
      el("p", null, c.text));
    box.appendChild(det);
  }
  return box;
}

// --------------------------------------------------------------------------- //
// Kauf / Verkauf eintragen (Tabelle catalyst_trades — nur dein Konto darf schreiben)
// --------------------------------------------------------------------------- //
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function field(label, input) {
  const l = el("label", "field");
  add(l, el("span", null, label), input);
  return l;
}

function input(type, attrs = {}) {
  const i = document.createElement("input");
  i.type = type;
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v);
  return i;
}

async function liveKurs(ticker) {
  try {
    const { data } = await client.functions.invoke("kurse", { body: { tickers: [ticker] } });
    return data?.kurse?.[ticker]?.price_eur ?? null;
  } catch { return null; }
}

function tradeForm(positions, onDone) {
  const f = { art: "kauf", ticker: positions[0]?.ticker || "", name: positions[0]?.name || "", typ: positions[0]?.typ || "aktie" };
  const card = el("form", "trade-form");

  // Kauf | Verkauf
  const seg = el("div", "seg");
  for (const [wert, text] of [["kauf", "Kauf"], ["verkauf", "Verkauf"]]) {
    const b = el("button", `seg-btn${wert === f.art ? " is-active" : ""}`, text);
    b.type = "button";
    b.addEventListener("click", () => {
      f.art = wert;
      for (const x of seg.children) x.classList.toggle("is-active", x === b);
    });
    seg.appendChild(b);
  }
  card.appendChild(seg);

  // Wertpapier: vorhandene Position oder neu suchen
  const sel = document.createElement("select");
  for (const r of positions) {
    const o = el("option", null, `${r.name} (${r.ticker})`);
    o.value = r.ticker;
    sel.appendChild(o);
  }
  const neuOpt = el("option", null, "Neue Aktie / ETF suchen …");
  neuOpt.value = "__neu__";
  sel.appendChild(neuOpt);
  card.appendChild(field("Wertpapier", sel));

  const neuBox = el("div", "neu-box");
  neuBox.hidden = positions.length > 0;
  const q = input("search", { placeholder: "Name, z. B. Rheinmetall", autocomplete: "off" });
  const qBtn = el("button", "ghost", "Suchen");
  qBtn.type = "button";
  const treffer = el("div", "treffer");
  const qRow = el("div", "row");
  add(qRow, q, qBtn);
  add(neuBox, qRow, treffer);
  card.appendChild(neuBox);

  const betrag = input("number", { min: "0.01", step: "0.01", inputmode: "decimal", placeholder: "z. B. 500", required: "" });
  const kurs = input("number", { min: "0.0001", step: "any", inputmode: "decimal", placeholder: "Kurs je Stück in €", required: "" });
  const datum = input("date", { value: todayIso(), max: todayIso(), required: "" });
  const stueck = el("p", "pos-note", "");
  add(card, field("Betrag (€)", betrag), field("Kurs (€ je Stück)", kurs), field("Datum", datum), stueck);

  const updateStueck = () => {
    const b = parseFloat(betrag.value), k = parseFloat(kurs.value);
    stueck.textContent = b > 0 && k > 0 ? `= ${(b / k).toLocaleString("de-DE", { maximumFractionDigits: 6 })} Stück` : "";
  };
  betrag.addEventListener("input", updateStueck);
  kurs.addEventListener("input", updateStueck);

  const setKurs = async (ticker) => {
    const vorhanden = positions.find((r) => r.ticker === ticker)?.kurs_eur;
    const k = vorhanden ?? await liveKurs(ticker);
    if (k) { kurs.value = k.toFixed(k < 10 ? 4 : 2); updateStueck(); }
  };

  sel.addEventListener("change", () => {
    neuBox.hidden = sel.value !== "__neu__";
    if (sel.value === "__neu__") { f.ticker = ""; q.focus(); return; }
    const r = positions.find((x) => x.ticker === sel.value);
    Object.assign(f, { ticker: r.ticker, name: r.name, typ: r.typ || "aktie" });
    setKurs(r.ticker);
  });

  const suchen = async () => {
    treffer.replaceChildren(el("p", "pos-note", "Suche …"));
    const { data, error } = await client.functions.invoke("kurse", { body: { suche: q.value.trim() } });
    treffer.replaceChildren();
    if (error || !data?.treffer?.length) { treffer.appendChild(el("p", "pos-note", "Nichts gefunden.")); return; }
    for (const t of data.treffer) {
      const b = el("button", "treffer-btn");
      b.type = "button";
      add(b, el("b", null, t.name), el("span", "pos-ticker", `${t.ticker} · ${t.boerse}${t.typ === "etf" ? " · ETF" : ""}`));
      b.addEventListener("click", () => {
        Object.assign(f, { ticker: t.ticker, name: t.name, typ: t.typ });
        treffer.replaceChildren(el("p", "pos-note", `Ausgewählt: ${t.name} (${t.ticker})`));
        setKurs(t.ticker);
      });
      treffer.appendChild(b);
    }
  };
  qBtn.addEventListener("click", suchen);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); suchen(); } });

  const err = el("p", "error");
  err.hidden = true;
  const save = el("button", "primary", "Speichern");
  save.type = "submit";
  add(card, save, err);

  card.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    const b = parseFloat(betrag.value), k = parseFloat(kurs.value);
    if (!f.ticker) { err.textContent = "Bitte ein Wertpapier wählen bzw. suchen."; err.hidden = false; return; }
    if (!(b > 0) || !(k > 0)) { err.textContent = "Betrag und Kurs müssen größer als 0 sein."; err.hidden = false; return; }
    save.disabled = true;
    save.textContent = "Wird gespeichert …";
    const { error } = await client.from("catalyst_trades").insert({
      art: f.art, ticker: f.ticker, name: f.name, typ: f.typ,
      betrag_eur: b, kurs_eur: k, datum: datum.value || todayIso(),
    });
    save.disabled = false;
    save.textContent = "Speichern";
    if (error) { err.textContent = `Speichern fehlgeschlagen: ${error.message}`; err.hidden = false; return; }
    onDone?.();
    await load();
  });

  if (f.ticker) setKurs(f.ticker);
  return card;
}

function tradeList() {
  const box = el("details", "ledger einträge");
  const sum = el("summary");
  add(sum, el("span", null, `Deine Einträge (${state.trades.length})`), el("span", "mehr", "Anzeigen"));
  box.appendChild(sum);
  const seit = state.feed.depot ? new Date(state.feed.depot.updated_at) : null;
  for (const t of [...state.trades].reverse()) {
    const item = el("div", "trade-item");
    const txt = el("div");
    const stk = (t.betrag_eur / t.kurs_eur).toLocaleString("de-DE", { maximumFractionDigits: 4 });
    add(txt,
      el("time", null, `${fmtDay(t.datum)} · ${t.art === "kauf" ? "Kauf" : "Verkauf"}`),
      el("div", null, `${t.name || t.ticker}: ${fmtEur(t.betrag_eur)} zu ${fmtEur(t.kurs_eur)} (${stk} Stk.)`));
    if (seit && new Date(t.created_at) > seit) txt.appendChild(el("small", "muted", "schon eingerechnet — Catalyst übernimmt es beim nächsten Lauf"));
    const del = el("button", "icon-btn small", "×");
    del.type = "button";
    del.title = "Eintrag löschen";
    del.addEventListener("click", async () => {
      if (!confirm(`Eintrag löschen?
${t.name || t.ticker}, ${fmtEur(t.betrag_eur)}`)) return;
      const { error } = await client.from("catalyst_trades").delete().eq("id", t.id);
      if (error) { showError(`Löschen fehlgeschlagen: ${error.message}`); return; }
      await load();
    });
    add(item, txt, del);
    box.appendChild(item);
  }
  return box;
}

/** Einträge, die nach dem letzten Catalyst-Lauf dazukamen, sofort selbst einrechnen
 *  (dieselbe Logik wie depot_watch.apply_trades). */
function applyLocalTrades() {
  const entry = state.feed.depot;
  const p = entry?.payload;
  if (!p) return;
  const seit = new Date(entry.updated_at);
  const rows = p.rows || (p.rows = []);
  const neu = state.trades.filter((t) => new Date(t.created_at) > seit && (!p.stand || t.datum > p.stand));
  for (const t of neu) {
    const stk = t.betrag_eur / t.kurs_eur;
    let r = rows.find((x) => x.art === "position" && x.ticker === t.ticker);
    let delta = 0;
    if (t.art === "kauf") {
      if (!r) {
        r = { art: "position", typ: t.typ || "aktie", ticker: t.ticker, name: t.name || t.ticker,
          stueck: 0, einstand_eur: 0, kurs_eur: t.kurs_eur, tag_pct: null, regeln: {} };
        rows.push(r);
      }
      r.stueck = (r.stueck || 0) + stk;
      r.einstand_eur = (r.einstand_eur || 0) + t.betrag_eur;
      delta = -t.betrag_eur;
    } else if (t.art === "verkauf" && r) {
      const vorher = r.stueck || 0;
      const weg = Math.min(stk, vorher);
      if (vorher > 0) r.einstand_eur = (r.einstand_eur || 0) * (1 - weg / vorher);
      r.stueck = vorher - weg;
      delta = weg * t.kurs_eur;
      if (r.stueck <= 1e-9) rows.splice(rows.indexOf(r), 1);
    } else continue;
    r.app_eintraege = (r.app_eintraege || 0) + 1;
    if (r.kurs_eur != null && r.stueck) {
      r.wert_eur = r.kurs_eur * r.stueck;
      r.gewinn_pct = r.einstand_eur ? (r.wert_eur / r.einstand_eur - 1) * 100 : null;
    }
    if (p.cash && p.cash.eur != null) { p.cash.eur += delta; p.cash.geschaetzt = true; }
  }
}

/** Mit Live-Kursen: heutiger Punkt der Kurve = aktueller Depotwert (nur an Börsentagen). */
function livePunkt() {
  if (!state.live?.ok || !state.verlauf.length) return;
  const heute = new Date();
  if (heute.getDay() === 0 || heute.getDay() === 6) return;
  const pos = (state.feed.depot?.payload?.rows || []).filter((r) => r.art === "position");
  if (!pos.length || pos.some((r) => r.wert_eur == null)) return;
  const punkt = { datum: todayIso(), wert: pos.reduce((s, r) => s + r.wert_eur, 0),
    einstand: pos.reduce((s, r) => s + (r.einstand_eur || 0), 0) };
  const i = state.verlauf.findIndex((p) => p.datum === punkt.datum);
  if (i >= 0) state.verlauf[i] = punkt; else state.verlauf.push(punkt);
}

// --------------------------------------------------------------------------- //
// Live-Kurse (Supabase-Funktion "kurse") — rechnet Werte mit aktuellen Kursen neu.
// Fällt die Funktion aus, bleiben einfach die Werte des letzten Catalyst-Laufs stehen.
// --------------------------------------------------------------------------- //
async function applyLiveQuotes() {
  const entry = state.feed.depot;
  const rows = entry?.payload?.rows || [];
  const tickers = [...new Set(rows.map((r) => r.ticker).filter(Boolean))];
  if (!tickers.length) return;
  const { data, error } = await client.functions.invoke("kurse", { body: { tickers } });
  if (error || !data?.kurse) {
    state.live = { ok: false };
    return;
  }
  for (const r of rows) {
    const q = data.kurse[r.ticker];
    if (!q || q.price_eur == null) continue;
    r.kurs_eur = q.price_eur;
    r.tag_pct = q.day_pct ?? r.tag_pct;
    if (r.art === "position" && r.stueck) {
      r.wert_eur = q.price_eur * r.stueck;
      r.gewinn_pct = r.einstand_eur ? (r.wert_eur / r.einstand_eur - 1) * 100 : null;
    }
  }
  state.live = { ok: true, zeit: data.zeit || new Date().toISOString() };
}

function cell(label, value, cls) {
  const d = el("div");
  add(d, el("small", null, label), el("b", cls, value));
  return d;
}

// --------------------------------------------------------------------------- //
// Meldungen
// --------------------------------------------------------------------------- //
const MELD_ERKLAERUNG = "Hier landet, was in deinem Depot passiert: eine Aktie bewegt sich an einem Tag um mehr als 5 %, "
  + "Quartalszahlen stehen in den nächsten 7 Tagen an, oder die KI hat einen neuen Depot-Check geschrieben. "
  + "Geprüft wird Mo–Fr stündlich.";

function meldungsTag(ts) {
  const d = new Date(ts); const h = new Date();
  const tag = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (tag(d) === tag(h)) return "Heute";
  const g = new Date(h); g.setDate(h.getDate() - 1);
  if (tag(d) === tag(g)) return "Gestern";
  return d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long" });
}

function renderMeldungen() {
  const view = $("view-meldungen");
  view.replaceChildren();
  view.appendChild(pushKarte());
  view.appendChild(el("p", "intro", MELD_ERKLAERUNG));
  if (!state.meldungen.length) {
    view.appendChild(empty("Noch keine Meldungen — es ist ruhig in deinem Depot."));
    return;
  }
  const seen = localGet(SEEN_KEY);
  let tagAlt = null, list = null;
  for (const m of state.meldungen) {
    const tag = meldungsTag(m.created_at);
    if (tag !== tagAlt) {
      view.appendChild(el("div", "msg-day", tag));
      list = el("div", "ledger msg-list");
      view.appendChild(list);
      tagAlt = tag;
    }
    const istCheck = String(m.id || "").includes(":check:");
    const neu = !seen || m.created_at > seen;
    const item = el("div", `msg${istCheck ? " k-check" : ""}${neu ? " neu" : ""}`);
    const t = el("time", null, new Date(m.created_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }));
    t.appendChild(el("span", "msg-kind", istCheck ? "KI-Depot-Check" : "Depot"));
    add(item, t, el("div", "msg-text", m.text));
    list.appendChild(item);
  }
}

// --------------------------------------------------------------------------- //
// Push-Mitteilungen einschalten
// --------------------------------------------------------------------------- //
function b64ToBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function pushMoeglich() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function istInstalliert() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

function pushKarte() {
  const card = el("div", "card push-card");
  const text = el("div", "push-text");
  const btn = el("button", "pruef-btn", "Einschalten");
  btn.type = "button";
  btn.hidden = true;
  add(card, text, btn);
  const zeige = (titel, unter, knopf) => {
    text.replaceChildren(el("div", "push-titel", titel), el("div", "push-unter", unter));
    btn.hidden = !knopf;
    if (knopf) btn.textContent = knopf;
  };

  if (!pushMoeglich()) {
    const ios = /iphone|ipad/i.test(navigator.userAgent);
    zeige("Mitteilungen aufs Handy",
      ios && !istInstalliert()
        ? "Geht auf dem iPhone nur in der installierten App: in Safari Teilen → „Zum Home-Bildschirm“, dann Catalyst von dort öffnen."
        : "Dieses Gerät bzw. dieser Browser unterstützt keine Mitteilungen.", null);
    return card;
  }
  if (Notification.permission === "denied") {
    zeige("Mitteilungen blockiert", "In den Einstellungen des Handys unter Mitteilungen → Catalyst wieder erlauben.", null);
    return card;
  }
  zeige("Mitteilungen aufs Handy", "Bei neuen Meldungen und neuen KI-Einordnungen.", null);
  navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => {
    if (sub && Notification.permission === "granted") {
      zeige("Mitteilungen sind an", "Du bekommst neue Meldungen und KI-Einordnungen aufs Handy.", "Ausschalten");
      btn.onclick = () => pushAus(sub, card);
    } else {
      zeige("Mitteilungen aufs Handy", "Bei neuen Meldungen und neuen KI-Einordnungen — sonst nichts.", "Einschalten");
      btn.onclick = () => pushAn(card);
    }
  }).catch(() => {});
  return card;
}

async function pushAn(card) {
  const ersetzen = () => card.replaceWith(pushKarte());
  try {
    const erlaubt = await Notification.requestPermission();
    if (erlaubt !== "granted") { ersetzen(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
    const j = sub.toJSON();
    const { error } = await client.from("catalyst_push_subs").insert({
      endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, geraet: navigator.userAgent.slice(0, 120),
    });
    if (error && error.code !== "23505") throw error;     // 23505 = Gerät ist schon eingetragen
    ersetzen();
  } catch (err) {
    showError(`Mitteilungen einschalten ging nicht: ${err.message || err}`);
  }
}

async function pushAus(sub, card) {
  try {
    await client.from("catalyst_push_subs").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  } catch (err) {
    showError(`Ausschalten ging nicht: ${err.message || err}`);
  }
  card.replaceWith(pushKarte());
}

function updateBadge() {
  const seen = localGet(SEEN_KEY);
  const fresh = state.meldungen.filter((m) => !seen || m.created_at > seen).length;
  const badge = $("badge");
  badge.textContent = String(fresh);
  badge.hidden = fresh === 0 || state.view === "meldungen";
}

function markSeen() {
  if (state.meldungen.length) localSet(SEEN_KEY, state.meldungen[0].created_at);
  updateBadge();
}

// --------------------------------------------------------------------------- //
// "Jetzt prüfen": Radar-Check auf GitHub anstoßen und verfolgen
// --------------------------------------------------------------------------- //
// Die Funktion "aktualisieren" startet den Check (frische Daten, geänderte Werte
// gehen an die KI) und meldet, ob er noch läuft. Danach laden wir neu; warten noch
// Werte auf die KI ("offen"), schauen wir minütlich nach, bis sie da sind.
const PRUEF_TAKT_MS = 15000;
const PRUEF_MAX_MS = 20 * 60000;
const KI_TAKT_MS = 60000;

function fmtUhr(ts) {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function pruefZeile() {
  const zeile = el("div", "pruef");
  const btn = el("button", "pruef-btn", state.pruefung.aktiv ? "Prüft …" : "Jetzt prüfen");
  btn.type = "button";
  btn.id = "pruef-btn";
  btn.disabled = state.pruefung.aktiv;
  btn.addEventListener("click", jetztPruefen);
  const text = el("span", "pruef-status", state.pruefung.text
    || "Holt frische Daten und lässt geänderte Werte neu einordnen.");
  text.id = "pruef-status";
  add(zeile, btn, text);
  return zeile;
}

function setPruefung(aktiv, text) {
  state.pruefung.aktiv = aktiv;
  state.pruefung.text = text;
  const btn = $("pruef-btn"), st = $("pruef-status");
  if (btn) { btn.disabled = aktiv; btn.textContent = aktiv ? "Prüft …" : "Jetzt prüfen"; }
  if (st) st.textContent = text;
}

async function pruefFunktion(body) {
  const { data, error } = await client.functions.invoke("aktualisieren", { body });
  if (error) throw error;
  return data || {};
}

async function jetztPruefen() {
  if (state.pruefung.aktiv) return;
  clearTimeout(state.pruefung.timer);
  setPruefung(true, "Wird gestartet …");
  try {
    const r = await pruefFunktion({});
    if (r.status === "nicht_eingerichtet") {
      setPruefung(false, "Der Knopf ist noch nicht fertig eingerichtet — bis dahin aktualisiert die Routine am PC.");
    } else if (r.status === "gerade_erst") {
      setPruefung(false, `Gerade erst geprüft (${fmtUhr(r.lauf.seit)}) — in ein paar Minuten wieder möglich.`);
    } else {
      verfolgen(r.status === "laeuft" ? new Date(r.lauf.seit).getTime() : Date.now());
    }
  } catch (err) {
    setPruefung(false, `Ging gerade nicht: ${err.message || err}`);
  }
}

function verfolgen(start) {
  setPruefung(true, "Prüft frische Daten … (dauert ca. 3–5 Min.)");
  const tick = async () => {
    if (Date.now() - start > PRUEF_MAX_MS) {
      setPruefung(false, "Dauert ungewöhnlich lange — schau später nochmal rein.");
      return;
    }
    try {
      const r = await pruefFunktion({ status: true });
      // Direkt nach dem Start zeigt GitHub kurz noch den vorigen Lauf -- weiter warten.
      const unserer = r.lauf && new Date(r.lauf.seit).getTime() >= start - 120000;
      if (r.status === "laeuft" || !unserer) {
        state.pruefung.timer = setTimeout(tick, PRUEF_TAKT_MS);
        return;
      }
      if (r.lauf.ergebnis !== "success") {
        setPruefung(false, "Der Check ist fehlgeschlagen — beim nächsten Lauf geht es weiter.");
        return;
      }
      await load();
      kiAbwarten(Date.now());
    } catch {
      state.pruefung.timer = setTimeout(tick, PRUEF_TAKT_MS);
    }
  };
  state.pruefung.timer = setTimeout(tick, PRUEF_TAKT_MS);
}

function kiAbwarten(start) {
  const offen = state.feed.radar?.payload?.offen || [];
  if (!offen.length) {
    setPruefung(false, `Fertig (${fmtUhr(Date.now())}) — alles aktuell.`);
    return;
  }
  if (Date.now() - start > PRUEF_MAX_MS) {
    setPruefung(false, "Die neue KI-Einordnung kommt mit dem nächsten Lauf.");
    return;
  }
  setPruefung(true, `Daten frisch. Die KI ordnet ${offen.length === 1 ? "einen Wert" : `${offen.length} Werte`} neu ein …`);
  state.pruefung.timer = setTimeout(async () => {
    try { await load(); } catch { /* nächster Versuch */ }
    kiAbwarten(start);
  }, KI_TAKT_MS);
}

// --------------------------------------------------------------------------- //
// Radar
// --------------------------------------------------------------------------- //
function renderRadar() {
  const view = $("view-radar");
  view.replaceChildren();
  const entry = state.feed.radar;
  const p = entry?.payload;
  view.appendChild(pruefZeile());
  if (!p) {
    view.appendChild(empty("Noch kein Tages-Radar. Er kommt mit dem nächsten Check (alle 3 Std.)."));
    return;
  }
  // Der Radar wird alle 3 Std. neu geprüft. Bleibt das aus, sagen wir es.
  const alt = (Date.now() - new Date(entry.updated_at)) / 3600000 >= RADAR_ALT_STD;
  const kopf = el("div", "radar-head");
  add(kopf, el("span", "stand", `${p.n_events ?? "?"} Events im Blick`),
    el("span", `stand radar-zeit${alt ? " alt" : ""}`, `Letzte Aktualisierung ${fmtAgo(entry.updated_at)}`));
  view.insertBefore(kopf, view.firstChild);
  if (alt && !state.pruefung.aktiv) {
    view.appendChild(el("div", "card hint", `Seit ${fmtAgo(entry.updated_at).replace("vor ", "")} keine Aktualisierung — drück auf „Jetzt prüfen“.`));
  }
  const offen = p.offen || [];
  if (offen.length) {
    const namen = offen.map((o) => o.asset || o.ticker).join(", ");
    view.appendChild(el("div", "card hint", `Wird gerade neu eingeordnet: ${namen}. Die neue KI-Meinung kommt in ein paar Minuten.`));
  }

  if (!(p.picks || []).length) view.appendChild(empty("Gerade keine eingeordneten Picks."));
  const neuestes = (p.picks || []).reduce((m, k) => (k.seit && k.seit > m ? k.seit : m), "");
  if ((p.picks || []).length) {
    view.appendChild(el("div", "section-title", "Picks"));
    const box = el("div", "ledger");
    for (const k of p.picks) box.appendChild(pickRow(k, neuestes));
    view.appendChild(box);
  }

  if ((p.exit_signals || []).length) {
    view.appendChild(el("div", "section-title", "Frühere Picks — Grund trägt nicht mehr"));
    const box = el("div", "ledger");
    for (const sig of p.exit_signals) {
      const row = el("div", "exit");
      add(row, el("div", "pick-name", sig.asset || sig.ticker), el("div", "pick-meta", (sig.reasons || []).join(" · ")));
      box.appendChild(row);
    }
    view.appendChild(box);
  }

  view.appendChild(bilanzCard());
  view.appendChild(el("p", "note", "Die Etiketten sind die Meinung eines KI-Agenten zur Nachrichtenlage — kein Kaufsignal, keine Anlageberatung, keine Kursziele."));
}

function pickRow(k, neuestes) {
  const lbl = (k.label || "").toLowerCase();
  const row = el("div", `pick ${lbl}`);
  const head = el("div", "pick-head");
  const name = el("div", "pick-name", k.asset);
  if (k.ticker) name.appendChild(el("span", "pos-ticker", k.ticker));
  const badges = el("div", "badges");
  if (k.seit && k.seit === neuestes) badges.appendChild(el("span", "tag neu", "Neu"));
  if (k.im_depot) badges.appendChild(el("span", "tag depot", "Im Depot"));
  if (k.label) badges.appendChild(el("span", `label ${lbl}`, `KI: ${k.label}`));
  badges.appendChild(claudePunkt({ art: "pick", ticker: k.ticker || k.asset, name: k.asset, k }));
  add(head, name, badges);
  const meta = `${k.typ}${k.datum ? ` · ${fmtDay(k.datum)} · ${inDays(k.datum)}` : ""}`
    + (k.seit ? ` · eingeordnet ${fmtDay(k.seit)}` : "");
  add(row, head, el("div", "pick-meta", meta));

  // Warum dabei? Neutrale Zahlen aus den gesammelten Daten
  const f = k.fakten || {};
  const facts = el("div", "facts");
  const fact = (text, cls = "") => facts.appendChild(el("span", `fact ${cls}`, text));
  if (f.spanne != null) fact(`Jahresspanne ${f.spanne} %${f.spanne <= 25 ? " · nahe Tief" : f.spanne >= 80 ? " · nahe Hoch" : ""}`);
  if (f.trend_1m != null) fact(`1 Monat ${f.trend_1m > 0 ? "+" : ""}${f.trend_1m} %`);
  if (f.trend_3m != null) fact(`3 Monate ${f.trend_3m > 0 ? "+" : ""}${f.trend_3m} %`);
  if (f.aufmerksamkeit != null) fact(`Aufmerksamkeit ${f.aufmerksamkeit < 30 ? "niedrig" : f.aufmerksamkeit > 70 ? "hoch" : "mittel"}`);
  if (k.datum && f.termin_sicher === false) fact("Termin geschätzt", "warn");
  if (facts.children.length) row.appendChild(facts);

  row.appendChild(el("div", "pick-kurz", k.kurz));
  if (k.text) {
    const det = el("details");
    add(det, el("summary", "mehr", "Ganze Einordnung"), el("p", null, k.text));
    row.appendChild(det);
  }
  return row;
}

/** Rückschau: Wie liefen eingeordnete Werte nach dem Termin — im Vergleich zum Markt? */
function bilanzCard() {
  const b = state.feed.bilanz?.payload;
  const card = el("div", "card");
  add(card, el("div", "hero-label", "Bilanz"),
    el("p", "chart-sub", "Wie liefen eingeordnete Werte in der Woche nach dem Termin — verglichen mit dem Markt (S&P 500)?"));
  if (!b || !b.n) {
    card.appendChild(el("p", "note", "Noch keine ausgewerteten Termine. Erste Ergebnisse gibt es rund eine Woche nach den nächsten Zahlen-Terminen."));
    return card;
  }
  const grid = el("div", "bilanz-grid");
  for (const lbl of ["Chance", "Neutral", "Risiko"]) {
    const x = b.labels?.[lbl] || {};
    const col = el("div", "bilanz-col");
    const vs = x.vs_markt_5;
    add(col, el("span", `label ${lbl.toLowerCase()}`, lbl),
      el("div", `bilanz-wert ${trend(vs)}`, vs == null ? "—" : `${vs > 0 ? "+" : ""}${vs.toLocaleString("de-DE")} %`),
      el("div", "bilanz-klein", x.n ? `vs. Markt · ${x.n} ${x.n === 1 ? "Fall" : "Fälle"}${x.quote_besser != null ? ` · ${x.quote_besser} % besser` : ""}` : "noch keine Fälle"));
    grid.appendChild(col);
  }
  card.appendChild(grid);
  const det = el("details");
  det.appendChild(el("summary", "mehr", `Letzte Fälle (${(b.faelle || []).length})`));
  for (const fall of b.faelle || []) {
    const r = el("div", "bilanz-fall");
    const vs = fall.vs_markt_5;
    add(r, el("span", null, `${fall.asset} · ${fmtDay(fall.termin)} · ${fall.label}`),
      el("span", trend(vs), vs == null ? "—" : `${vs > 0 ? "+" : ""}${vs.toLocaleString("de-DE")} % vs. Markt`));
    det.appendChild(r);
  }
  card.appendChild(det);
  card.appendChild(el("p", "note", `${b.aussagekraft}.`));
  return card;
}

// --------------------------------------------------------------------------- //
// Claude: Chat mit dem ganzen Depot-Wissen. Läuft über dein Claude-Abo — die App
// schreibt die Frage nach Supabase (catalyst_chat), die Chat-Brücke des Catalyst
// (auf deinem PC, sonst auf GitHub) fragt Claude und schreibt die Antwort zurück.
// Kein API-Schlüssel, keine Kosten pro Nachricht. Ohne Brücke: Link in die Claude-App.
// --------------------------------------------------------------------------- //
const CLAUDE_NEU = "https://claude.ai/new?q=";
const CLAUDE_MAX_URL = 8000;   // längere Links schneiden manche Browser ab
const GESPRAECH_KEY = "catalyst.chat.gespraech";
const CHAT_NACHFASSEN_MS = 45000;   // so lange darf der PC brauchen, bevor GitHub einspringt
const CLAUDE_ICON = "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4";

/** Der kleine orange Punkt: öffnet den Claude-Reiter mit diesem Thema. */
function claudePunkt(thema, vorher) {
  const b = el("button", "claude-dot");
  b.type = "button";
  b.setAttribute("aria-label", `Mit Claude über ${thema.name} sprechen`);
  b.title = "Mit Claude besprechen";
  b.appendChild(svgIcon(CLAUDE_ICON));
  b.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    vorher?.();
    neuesGespraech(thema);
    switchView("claude");
    $("claude-frage")?.focus();
  });
  return b;
}

function kursSeit(ticker, zeitraum) {
  const pts = chartPunkte(ticker, zeitraum);
  if (!pts || pts.length < 2) return null;
  return (pts[pts.length - 1][1] / pts[0][1] - 1) * 100;
}

function positionZeile(r, checks) {
  const anteil = state.depotWert && r.wert_eur != null ? r.wert_eur / state.depotWert : null;
  const teile = [
    `Wert ${fmtEur(r.wert_eur)}${anteil != null ? ` (${fmtShare(anteil)} des Depots)` : ""}`,
    `seit Einstand ${fmtPct(r.gewinn_pct)}`, `heute ${fmtPct(r.tag_pct)}`,
    r.einstand_eur != null ? `Einstand ${fmtEur(r.einstand_eur)}` : null,
    r.termin ? `${r.termin_art || "Termin"} am ${fmtDay(r.termin)}` : null,
    (r.signale || []).length ? `Signale: ${r.signale.map((s) => s.kurz).join(", ")}` : null,
    r.radar_brille ? `Radar-Brille ${r.radar_brille.score}/100` : null,
  ];
  const c = checks[r.ticker]?.[0];
  if (c) teile.push(`KI-Check ${fmtDay(c.erstellt)}: ${c.label || "—"} – ${c.kurz}`);
  return `- ${r.name} (${r.ticker}, ${r.typ === "etf" ? "ETF" : "Aktie"}): ${teile.filter(Boolean).join("; ")}`;
}

/** Alles, was Claude wissen soll — als Abschnitte in Wichtigkeits-Reihenfolge. */
function claudeAbschnitte(thema) {
  const rows = state.feed.depot?.payload?.rows || [];
  const pos = rows.filter((r) => r.art === "position");
  const watch = rows.filter((r) => r.art === "watchlist");
  const checks = state.feed.checks?.payload?.checks || {};
  const out = [];

  if (thema?.art === "aktie") {
    const r = pos.find((p) => p.ticker === thema.ticker) || thema.r;
    const z = [`--- Im Fokus: ${r.name} (${r.ticker}) ---`, positionZeile(r, checks).slice(2)];
    const kurse = [["1 Woche", "1W"], ["1 Monat", "1M"], ["6 Monate", "6M"], ["1 Jahr", "1J"], ["5 Jahre", "5J"]]
      .map(([n, k]) => [n, kursSeit(r.ticker, k)]).filter(([, v]) => v != null);
    if (kurse.length) z.push(`Kursentwicklung: ${kurse.map(([n, v]) => `${n} ${fmtPct(v)}`).join(", ")}`);
    if (r.radar_brille?.text) z.push(`Radar-Brille: ${r.radar_brille.text}`);
    for (const s of r.signale || []) z.push(`Lage-Signal: ${s.text}`);
    const c = checks[r.ticker]?.[0];
    if (c?.text) z.push(`Letzter KI-Check (${c.label || "—"}, ${fmtDay(c.erstellt)}): ${c.text}`);
    out.push(z.join("\n"));
  } else if (thema?.art === "pick") {
    const k = thema.k;
    const f = k.fakten || {};
    const z = [`--- Im Fokus: Radar-Pick ${k.asset}${k.ticker ? ` (${k.ticker})` : ""} ---`,
      `${k.typ}${k.datum ? ` am ${fmtDay(k.datum)}` : ""}${k.im_depot ? " · schon im Depot" : ""}`];
    const fakten = [f.spanne != null ? `Jahresspanne ${f.spanne} %` : null,
      f.trend_1m != null ? `1 Monat ${f.trend_1m} %` : null, f.trend_3m != null ? `3 Monate ${f.trend_3m} %` : null,
      f.aufmerksamkeit != null ? `Aufmerksamkeit ${f.aufmerksamkeit}/100` : null].filter(Boolean);
    if (fakten.length) z.push(`Fakten: ${fakten.join(", ")}`);
    if (k.label) z.push(`KI-Einordnung: ${k.label} – ${k.kurz || ""}`);
    if (k.text) z.push(k.text);
    out.push(z.join("\n"));
  }

  if (pos.length) {
    const cash = state.feed.depot.payload.cash;
    const kopf = `--- Mein Depot (Stand ${fmtStamp(state.feed.depot.updated_at)}) ---\nDepotwert ${fmtEur(state.depotWert)}`
      + (cash?.eur > 0 ? `, Cash ${fmtEur(cash.eur)}${cash.geschaetzt ? " (geschätzt)" : ""}` : "");
    const sortiert = [...pos].sort((a, b) => (b.wert_eur || 0) - (a.wert_eur || 0));
    out.push([kopf, ...sortiert.map((r) => positionZeile(r, checks))].join("\n"));
  }
  if (watch.length) out.push(`--- Watchlist ---\n${watch.map((r) => `- ${r.name} (${r.ticker}): ${fmtEur(r.kurs_eur)}, heute ${fmtPct(r.tag_pct)}`).join("\n")}`);

  const picks = state.feed.radar?.payload?.picks || [];
  if (picks.length) {
    out.push(`--- Radar-Picks ---\n${picks.map((k) => `- ${k.asset}${k.ticker ? ` (${k.ticker})` : ""}: ${k.typ}${k.datum ? ` am ${fmtDay(k.datum)}` : ""}${k.label ? `, KI: ${k.label} – ${k.kurz || ""}` : ""}`).join("\n")}`);
  }
  if (state.meldungen.length) {
    out.push(`--- Letzte Meldungen ---\n${state.meldungen.slice(0, 6).map((m) => `- ${fmtDay(m.created_at.slice(0, 10))} ${m.name}: ${m.text}`).join("\n")}`);
  }
  return out;
}

function claudeText(frage, thema) {
  const f = frage.trim() || (thema ? `Lass uns über ${thema.name} sprechen. Wie ist die Lage gerade, und was sollte ich im Blick haben?`
    : "Schau dir mein Depot an: Wie steht es gerade, und was sollte ich im Blick haben?");
  const vorspann = "Ich nutze meine App „Catalyst“ (Depot-Überblick und Termin-Radar). Unten steht mein aktueller Stand aus der App. "
    + "Nutze ihn als Wissen für unser Gespräch, recherchiere bei Bedarf aktuelle Nachrichten im Web und trenne klar zwischen Fakten und deiner Meinung. "
    + "Keine Anlageberatung – die Entscheidung treffe ich selbst. Antworte auf Deutsch, kurz und verständlich.";
  return { kopf: `${vorspann}\n\nMeine Frage: ${f}`, abschnitte: claudeAbschnitte(thema) };
}

/** Voller Text (für die Zwischenablage) und ein Link, der sicher in die URL passt. */
function claudeLink(frage, thema) {
  const { kopf, abschnitte } = claudeText(frage, thema);
  const voll = [kopf, ...abschnitte].join("\n\n");
  const teile = [kopf];
  for (const a of abschnitte) {
    if (encodeURIComponent([...teile, a].join("\n\n")).length + CLAUDE_NEU.length > CLAUDE_MAX_URL) break;
    teile.push(a);
  }
  if (teile.length <= abschnitte.length) teile.push("(Gekürzt – den ganzen Stand füge ich gleich ein.)");
  return { voll, url: CLAUDE_NEU + encodeURIComponent(teile.join("\n\n")) };
}

/** Fallback ohne Chat-Brücke: neuer Chat in der Claude-App, Text in der Zwischenablage. */
function inClaudeAppFragen(frage, thema) {
  const { voll, url } = claudeLink(frage, thema);
  navigator.clipboard?.writeText(voll).catch(() => {});
  window.open(url, "_blank", "noopener");
}

function neueGespraechsId() {
  return crypto.randomUUID ? crypto.randomUUID() : `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function neuesGespraech(thema = null) {
  state.chat.gespraech = neueGespraechsId();
  localSet(GESPRAECH_KEY, state.chat.gespraech);
  state.claudeThema = thema;
}

/** Alle Chat-Zeilen deines Kontos (RLS) — fehlt die Tabelle noch, bleibt der Link-Weg. */
async function chatLaden() {
  const res = await client.from("catalyst_chat").select("id,created_at,gespraech,rolle,text,thema,status,von")
    .order("created_at", { ascending: true }).limit(500);
  state.chat.bereit = !res.error;
  state.chat.zeilen = res.error ? [] : (res.data || []);
}

async function chatFunktion(body = {}) {
  try {
    const { data } = await client.functions.invoke("chat", { body });
    if (data?.pc_an != null) state.chat.pcAn = data.pc_an;
    return data || {};
  } catch { return {}; }
}

function aktuelleNachrichten() {
  return state.chat.zeilen.filter((z) => z.gespraech === state.chat.gespraech);
}

function wartetAufAntwort() {
  return aktuelleNachrichten().some((z) => z.rolle === "user" && (z.status === "offen" || z.status === "in_arbeit"));
}

/** Solange eine Frage offen ist: alle 3 s nachsehen. Antwortet der PC nicht, springt GitHub ein. */
function chatBeobachten() {
  clearTimeout(state.chat.timer);
  if (!wartetAufAntwort()) return;
  state.chat.timer = setTimeout(async () => {
    await chatLaden();
    const offen = aktuelleNachrichten().find((z) => z.rolle === "user" && z.status === "offen");
    if (offen && state.chat.weg === "pc" && Date.now() - new Date(offen.created_at) > CHAT_NACHFASSEN_MS) {
      const r = await chatFunktion({ nachfassen: true });
      if (r.weg) state.chat.weg = r.weg;
    }
    if (state.view === "claude") renderClaude();
    chatBeobachten();
  }, 3000);
}

async function chatSenden(text) {
  text = text.trim();
  if (!text || state.chat.sendet) return;
  if (!state.chat.gespraech) neuesGespraech(state.claudeThema);
  const t = state.claudeThema;
  state.chat.sendet = true;
  const { error } = await client.from("catalyst_chat").insert({
    gespraech: state.chat.gespraech, rolle: "user", text,
    thema: t ? { art: t.art, ticker: t.ticker, name: t.name } : null });
  state.chat.sendet = false;
  if (error) { state.chat.fehler = `Senden fehlgeschlagen: ${error.message}`; renderClaude(); return; }
  state.chat.fehler = "";
  await chatLaden();
  renderClaude();
  const r = await chatFunktion();
  state.chat.weg = r.weg || null;
  renderClaude();
  chatBeobachten();
}

async function gespraechLoeschen(id) {
  await client.from("catalyst_chat").delete().eq("gespraech", id);
  if (state.chat.gespraech === id) neuesGespraech();
  await chatLaden();
  renderClaude();
}

/** Claudes Antwort lesbar machen: Absätze, Listen, **fett** — alles über textContent. */
function mdBlock(text) {
  const box = el("div", "md");
  const inline = (parent, zeile) => {
    zeile.split(/(\*\*[^*]+\*\*)/g).forEach((t) => {
      if (/^\*\*[^*]+\*\*$/.test(t)) parent.appendChild(el("b", null, t.slice(2, -2)));
      else if (t) parent.appendChild(document.createTextNode(t.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")));
    });
    return parent;
  };
  let liste = null;
  for (const roh of text.split("\n")) {
    const zeile = roh.trimEnd();
    const punkt = zeile.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (punkt) {
      if (!liste) { liste = el("ul"); box.appendChild(liste); }
      liste.appendChild(inline(el("li"), punkt[1]));
      continue;
    }
    liste = null;
    if (!zeile.trim()) continue;
    const titel = zeile.match(/^#{1,4}\s+(.*)$/);
    box.appendChild(titel ? el("p", "md-titel", titel[1].replace(/\*\*/g, "")) : inline(el("p"), zeile));
  }
  return box;
}

/** Alle Gespräche, neuestes zuerst — Titel = erste Frage. */
function gespraechsListe() {
  const gruppen = new Map();
  for (const z of state.chat.zeilen) {
    if (!gruppen.has(z.gespraech)) gruppen.set(z.gespraech, { id: z.gespraech, titel: z.text, zeit: z.created_at, thema: z.thema });
    gruppen.get(z.gespraech).zeit = z.created_at;
  }
  return [...gruppen.values()].sort((a, b) => (a.zeit < b.zeit ? 1 : -1));
}

function tagesGruppe(ts) {
  const tage = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (tage <= 0) return "Heute";
  if (tage === 1) return "Gestern";
  if (tage < 7) return "Diese Woche";
  if (tage < 31) return "Diesen Monat";
  return "Älter";
}

/** Seitenleiste von links wie in der Claude-App: neuer Chat oben, darunter alle Gespräche. */
function chatLeisteOeffnen() {
  const back = el("div", "sheet-backdrop");
  const leiste = el("nav", "chat-drawer");
  leiste.setAttribute("aria-label", "Gespräche");
  const zu = () => { back.remove(); leiste.remove(); };
  back.addEventListener("click", zu);

  const neu = el("button", "drawer-neu");
  neu.type = "button";
  add(neu, svgIcon("M12 5v14M5 12h14"), el("span", null, "Neuer Chat"));
  neu.addEventListener("click", () => { zu(); neuesGespraech(); renderClaude(); $("claude-frage")?.focus(); });
  add(leiste, el("div", "drawer-titel", "Gespräche"), neu);

  const liste = gespraechsListe();
  if (!liste.length) leiste.appendChild(el("p", "note", "Noch keine Gespräche."));
  let gruppe = "";
  for (const g of liste) {
    const name = tagesGruppe(g.zeit);
    if (name !== gruppe) { gruppe = name; leiste.appendChild(el("div", "drawer-gruppe", name)); }
    const zeile = el("div", `drawer-chat${g.id === state.chat.gespraech ? " aktiv" : ""}`);
    const auf = el("button", "drawer-auf");
    auf.type = "button";
    add(auf, el("span", "drawer-name", g.titel), g.thema?.name ? el("span", "drawer-thema", g.thema.name) : null);
    auf.addEventListener("click", () => {
      zu();
      state.chat.gespraech = g.id;
      localSet(GESPRAECH_KEY, g.id);
      state.claudeThema = null;
      renderClaude();
    });
    const weg = el("button", "icon-btn small", "×");
    weg.type = "button";
    weg.setAttribute("aria-label", "Gespräch löschen");
    weg.addEventListener("click", async () => { await gespraechLoeschen(g.id); zu(); chatLeisteOeffnen(); });
    add(zeile, auf, weg);
    leiste.appendChild(zeile);
  }
  document.body.append(back, leiste);
}

/** Spracheingabe über die Spracherkennung des Browsers (Safari/Chrome) — Text landet im Feld. */
const Spracherkennung = window.SpeechRecognition || window.webkitSpeechRecognition;

function mikrofonKnopf(ta) {
  if (!Spracherkennung) return null;
  const b = el("button", "chat-mic");
  b.type = "button";
  b.setAttribute("aria-label", "Sprechen");
  b.appendChild(svgIcon("M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3"));
  let erkennung = null;
  b.addEventListener("click", () => {
    if (erkennung) { erkennung.stop(); return; }
    erkennung = new Spracherkennung();
    erkennung.lang = "de-DE";
    erkennung.interimResults = true;
    erkennung.continuous = true;
    const vorher = ta.value ? `${ta.value.trimEnd()} ` : "";
    erkennung.onresult = (e) => {
      let text = "";
      for (const r of e.results) text += r[0].transcript;
      ta.value = vorher + text;
      ta.dispatchEvent(new Event("input"));
    };
    erkennung.onend = () => { erkennung = null; b.classList.remove("hoert"); };
    erkennung.onerror = () => { erkennung = null; b.classList.remove("hoert"); };
    b.classList.add("hoert");
    erkennung.start();
  });
  return b;
}

function renderClaude() {
  const view = $("view-claude");
  const entwurf = $("claude-frage")?.value || "";
  view.replaceChildren();
  if (!state.chat.gespraech) state.chat.gespraech = localGet(GESPRAECH_KEY) || neueGespraechsId();
  const thema = state.claudeThema;
  const nachrichten = aktuelleNachrichten();

  // Kopfzeile wie in der Claude-App: links Gespräche, Mitte Titel, rechts neuer Chat
  const kopf = el("div", "chat-kopf");
  const menue = el("button", "icon-btn");
  menue.type = "button";
  menue.setAttribute("aria-label", "Gespräche");
  menue.appendChild(svgIcon("M4 7h16M4 12h16M4 17h10"));
  menue.addEventListener("click", chatLeisteOeffnen);
  const titel = el("div", "chat-titel");
  const ersteFrage = nachrichten.find((z) => z.rolle === "user")?.text;
  titel.appendChild(el("div", "chat-titel-text", ersteFrage || (thema ? thema.name : "Neuer Chat")));
  if (state.chat.bereit && state.chat.pcAn != null) {
    titel.appendChild(el("div", `chat-status${state.chat.pcAn ? " an" : ""}`,
      state.chat.pcAn ? "PC an · antwortet in Sekunden" : "PC aus · über GitHub, ca. 1 Minute"));
  }
  const neu = el("button", "icon-btn");
  neu.type = "button";
  neu.setAttribute("aria-label", "Neuer Chat");
  neu.appendChild(svgIcon("M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"));
  neu.addEventListener("click", () => { neuesGespraech(); renderClaude(); $("claude-frage")?.focus(); });
  add(kopf, menue, titel, neu);
  view.appendChild(kopf);

  if (!state.chat.bereit) {
    view.appendChild(el("div", "card hint", "Der Chat in der App ist noch nicht eingerichtet. Bis dahin öffnet „Senden“ einen neuen Chat in der Claude-App."));
  }

  // Leerer Chat: Begrüßung und Vorschläge — sonst der Verlauf
  if (!nachrichten.length) {
    const hallo = el("div", "chat-hallo");
    const logo = el("span", "claude-dot gross");
    logo.appendChild(svgIcon(CLAUDE_ICON));
    add(hallo, logo, el("h2", null, thema ? `Was willst du zu ${thema.name} wissen?` : "Wie kann ich helfen?"),
      el("p", "chart-sub", "Ich kenne dein ganzes Depot: Positionen, Einstand, Signale, Radar-Brille, KI-Checks, Picks und Meldungen."));
    view.appendChild(hallo);
  }
  const verlauf = el("div", "chat-verlauf");
  for (const z of nachrichten) {
    const blase = el("div", `blase ${z.rolle === "user" ? "du" : "claude"}${z.status === "fehler" && z.rolle === "claude" ? " fehler" : ""}`);
    if (z.rolle === "user") {
      if (z.thema?.name) blase.appendChild(el("div", "blase-thema", z.thema.name));
      blase.appendChild(el("p", null, z.text));
    } else {
      blase.appendChild(mdBlock(z.text));
      blase.appendChild(el("div", "blase-meta", `${fmtStamp(z.created_at)} · ${z.von === "github" ? "über GitHub" : "über deinen PC"}`));
    }
    verlauf.appendChild(blase);
  }
  if (wartetAufAntwort()) {
    const laeuft = nachrichten.some((z) => z.rolle === "user" && z.status === "in_arbeit");
    const wo = laeuft ? "Claude schreibt …" : state.chat.weg === "github" ? "Claude startet über GitHub – dauert etwa eine Minute …" : "Claude denkt nach …";
    const b = el("div", "blase claude denkt");
    add(b, el("span", "punkte"), el("p", null, wo));
    verlauf.appendChild(b);
  }
  if (nachrichten.length) view.appendChild(verlauf);
  if (state.chat.fehler) view.appendChild(el("div", "error banner", state.chat.fehler));

  // Eingabe unten: Vorschläge, Thema, Feld mit Mikrofon und Senden
  const box = el("form", "chat-eingabe");
  const abschicken = (text) => {
    if (!text.trim()) return;
    if (state.chat.bereit) { chatSenden(text); ta.value = ""; } else inClaudeAppFragen(text, thema);
  };
  if (!nachrichten.length) {
    const vorschlaege = thema
      ? [`Wie ist die Lage bei ${thema.name}?`, "Warum bewegt sich der Kurs gerade so?", "Was steht als Nächstes an?", "Was spricht dafür, was dagegen?"]
      : ["Wie steht mein Depot gerade?", "Wo ist mein größtes Klumpenrisiko?", "Was steht diese Woche an?", "Erklär mir die aktuellen Picks"];
    const chips = el("div", "claude-chips");
    for (const v of vorschlaege) {
      const c = el("button", "claude-chip", v);
      c.type = "button";
      c.addEventListener("click", () => abschicken(v));
      chips.appendChild(c);
    }
    box.appendChild(chips);
  }
  if (thema) {
    const chip = el("div", "claude-thema");
    const x = el("button", "icon-btn small", "×");
    x.type = "button";
    x.setAttribute("aria-label", "Thema entfernen");
    x.addEventListener("click", () => { state.claudeThema = null; renderClaude(); });
    add(chip, el("span", null, `Thema: ${thema.name}`), x);
    box.appendChild(chip);
  }
  const feld = el("div", "chat-feld");
  const ta = document.createElement("textarea");
  ta.id = "claude-frage";
  ta.rows = 1;
  ta.value = entwurf;
  ta.placeholder = nachrichten.length ? "Antworten …" : "Schreib Claude …";
  const wachsen = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
  ta.addEventListener("input", wachsen);
  const senden = el("button", "chat-senden");
  senden.type = "submit";
  senden.setAttribute("aria-label", "Senden");
  senden.disabled = !!state.chat.sendet;
  senden.appendChild(svgIcon("M12 19V5M5 12l7-7 7 7"));
  add(feld, ta, mikrofonKnopf(ta), senden);
  box.appendChild(feld);
  box.addEventListener("submit", (e) => { e.preventDefault(); abschicken(ta.value); });
  view.appendChild(box);
  requestAnimationFrame(wachsen);

  const app = el("button", "mehr claude-leeren", "Stattdessen in der Claude-App fragen");
  app.type = "button";
  app.addEventListener("click", () => inClaudeAppFragen(ta.value, thema));
  box.appendChild(app);
  box.appendChild(el("p", "note chat-hinweis", "Über dein Claude-Abo · KI-Meinung, keine Anlageberatung"));

  if (state.view === "claude" && nachrichten.length) {
    requestAnimationFrame(() => { const sc = $("scroller"); sc.scrollTop = sc.scrollHeight; });
  }
}

// --------------------------------------------------------------------------- //
// Laden
// --------------------------------------------------------------------------- //
async function load() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").classList.add("spinning");
  $("load-error").hidden = true;
  try {
    const [feed, meldungen] = await Promise.all([
      client.from("catalyst_feed").select("kind,payload,updated_at"),
      client.from("catalyst_meldungen").select("id,created_at,name,text")
        .order("created_at", { ascending: false }).limit(100),
    ]);
    if (feed.error) throw feed.error;
    if (meldungen.error) throw meldungen.error;
    state.feed = Object.fromEntries((feed.data || []).map((r) => [r.kind, r]));
    state.meldungen = meldungen.data || [];
    const trades = await client.from("catalyst_trades").select("*")
      .order("datum", { ascending: true }).order("created_at", { ascending: true });
    state.trades = trades.error ? [] : (trades.data || []);
    const verlauf = await client.from("catalyst_verlauf").select("datum,wert_eur,einstand_eur").order("datum");
    state.verlauf = verlauf.error ? [] : (verlauf.data || []).map((p) => ({
      datum: p.datum, wert: Number(p.wert_eur), einstand: Number(p.einstand_eur) }));
    applyLocalTrades();
    await chatLaden();
    if (state.chat.bereit) {
      chatFunktion({ status: true }).then(() => { if (state.view === "claude") renderClaude(); });
      chatBeobachten();
    }
    try { await applyLiveQuotes(); } catch { state.live = { ok: false }; }
    livePunkt();
    if (!feed.data?.length && !meldungen.data?.length) {
      showError("Keine Daten für dieses Konto. Entweder gab es noch keinen Lauf, oder du bist mit einem anderen Konto angemeldet.");
    }
  } catch (err) {
    showError(`Laden fehlgeschlagen: ${err.message || err}`);
  } finally {
    state.loading = false;
    $("refresh").classList.remove("spinning");
    renderDepot(); renderMeldungen(); renderRadar(); updateBadge();
    if (state.view === "claude") renderClaude();
  }
}

function showError(text) {
  const box = $("load-error");
  box.textContent = text;
  box.hidden = false;
}

// --------------------------------------------------------------------------- //
// Ansichten & Login
// --------------------------------------------------------------------------- //
const ANSICHTEN = ["depot", "meldungen", "radar", "claude"];

function switchView(name) {
  state.view = name;
  document.body.dataset.ansicht = name;
  for (const b of document.querySelectorAll(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.view === name));
  }
  for (const v of ANSICHTEN) $(`view-${v}`).hidden = v !== name;
  if ($("fab")) $("fab").hidden = name !== "depot";
  $("scroller").scrollTo({ top: 0 });
  if (name === "meldungen") markSeen(); else updateBadge();
  if (name === "depot") renderDepot();   // Kurve braucht die sichtbare Breite
  if (name === "claude") renderClaude();
}

function show(screen) {
  $("splash").hidden = true;
  $("auth").hidden = screen !== "auth";
  $("app").hidden = screen !== "app";
  if ($("fab") && screen !== "app") $("fab").hidden = true;
}

async function onSession(session) {
  if (session) {
    show("app");
    switchView(state.view);
    await load();
  } else {
    show("auth");
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-submit");
  const err = $("login-error");
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = "Wird angemeldet …";
  try {
    const { error } = await client.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    if (error) throw error;
    $("login-password").value = "";
  } catch (ex) {
    err.textContent = /invalid/i.test(ex.message || "")
      ? "E-Mail oder Passwort stimmt nicht."
      : `Anmelden fehlgeschlagen: ${ex.message || ex}`;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Anmelden";
  }
});

$("logout").addEventListener("click", async () => {
  await client.auth.signOut({ scope: "local" });
});
// Oben "Aktualisieren": sofort neu laden UND den Radar-Check anstoßen (gleiche
// Sperre wie "Jetzt prüfen" -- mehrfaches Drücken startet nichts doppelt).
$("refresh").addEventListener("click", async () => {
  await load();
  if (!state.pruefung.aktiv) jetztPruefen();
});
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => switchView(b.dataset.view));
}
// Kurve an neue Breite anpassen (Drehen des Handys, Fenstergröße).
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (state.view === "depot" && !$("app").hidden) renderDepot(); }, 200);
});
// Holt frische Daten, wenn die App aus dem Hintergrund zurückkommt.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("app").hidden) load();
});

// Tipp auf eine Mitteilung: passenden Reiter öffnen (?ansicht=… bzw. Nachricht vom Service Worker)
const startAnsicht = new URLSearchParams(location.search).get("ansicht");
if (ANSICHTEN.includes(startAnsicht)) state.view = startAnsicht;
navigator.serviceWorker?.addEventListener("message", (e) => {
  if (ANSICHTEN.includes(e.data?.ansicht)) { switchView(e.data.ansicht); load(); }
});

client.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") onSession(session);
});
client.auth.getSession().then(({ data }) => onSession(data.session));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").then((reg) => {
    // Beim Zurückkehren in die App nach einer neuen Version schauen …
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {}));
  // … und sobald sie übernommen ist, einmal neu laden -- so ist das Handy immer aktuell.
  let neuGeladen = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (neuGeladen || !navigator.serviceWorker.controller) return;
    neuGeladen = true;
    location.reload();
  });
}

// localStorage kann im privaten Modus fehlen oder werfen — dann eben ohne Badge-Gedächtnis.
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }
