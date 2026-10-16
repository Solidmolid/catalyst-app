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

const $ = (id) => document.getElementById(id);
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const state = { view: "depot", feed: {}, meldungen: [], trades: [], loading: false, live: null, formOpen: false };

// --------------------------------------------------------------------------- //
// Formatierung
// --------------------------------------------------------------------------- //
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const pctFmt = new Intl.NumberFormat("de-DE", {
  signDisplay: "always", minimumFractionDigits: 1, maximumFractionDigits: 1,
});

function fmtEur(n) { return n == null ? "—" : eur.format(n); }
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

  const live = state.live?.ok ? `Live-Kurse ${fmtStamp(state.live.zeit)}` : `Stand: ${fmtStamp(entry.updated_at)}`;
  add(view, el("p", "stand", live));

  const openBtn = el("button", "primary trade-open", state.formOpen ? "Eintragen abbrechen" : "＋ Kauf / Verkauf eintragen");
  openBtn.type = "button";
  openBtn.addEventListener("click", () => { state.formOpen = !state.formOpen; renderDepot(); });
  view.appendChild(openBtn);
  if (state.formOpen) view.appendChild(tradeForm(positions));

  const aktien = positions.filter((r) => r.typ !== "etf");
  const etfs = positions.filter((r) => r.typ === "etf");
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

  // Summe über alle Positionen mit Kurs
  const priced = positions.filter((r) => r.wert_eur != null);
  if (priced.length) {
    const wert = sum(priced, "wert_eur");
    const einstand = sum(priced, "einstand_eur");
    const heute = priced.reduce((s, r) => (r.tag_pct == null ? s : s + r.wert_eur - r.wert_eur / (1 + r.tag_pct / 100)), 0);
    const gesamtPct = einstand ? (wert / einstand - 1) * 100 : null;
    const card = el("div", "card");
    add(card,
      el("div", "section-title", "Depot gesamt"),
      el("div", "summary-value", fmtEur(wert)));
    const row = el("div", "summary-row");
    const a = el("span", trend(gesamtPct)); add(a, el("b", null, fmtPct(gesamtPct)), document.createTextNode(" seit Einstand"));
    const b = el("span", trend(heute)); add(b, el("b", null, `${heute >= 0 ? "+" : "−"}${fmtEur(Math.abs(heute))}`), document.createTextNode(" heute"));
    add(row, a, b);
    add(card, row);
    const split = el("div", "summary-split");
    if (aktien.length) split.appendChild(el("span", null, `Einzelaktien ${fmtEur(sum(aktien.filter((r) => r.wert_eur != null), "wert_eur"))}`));
    if (etfs.length) split.appendChild(el("span", null, `ETFs ${fmtEur(sum(etfs.filter((r) => r.wert_eur != null), "wert_eur"))}`));
    const cash = entry.payload.cash;
    if (cash && cash.eur != null) {
      const hinweis = cash.geschaetzt ? " (inkl. Sparpläne/Einträge, geschätzt)" : cash.stand ? ` (Stand ${fmtDay(cash.stand)})` : "";
      split.appendChild(el("span", null, `Cash ${fmtEur(cash.eur)}${hinweis}`));
    }
    card.appendChild(split);
    view.appendChild(card);
  }

  // Aktive Hinweise (deine Marken, große Bewegung, naher Termin)
  for (const h of entry.payload.hinweise || []) view.appendChild(el("div", "alert", h.text));

  if (aktien.length) view.appendChild(el("div", "section-title", "Einzelaktien"));
  for (const r of aktien) view.appendChild(positionCard(r, true));
  if (etfs.length) view.appendChild(el("div", "section-title", "ETFs"));
  for (const r of etfs) view.appendChild(positionCard(r, false));

  if (watch.length) {
    view.appendChild(el("div", "section-title", "Watchlist"));
    for (const r of watch) {
      const card = el("div", "card");
      const head = el("div", "pos-head");
      const name = el("div", "pos-name", r.name);
      name.appendChild(el("span", "pos-ticker", r.ticker));
      add(head, name, el("div", "pos-value", fmtEur(r.kurs_eur)));
      add(card, head, add(el("div", "pos-grid"), cell("heute", fmtPct(r.tag_pct), trend(r.tag_pct))));
      view.appendChild(card);
    }
  }

  if (state.trades.length) view.appendChild(tradeList());

  if (positions.some((r) => r.geschaetzt)) {
    view.appendChild(el("p", "note", "Stückzahl/Einstand sind teils geschätzt — echte Werte in depot.yaml eintragen."));
  }
  if (!rows.some((r) => r.regeln && Object.keys(r.regeln).length)) {
    view.appendChild(el("p", "note", "Noch keine eigenen Marken gesetzt — gemeldet werden nur große Tagesbewegungen und nahe Termine."));
  }
}

function positionCard(r, mitTermin) {
  const card = el("div", "card");
  const head = el("div", "pos-head");
  const name = el("div", "pos-name", r.name);
  name.appendChild(el("span", "pos-ticker", r.ticker));
  add(head, name, el("div", "pos-value", fmtEur(r.wert_eur)));
  const grid = el("div", "pos-grid");
  add(grid,
    cell("seit Einstand", fmtPct(r.gewinn_pct), trend(r.gewinn_pct)),
    cell("heute", fmtPct(r.tag_pct), trend(r.tag_pct)),
    mitTermin
      ? cell(r.termin_art ? `nächste ${r.termin_art}` : "nächster Termin",
        r.termin ? `${fmtDay(r.termin)} · ${inDays(r.termin)}` : "—", "")
      : cell("Einstand", fmtEur(r.einstand_eur), ""));
  add(card, head, grid);
  if (r.sparplan) {
    const tage = (r.sparplan.tage || []).map((t) => `${t}.`).join(" & ");
    const neu = r.sparplan_neu ? ` · +${r.sparplan_neu} Ausführung(en) seit Auszug eingerechnet (geschätzt)` : "";
    card.appendChild(el("p", "pos-note", `Sparplan ${fmtEur(r.sparplan.betrag_eur)} am ${tage}${neu}`));
  }
  if (r.app_eintraege) {
    card.appendChild(el("p", "pos-note", `inkl. ${r.app_eintraege} Eintrag/Einträge aus der App`));
  }
  const checks = state.feed.checks?.payload?.checks?.[r.ticker] || [];
  if (checks.length) card.appendChild(checkBlock(checks[0], checks.length - 1));
  return card;
}

const ANLASS = { vor: "vor dem Termin", nach: "nach dem Termin", bewegung: "starke Kursbewegung" };

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
    add(det, el("summary", null, aeltere ? `Ganze Einordnung (+${aeltere} ältere)` : "Ganze Einordnung"),
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

function tradeForm(positions) {
  const f = { art: "kauf", ticker: positions[0]?.ticker || "", name: positions[0]?.name || "", typ: positions[0]?.typ || "aktie" };
  const card = el("form", "card trade-form");
  card.appendChild(el("div", "section-title", "Kauf / Verkauf eintragen"));

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
  const neuOpt = el("option", null, "➕ Neue Aktie / ETF suchen …");
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
    state.formOpen = false;
    await load();
  });

  if (f.ticker) setKurs(f.ticker);
  return card;
}

function tradeList() {
  const card = el("div", "card msg-list");
  card.appendChild(el("div", "section-title trade-title", "Deine Einträge"));
  const seit = state.feed.depot ? new Date(state.feed.depot.updated_at) : null;
  for (const t of [...state.trades].reverse()) {
    const item = el("div", "msg trade-item");
    const txt = el("div");
    const stk = (t.betrag_eur / t.kurs_eur).toLocaleString("de-DE", { maximumFractionDigits: 4 });
    add(txt,
      el("time", null, `${fmtDay(t.datum)} · ${t.art === "kauf" ? "Kauf" : "Verkauf"}`),
      el("div", null, `${t.name || t.ticker}: ${fmtEur(t.betrag_eur)} zu ${fmtEur(t.kurs_eur)} (${stk} Stk.)`));
    if (seit && new Date(t.created_at) > seit) txt.appendChild(el("small", "muted", "in der App schon eingerechnet — Catalyst übernimmt es beim nächsten Lauf"));
    const del = el("button", "icon-btn small", "×");
    del.type = "button";
    del.title = "Eintrag löschen";
    del.addEventListener("click", async () => {
      if (!confirm(`Eintrag löschen?\n${t.name || t.ticker}, ${fmtEur(t.betrag_eur)}`)) return;
      const { error } = await client.from("catalyst_trades").delete().eq("id", t.id);
      if (error) { showError(`Löschen fehlgeschlagen: ${error.message}`); return; }
      await load();
    });
    add(item, txt, del);
    card.appendChild(item);
  }
  return card;
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
function renderMeldungen() {
  const view = $("view-meldungen");
  view.replaceChildren();
  if (!state.meldungen.length) {
    view.appendChild(empty("Noch keine Meldungen. Der Depot-Wächter meldet sich, sobald etwas eintritt."));
    return;
  }
  const list = el("div", "card msg-list");
  for (const m of state.meldungen) {
    const item = el("div", "msg");
    add(item, el("time", null, fmtStamp(m.created_at)), el("div", null, m.text));
    list.appendChild(item);
  }
  view.appendChild(list);
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
// Radar
// --------------------------------------------------------------------------- //
function renderRadar() {
  const view = $("view-radar");
  view.replaceChildren();
  const entry = state.feed.radar;
  const p = entry?.payload;
  if (!p) {
    view.appendChild(empty("Noch kein Tages-Radar. Er kommt mit dem nächsten täglichen Lauf."));
    return;
  }
  add(view, el("p", "stand", `Tages-Radar vom ${fmtDay(p.datum)} · ${p.n_events ?? "?"} Events im Blick · aktualisiert ${fmtStamp(entry.updated_at)}`));

  if (!(p.picks || []).length) view.appendChild(empty("Heute keine eingeordneten Picks."));
  const neuestes = (p.picks || []).reduce((m, k) => (k.seit && k.seit > m ? k.seit : m), "");
  for (const k of p.picks || []) {
    const lbl = (k.label || "").toLowerCase();
    const card = el("div", `card pick ${lbl}`);
    const head = el("div", "pick-head");
    const name = el("div", "pos-name", k.asset);
    if (k.ticker) name.appendChild(el("span", "pos-ticker", k.ticker));
    const badges = el("div", "badges");
    if (k.seit && k.seit === neuestes) badges.appendChild(el("span", "tag neu", "NEU"));
    if (k.im_depot) badges.appendChild(el("span", "tag depot", "Im Depot"));
    if (k.label) badges.appendChild(el("span", `label ${lbl}`, k.label));
    add(head, name, badges);
    const meta = `${k.typ}${k.datum ? ` · ${fmtDay(k.datum)} · ${inDays(k.datum)}` : ""}`
      + (k.seit ? ` · eingeordnet ${fmtDay(k.seit)}` : "");
    add(card, head, el("div", "pick-meta", meta), el("div", null, k.kurz));
    if (k.text) {
      const det = el("details");
      add(det, el("summary", null, "Ganze Einordnung"), el("p", null, k.text));
      card.appendChild(det);
    }
    view.appendChild(card);
  }

  if ((p.exit_signals || []).length) {
    view.appendChild(el("div", "section-title", "Frühere Picks — Kaufgrund trägt nicht mehr"));
    for (const s of p.exit_signals) {
      const card = el("div", "card exit");
      add(card, el("div", "pos-name", s.asset || s.ticker), el("div", "pick-meta", (s.reasons || []).join(" · ")));
      view.appendChild(card);
    }
  }
  view.appendChild(el("p", "note", "Einordnung eines KI-Agenten — eine Meinung, keine Anlageberatung, keine Kursziele."));
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
    applyLocalTrades();
    try { await applyLiveQuotes(); } catch { state.live = { ok: false }; }
    if (!feed.data?.length && !meldungen.data?.length) {
      showError("Keine Daten für dieses Konto. Entweder gab es noch keinen Lauf, oder du bist mit einem anderen Konto angemeldet.");
    }
  } catch (err) {
    showError(`Laden fehlgeschlagen: ${err.message || err}`);
  } finally {
    state.loading = false;
    $("refresh").classList.remove("spinning");
    renderDepot(); renderMeldungen(); renderRadar(); updateBadge();
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
function switchView(name) {
  state.view = name;
  for (const b of document.querySelectorAll(".tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.view === name));
  }
  for (const v of ["depot", "meldungen", "radar"]) $(`view-${v}`).hidden = v !== name;
  if (name === "meldungen") markSeen(); else updateBadge();
}

function show(screen) {
  $("splash").hidden = true;
  $("auth").hidden = screen !== "auth";
  $("app").hidden = screen !== "app";
}

async function onSession(session) {
  if (session) {
    show("app");
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
$("refresh").addEventListener("click", load);
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => switchView(b.dataset.view));
}
// Holt frische Daten, wenn die App aus dem Hintergrund zurückkommt.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !$("app").hidden) load();
});

client.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" || event === "SIGNED_OUT") onSession(session);
});
client.auth.getSession().then(({ data }) => onSession(data.session));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
}

// localStorage kann im privaten Modus fehlen oder werfen — dann eben ohne Badge-Gedächtnis.
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }
