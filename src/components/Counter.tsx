"use client";

// The landing page: an order sentence you edit like a coffee order, a 3D cup
// the barista marks, and the best matching cafes hanging as tickets. Matching
// uses the same rules as /explore (matchesFilters + orderToFilters), so the
// counts here are the counts you get when you follow "See all".
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CounterCup, { type CounterCupHandle } from "./CounterCup";
import {
  ORDER_SLOTS, ORDER_KEYS, DEFAULT_ORDER, orderToFilters, orderHref,
  type Order, type OrderSlot, type OrderOption,
} from "@/lib/filter-url";
import { matchesFilters } from "@/lib/search-filters";
import { mergeTag } from "@/lib/merge-tags";
import { isOpenNow } from "@/lib/open-now";
import type { Cafe } from "@/lib/types";
import { decodeRow, type CounterRow } from "@/lib/counter-rows";

const TICKETS = 12;
const TITLES: Record<OrderSlot, string> = { noise: "Noise", outlets: "Outlets", wifi: "Wi‑Fi", hours: "Hours", area: "Where" };
const LINE_LABEL: Record<OrderSlot, string> = { noise: "Noise", outlets: "Outlets", wifi: "Wi-Fi", hours: "Today", area: "City" };
const VALUE = {
  noise: { quiet: "Quiet", moderate: "Chatty", loud: "Loud" } as Record<string, string>,
  outlets: { every_table: "Every seat", most: "Most seats", limited: "A few", none: "None" } as Record<string, string>,
  wifi: { fast: "Fast", moderate: "Solid", slow: "Spotty", none: "None" } as Record<string, string>,
  seats: { ample: "Plenty", adequate: "Enough", limited: "Tight", none: "None" } as Record<string, string>,
};
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const opts = (k: OrderSlot) => ORDER_SLOTS[k] as OrderOption[];

function shortName(name: string) {
  const s = name.replace(/^The /, "").split(/\s+(?:Coffee|Cafe|Café|Roasters|Coffeehouse|&|\/|-|Co\.?$)/)[0];
  return s.length > 14 ? s.split(" ").slice(0, 2).join(" ") : s;
}
function city(address: string) {
  const m = address.match(/,\s*([^,]+),\s*WA\b/);
  return m ? m[1] : "Seattle";
}
function todayHours(c: Cafe, now: Date) {
  const v = c.hours_json?.[DAYS[now.getDay()]];
  if (!v) return "No hours";
  if (/closed/i.test(v)) return "Closed";
  return v.replace(/:00/g, "").replace(/\s*[–-]\s*/, "–").replace(/ | /g, " ");
}
function mapsUrl(c: Cafe) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.name}, ${c.address}`)}&query_place_id=${c.google_place_id}`;
}

interface CounterProps {
  rows: CounterRow[];     // every visible cafe, best score first, compacted by encodeRow
  day: string;
  photoBase: string;
  nowIso: string;         // server's Seattle clock, so the first render matches
  neighborhoods: number;
  fonts: { display: string; mono: string; marker: string };
}

export default function Counter({ rows, day, photoBase, nowIso, neighborhoods, fonts }: CounterProps) {
  const cafes = useMemo(() => rows.map(r => decodeRow(r, day, photoBase)), [rows, day, photoBase]);
  const [order, setOrder] = useState<Order>(DEFAULT_ORDER);
  const [now, setNow] = useState(() => new Date(nowIso));
  const [openSlot, setOpenSlot] = useState<OrderSlot | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [hint, setHint] = useState<Partial<Record<OrderSlot, string>>>({});
  const [barVisible, setBarVisible] = useState(false);
  const [railPos, setRailPos] = useState(1);
  const cup = useRef<CounterCupHandle>(null);
  const slotRefs = useRef<Partial<Record<OrderSlot, HTMLButtonElement | null>>>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const wallRef = useRef<HTMLOListElement>(null);
  const orderRef = useRef<HTMLElement>(null);
  const ticketsRef = useRef<HTMLElement>(null);
  const hintDone = useRef(false);
  const hovered = useRef("");

  // Keep "open now" honest while the page stays open.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }))), 60_000);
    return () => clearInterval(id);
  }, []);

  const filters = useMemo(() => orderToFilters(order), [order]);
  const matched = useMemo(() => cafes.filter(c => matchesFilters(c, filters, now)), [cafes, filters, now]);
  const tickets = useMemo(() => {
    const picked = matched.slice(0, TICKETS);
    if (picked.length < TICKETS) {
      const ids = new Set(picked.map(c => c.id));
      picked.push(...cafes.filter(c => !ids.has(c.id)).slice(0, TICKETS - picked.length));
    }
    return picked.map(c => ({
      cafe: c,
      match: matched.includes(c),
      // one ✓ / ✗ per order line, judged with the same rule as the whole order
      lines: Object.fromEntries(ORDER_KEYS.map(k => {
        const f = opts(k)[order[k]].filters;
        return [k, Object.keys(f).length === 0 ? null : matchesFilters(c, f, now)];
      })) as Record<OrderSlot, boolean | null>,
    }));
  }, [matched, cafes, order, now]);
  const count = matched.length;
  const top = matched[0];

  // Tell the cup what the barista should write.
  useEffect(() => { cup.current?.setOrder(ORDER_KEYS.map(k => opts(k)[order[k]].code)); }, [order]);
  useEffect(() => { if (!hovered.current) cup.current?.showName(top ? shortName(top.name) : "no match"); }, [top]);

  // ── Choice menu ────────────────────────────────────────────
  const closeMenu = useCallback((refocus = true) => {
    setOpenSlot(prev => { if (prev && refocus) slotRefs.current[prev]?.focus({ preventScroll: true }); return null; });
  }, []);
  function openMenu(k: OrderSlot) {
    hintDone.current = true;
    if (openSlot === k) { closeMenu(); return; }
    const btn = slotRefs.current[k];
    if (btn && window.innerWidth >= 700) {
      const r = btn.getBoundingClientRect();
      setMenuPos({ top: r.bottom + window.scrollY + 10, left: Math.max(16, Math.min(r.left + window.scrollX, document.documentElement.clientWidth - 300)) });
    } else setMenuPos(null);
    setOpenSlot(k);
  }
  function choose(k: OrderSlot, i: number) {
    closeMenu();
    if (order[k] === i) return;
    setOrder(o => ({ ...o, [k]: i }));
    cup.current?.focus("column");
  }
  useEffect(() => {
    if (!openSlot) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeMenu(); };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!menuRef.current?.contains(t) && !t.closest(".ct-slot")) closeMenu(false);
    };
    const onResize = () => closeMenu(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [openSlot, closeMenu]);
  function onMenuKey(e: React.KeyboardEvent<HTMLUListElement>) {
    const items = [...e.currentTarget.children] as HTMLElement[];
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if ((e.key === "Enter" || e.key === " ") && openSlot && idx >= 0) { e.preventDefault(); choose(openSlot, idx); }
    else if (e.key === "Tab") closeMenu(false);
  }

  function barista() {
    hintDone.current = true;
    closeMenu(false);
    let next: Order = order;
    for (let tries = 0; tries < 60; tries++) {
      next = Object.fromEntries(ORDER_KEYS.map(k => [k, Math.floor(Math.random() * opts(k).length)])) as Order;
      const n = cafes.filter(c => matchesFilters(c, orderToFilters(next), now)).length;
      if (n >= 5 && ORDER_KEYS.some(k => next[k] !== order[k])) break;
    }
    setOrder(next);
    cup.current?.focus("column");
  }

  // ── One-time hint: pills spin through their options once, then settle ──
  useEffect(() => {
    const el = document.getElementById("ct-order-h");
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(([e]) => {
      if (e.intersectionRatio < 0.6 || hintDone.current) return;
      hintDone.current = true; io.disconnect();
      ORDER_KEYS.forEach((k, si) => {
        const n = opts(k).length;
        for (let j = 1; j <= n; j++) {
          timers.push(setTimeout(() => {
            setHint(h => ({ ...h, [k]: j === n ? undefined : opts(k)[(DEFAULT_ORDER[k] + j) % n].label }));
          }, 900 + si * 170 + j * 230));
        }
      });
    }, { threshold: [0.6] });
    io.observe(el);
    return () => { io.disconnect(); timers.forEach(clearTimeout); };
  }, []);

  // ── Pinned order bar: shows once the order sentence has scrolled away ──
  // A scroll check, not IntersectionObserver: observer callbacks can lag a jump
  // scroll by a frame or more, which left the bar missing on real devices.
  useEffect(() => {
    const sync = () => {
      const r = orderRef.current?.getBoundingClientRect();
      setBarVisible(!!r && r.bottom < 0);
    };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync);
    return () => { window.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); };
  }, []);

  // ── Tickets: glide to new places, sway softly when brushed ──
  const rects = useRef(new Map<string, DOMRect>());
  const swing = useRef(new Map<string, { th: number; w: number }>());
  const swingRaf = useRef(0);
  const air = useRef({ id: "", vx: 0, lx: 0, lt: 0 });
  const RM = typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const step = useCallback(() => {
    let last = performance.now(), acc = 0;
    const tick = (nowT: number) => {
      const dt = Math.min(0.05, (nowT - last) / 1000); last = nowT; acc += dt;
      const a = air.current;
      if (a.id) { const s = swing.current.get(a.id) ?? { th: 0, w: 0 }; s.w += Math.max(-1.6, Math.min(1.6, -Math.sign(a.vx) * a.vx * a.vx * 5e-7)) * dt; swing.current.set(a.id, s); }
      a.vx *= Math.exp(-9 * dt);
      while (acc >= 1 / 120) {
        acc -= 1 / 120;
        swing.current.forEach(s => { s.w += (-17.6 * s.th - 2.7 * s.w) / 120; s.th += s.w / 120; });
      }
      let live = !!a.id && Math.abs(a.vx) > 4;
      swing.current.forEach((s, id) => {
        const el = wallRef.current?.querySelector<HTMLElement>(`[data-id="${id}"] .ct-swing`);
        if (Math.abs(s.th) < 0.0003 && Math.abs(s.w) < 0.0015) { swing.current.delete(id); if (el) el.style.transform = ""; return; }
        live = true;
        if (el) el.style.transform = `rotate(${(0.055 * Math.tanh(s.th / 0.055)).toFixed(5)}rad)`;
      });
      swingRaf.current = live ? requestAnimationFrame(tick) : 0;
    };
    if (!swingRaf.current) swingRaf.current = requestAnimationFrame(tick);
  }, []);
  const nudge = useCallback((id: string, w: number) => {
    if (RM) return;
    const s = swing.current.get(id) ?? { th: 0, w: 0 }; s.w += w; swing.current.set(id, s); step();
  }, [RM, step]);

  useLayoutEffect(() => {
    const wall = wallRef.current; if (!wall) return;
    const next = new Map<string, DOMRect>();
    wall.querySelectorAll<HTMLElement>("[data-id]").forEach(el => {
      const id = el.dataset.id!, r = el.getBoundingClientRect();
      next.set(id, r);
      const prev = rects.current.get(id);
      if (RM) return;
      if (!prev) {
        el.animate([{ opacity: 0, transform: "translateY(-14px)" }, { opacity: 1, transform: "none" }], { duration: 520, easing: "cubic-bezier(.22,1,.36,1)" });
        return;
      }
      const dx = prev.left - r.left, dy = prev.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: 680, easing: "cubic-bezier(.22,1,.36,1)" });
      setTimeout(() => nudge(id, dx > 0 ? 0.11 : -0.11), 300);
    });
    rects.current = next;
  }, [tickets, RM, nudge]);
  useEffect(() => () => cancelAnimationFrame(swingRaf.current), []);

  function onWallMove(e: React.PointerEvent) {
    if (e.pointerType !== "mouse") return;
    const a = air.current, t = performance.now(), gap = (t - a.lt) / 1000;
    if (gap < 0.1) a.vx += (Math.max(-3000, Math.min(3000, (e.clientX - a.lx) / Math.max(0.008, gap))) - a.vx) * 0.3;
    a.lx = e.clientX; a.lt = t;
    const li = (e.target as Element).closest<HTMLElement>("[data-id]");
    a.id = li?.dataset.id ?? "";
    if (a.id) step();
  }
  function setHover(c: Cafe | null) {
    const name = c ? shortName(c.name) : "";
    if (name === hovered.current) return;
    hovered.current = name;
    cup.current?.showName(name || (top ? shortName(top.name) : "no match"));
    cup.current?.focus(name ? "name" : "idle");
  }
  const lastScroll = useRef(0);
  function onWallScroll(e: React.UIEvent<HTMLOListElement>) {
    const el = e.currentTarget, d = el.scrollLeft - lastScroll.current;
    lastScroll.current = el.scrollLeft;
    tickets.forEach(t => nudge(t.cafe.id, Math.max(-0.035, Math.min(0.035, -d * 0.0008))));
    const first = el.firstElementChild as HTMLElement | null;
    if (first) setRailPos(Math.max(1, Math.min(tickets.length, Math.round(el.scrollLeft / (first.offsetWidth + 16)) + 1)));
  }

  const clock = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const picked = ORDER_KEYS.filter(k => Object.keys(opts(k)[order[k]].filters).length)
    .map(k => opts(k)[order[k]].label + (k === "wifi" ? " Wi‑Fi" : ""));
  const menuItems = openSlot ? opts(openSlot).map((o, i) => ({
    label: o.label,
    n: cafes.filter(c => matchesFilters(c, orderToFilters({ ...order, [openSlot]: i }), now)).length,
  })) : [];

  const slot = (k: OrderSlot) => (
    <button
      ref={el => { slotRefs.current[k] = el; }}
      type="button"
      className="ct-slot"
      aria-haspopup="listbox"
      aria-expanded={openSlot === k}
      aria-label={`${TITLES[k]}: ${opts(k)[order[k]].label}. Choose another.`}
      onClick={() => openMenu(k)}
    >
      {/* While hinting, the real label stays (invisible) to hold the pill's width. */}
      <span className={`ct-roll${hint[k] ? " is-hinting" : ""}`}>
        <span key={opts(k)[order[k]].label} className="ct-roll-word">{opts(k)[order[k]].label}</span>
        {hint[k] && <span key={hint[k]} className="ct-roll-hint" aria-hidden="true">{hint[k]}</span>}
      </span>
      <svg className="ct-chev" viewBox="0 0 12 8" aria-hidden="true"><path d="M1.5 1.5 6 6.2l4.5-4.7" /></svg>
    </button>
  );

  return (
    <div className="ct" style={{ ["--ct-display" as string]: fonts.display, ["--ct-mono" as string]: fonts.mono, ["--ct-marker" as string]: fonts.marker }}>
      <aside className="ct-stage" aria-label="Your cup">
        <div className="ct-bignum" aria-hidden="true"><span key={count}>{count}</span></div>
        <CounterCup ref={cup} fonts={fonts} />
        <div className="ct-stage-foot">
          <span><b>{count}</b> of {cafes.length} cafes fit your order</span>
          <span className="ct-how">Drag the cup to turn it. Brush the steam.</span>
        </div>
      </aside>

      <div className="ct-main">
        <section className="ct-order" ref={orderRef} aria-labelledby="ct-order-h">
          <p className="ct-eyebrow">Your order · {clock} in Seattle · {cafes.length} cafes on the menu</p>
          <p className="ct-kicker">
            <strong>Pin your focus in the right space.</strong>
            Needle Space finds Seattle-area cafes you can actually work from. Tell the barista what you need.
          </p>
          <h1 className="ct-line" id="ct-order-h">
            One {slot("noise")} table, {slot("outlets")}, {slot("wifi")} Wi&#8209;Fi, {slot("hours")}, {slot("area")}.
          </h1>
          <div className="ct-actions">
            <Link className="ct-btn ct-btn-primary" href={orderHref(order)}>See all {count} in Browse →</Link>
            <button className="ct-btn ct-btn-line" type="button" onClick={barista}>Barista’s choice</button>
          </div>
        </section>

        <section className="ct-tickets" id="tickets" ref={ticketsRef} aria-labelledby="ct-tickets-h">
          <h2 id="ct-tickets-h">Order up.</h2>
          <p className="ct-fine">
            The best work scores that fit your order. Wi‑Fi, outlets and noise come from public reviews and in-person checks; hours come from Google.
            On each ticket, <span className="ct-ok">✓</span> means a line fits your order and a <span className="ct-no">crossed-out</span> line is why a cafe isn’t a match.
          </p>
          <ol
            className="ct-wall"
            ref={wallRef}
            onPointerMove={onWallMove}
            onPointerLeave={e => { air.current.id = ""; if (e.pointerType === "mouse") setHover(null); }}
            onScroll={onWallScroll}
            onFocus={e => { const id = (e.target as Element).closest<HTMLElement>("[data-id]")?.dataset.id; const t = tickets.find(x => x.cafe.id === id); if (t) setHover(t.cafe); }}
          >
            {tickets.map(({ cafe: c, match, lines }) => {
              const open = isOpenNow(c.hours_json, now);
              const cls = (k: OrderSlot) => (lines[k] === null ? undefined : lines[k] ? "is-ok" : "is-no");
              return (
                <li key={c.id} data-id={c.id} className={`ct-ticket${match ? "" : " is-miss"}`} onPointerOver={() => setHover(c)}>
                  <div className="ct-swing">
                    <span className="ct-clip" aria-hidden="true" />
                    <article className="ct-paper" aria-labelledby={`t-${c.id}`}>
                      <div className="ct-t-meta"><span>Dine-in · 1 laptop</span><span>{clock}</span></div>
                      {c.photo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img className="ct-t-photo" src={c.photo_url} alt={c.name} width={400} height={250} />
                        : <div className="ct-t-photo" aria-hidden="true" />}
                      <h3 className="ct-t-name" id={`t-${c.id}`}><Link href={`/cafe/${c.id}`}>{c.name}</Link></h3>
                      <p className="ct-t-where">{c.neighborhood}</p>
                      <ul className="ct-t-lines">
                        <li className={cls("noise")}><span>{LINE_LABEL.noise}</span><i /><b>{VALUE.noise[mergeTag(c, "noise_level")] ?? "No data"}</b></li>
                        <li className={cls("outlets")}><span>{LINE_LABEL.outlets}</span><i /><b>{VALUE.outlets[mergeTag(c, "outlet_availability")] ?? "No data"}</b></li>
                        <li className={cls("wifi")}><span>{LINE_LABEL.wifi}</span><i /><b>{VALUE.wifi[mergeTag(c, "wifi_quality")] ?? "No data"}</b></li>
                        <li className={cls("hours")}><span>{LINE_LABEL.hours}</span><i /><b>{todayHours(c, now)}</b></li>
                        <li className={cls("area")}><span>{LINE_LABEL.area}</span><i /><b>{city(c.address)}</b></li>
                        <li><span>Seats</span><i /><b>{VALUE.seats[mergeTag(c, "seating_availability")] ?? "No data"}</b></li>
                      </ul>
                      <div className="ct-t-score"><span>Work<br />score</span><b>{(c.productivity_score ?? 0).toFixed(1)}</b><small>/5</small></div>
                      <p className="ct-t-google">
                        {c.google_rating != null ? `${c.google_rating.toFixed(1)}★ on Google · ${(c.google_review_count ?? 0).toLocaleString("en-US")} reviews` : " "}
                      </p>
                      <div className="ct-t-foot">
                        <span className={`ct-t-open${open ? " is-open" : ""}`}>{open ? "Open now" : "Closed now"}</span>
                        <a href={mapsUrl(c)} target="_blank" rel="noopener noreferrer">Directions ↗</a>
                      </div>
                      {!match && <span className="ct-stamp" aria-hidden="true">Maybe next time!</span>}
                      <span className="sr-only">{match ? "Fits your order." : "Maybe next time: doesn't fit every part of your order."}</span>
                    </article>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="ct-swipe" aria-hidden="true"><span><b>{railPos}</b> of {tickets.length}</span><span>Swipe for more →</span></p>
        </section>

        <section className="ct-closer" aria-labelledby="ct-closer-h">
          <h2 id="ct-closer-h">Can’t decide?</h2>
          <p>Let the barista write your order, or get five cafes picked for you.</p>
          <div className="ct-actions">
            <button className="ct-btn ct-btn-primary" type="button" onClick={() => { orderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); barista(); }}>Barista’s choice</button>
            <Link className="ct-btn ct-btn-line" href="/treasure">Surprise me</Link>
            <Link className="ct-btn ct-btn-line" href="/explore">Browse all {cafes.length}</Link>
          </div>
          <p className="ct-colophon">Needle Space · laptop-friendly cafes in Seattle, Bellevue, Redmond &amp; Kirkland · {cafes.length} cafes across {neighborhoods} neighborhoods</p>
        </section>
      </div>

      {openSlot && (
        <>
          {!menuPos && <div className="ct-scrim" onClick={() => closeMenu(false)} />}
          <div
            ref={menuRef}
            className={`ct-menu${menuPos ? "" : " is-sheet"}`}
            style={menuPos ? { top: menuPos.top, left: menuPos.left } : undefined}
          >
            {!menuPos && <div className="ct-grip" aria-hidden="true" />}
            <p className="ct-menu-title" id="ct-menu-title">{TITLES[openSlot]}</p>
            <ul role="listbox" aria-labelledby="ct-menu-title" onKeyDown={onMenuKey}>
              {menuItems.map((m, i) => (
                <li key={m.label} role="option" tabIndex={-1} aria-selected={order[openSlot] === i} onClick={() => choose(openSlot, i)}>
                  <span className="ct-o-label">{m.label}</span>
                  <span className="ct-o-count">{m.n} cafe{m.n === 1 ? "" : "s"}</span>
                  <svg className="ct-o-check" viewBox="0 0 16 12" aria-hidden="true"><path d="M1.5 6.5 5.8 10.5 14.5 1.5" /></svg>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className={`ct-orderbar${barVisible && !openSlot ? " is-shown" : ""}`} aria-hidden={!barVisible}>
        <div className="ct-ob-text">
          <span className="ct-ob-count">{count} cafes match</span>
          <span className="ct-ob-sum">{picked.length ? picked.join(" · ") : "Anything goes"}</span>
        </div>
        <button type="button" tabIndex={barVisible ? 0 : -1} onClick={() => orderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Edit order</button>
      </div>
    </div>
  );
}
