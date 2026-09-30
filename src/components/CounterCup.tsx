"use client";

// The landing page's 3D paper cup. The barista's marks on its side mirror the
// order sentence; the name line shows the cafe you're looking at. three.js is
// loaded only after the page is on screen; a flat drawing stands in until then
// (and for good on devices without WebGL).
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface CounterCupHandle {
  setOrder(codes: string[]): void;
  showName(name: string): void;
  focus(which: "name" | "column" | "idle"): void;
}

const ROWS = ["NOISE", "OUTLETS", "WI-FI", "HOURS", "AREA"];
const INK = "#33271F", PRINT = "#56684D", MARK = "#241A14";

const CounterCup = forwardRef<CounterCupHandle, { fonts: { display: string; mono: string; marker: string } }>(
  function CounterCup({ fonts }, ref) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const apiRef = useRef<CounterCupHandle | null>(null);
    const pending = useRef<{ codes?: string[]; name?: string }>({});
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);

    useImperativeHandle(ref, () => ({
      setOrder(codes) { if (apiRef.current) apiRef.current.setOrder(codes); else pending.current.codes = codes; },
      showName(name) { if (apiRef.current) apiRef.current.showName(name); else pending.current.name = name; },
      focus(which) { apiRef.current?.focus(which); },
    }), []);

    useEffect(() => {
      let disposed = false;
      let cleanup = () => {};
      (async () => {
        try {
          const THREE = await import("three");
          if (disposed || !canvasRef.current || !wrapRef.current) return;
          const built = buildCup(THREE, canvasRef.current, wrapRef.current, fonts);
          cleanup = built.dispose;
          apiRef.current = built.api;
          if (pending.current.codes) built.api.setOrder(pending.current.codes);
          if (pending.current.name !== undefined) built.api.showName(pending.current.name);
          setReady(true);
        } catch {
          if (!disposed) setFailed(true);
        }
      })();
      return () => { disposed = true; cleanup(); };
      // fonts are stable for the page's life
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <div ref={wrapRef} className="ct-cupwrap">
        <canvas
          ref={canvasRef}
          className="ct-cup"
          role="img"
          aria-label="A 3D paper coffee cup. Your order is marked on it in marker."
          style={{ opacity: ready && !failed ? 1 : 0 }}
        />
        {(!ready || failed) && (
          <svg className="ct-cup-fallback" viewBox="0 0 200 250" aria-hidden="true">
            <path d="M40 66h120l-15 172H55z" fill="#FFFCF4" />
            <path d="M46 132h108l-6 66H52z" fill="#C4A07A" />
            <circle cx="100" cy="165" r="20" fill="none" stroke="#33271F" strokeWidth="3" />
            <path d="M30 60c0-9 6-14 14-14h112c8 0 14 5 14 14v8H30z" fill="#33271F" />
            <path d="M52 46c6-10 20-14 48-14s42 4 48 14z" fill="#33271F" />
          </svg>
        )}
      </div>
    );
  },
);
export default CounterCup;

type Three = typeof import("three");

function buildCup(T: Three, canvas: HTMLCanvasElement, wrap: HTMLElement, fonts: { display: string; mono: string; marker: string }) {
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 1, 0.1, 60);
  const LOOK = new T.Vector3(0, 1.95, 0);
  const PI = Math.PI;

  // A soft studio baked into an environment map, tinted by the sage room around it.
  const pmrem = new T.PMREMGenerator(renderer);
  const env = new T.Scene();
  env.add(new T.Mesh(new T.BoxGeometry(14, 14, 14), new T.MeshBasicMaterial({ color: 0x7f8c74, side: T.BackSide })));
  const panel = (w: number, h: number, hex: number, k: number, x: number, y: number, z: number) => {
    const m = new T.MeshBasicMaterial({ color: hex, side: T.DoubleSide }); m.color.multiplyScalar(k);
    const p = new T.Mesh(new T.PlaneGeometry(w, h), m); p.position.set(x, y, z); p.lookAt(0, 1.5, 0); env.add(p);
  };
  panel(8, 4, 0xfffaf0, 3.0, -2.5, 6.5, 3);
  panel(3, 6, 0xf4ecdf, 1.6, -6.5, 2, 2);
  panel(2, 5, 0xffffff, 1.0, 6.5, 2.5, -2);
  const envTex = pmrem.fromScene(env, 0.04).texture;
  scene.environment = envTex;
  scene.add(new T.HemisphereLight(0xfffaf2, 0x8c9a80, 0.55 * PI));
  const key = new T.DirectionalLight(0xfff6ea, 1.0 * PI); key.position.set(-3.5, 7, 6); scene.add(key);
  const rim = new T.DirectionalLight(0xe9efe0, 0.4 * PI); rim.position.set(5, 3, -4); scene.add(rim);

  const CH = 2.5, RT = 1.05, RB = 0.78;
  const rAt = (y: number) => RB + (RT - RB) * (y / CH);
  const PW = 2048, PH = 896;
  const xOf = (th: number) => (th + PI) / (PI * 2) * PW;
  const yOf = (h: number) => (1 - h / CH) * PH;
  const rowY = (i: number) => 100 + i * 64;
  const tex = (c: HTMLCanvasElement) => { const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = aniso; return t; };
  const canvasOf = (w: number, h: number) => Object.assign(document.createElement("canvas"), { width: w, height: h });
  const speckle = (ctx: CanvasRenderingContext2D, w: number, h: number, n: number, rgba: string) => {
    ctx.fillStyle = rgba; let s = 7;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < n; i++) ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2);
  };

  const printCv = canvasOf(PW, PH), pctx = printCv.getContext("2d")!;
  function drawPrint() {
    const c = pctx;
    c.fillStyle = "#FFFCF4"; c.fillRect(0, 0, PW, PH);
    speckle(c, PW, PH, 2600, "rgba(110,90,60,.05)");
    c.fillStyle = PRINT; c.fillRect(0, 26, PW, 7);
    c.textBaseline = "alphabetic";
    ROWS.forEach((r, i) => {
      const cy = rowY(i);
      c.font = `600 21px ${fonts.mono}`; c.fillStyle = INK; c.textAlign = "right"; c.fillText(r, 858, cy + 7);
      c.strokeStyle = PRINT; c.lineWidth = 4; c.strokeRect(872, cy - 18, 36, 36);
    });
    c.textAlign = "left"; c.font = `600 19px ${fonts.mono}`; c.fillStyle = INK;
    c.fillText("NAME", 1088, 98); c.fillRect(1088, 176, 222, 2.5);
    c.strokeStyle = PRINT; c.lineWidth = 3.5;
    c.strokeRect(1088, 222, 30, 30); c.fillText("FOR HERE", 1130, 244);
    c.strokeRect(1088, 272, 30, 30); c.fillText("TO GO", 1130, 294);
    c.textAlign = "center";
    for (const x of [0, PW]) {
      c.font = `800 128px ${fonts.display}`; c.fillStyle = PRINT; c.fillText("needle space", x, 216);
    }
    c.font = `800 54px ${fonts.display}`; c.fillStyle = PRINT;
    ["SEA", "BEL", "RED", "KIR"].forEach((t, i) => c.fillText(t, 560, 132 + i * 72));
    c.font = `600 20px ${fonts.mono}`; c.fillStyle = "rgba(51,39,31,.6)"; c.textAlign = "left";
    const warn = "CAREFUL: CONTENTS HOT · WI-FI FAST · ";
    const ww = c.measureText(warn).width;
    for (let x = 0; x < PW; x += ww) c.fillText(warn, x, 812);
  }
  const printTex = tex(printCv);

  const SW = 2048, SH = 288, sleeveCv = canvasOf(SW, SH), sctx = sleeveCv.getContext("2d")!;
  function drawSleeve() {
    const c = sctx;
    c.fillStyle = "#C4A07A"; c.fillRect(0, 0, SW, SH);
    for (let x = 0; x < SW; x += 10) {
      c.fillStyle = "rgba(80,55,30,.09)"; c.fillRect(x, 0, 4, SH);
      c.fillStyle = "rgba(255,240,220,.08)"; c.fillRect(x + 5, 0, 2, SH);
    }
    speckle(c, SW, SH, 1400, "rgba(60,40,20,.16)");
    c.save(); c.translate(1024, 144); c.rotate(-0.1); c.globalAlpha = 0.86; c.strokeStyle = INK; c.fillStyle = INK;
    c.lineWidth = 5; c.beginPath(); c.arc(0, 0, 118, 0, PI * 2); c.stroke();
    c.lineWidth = 2; c.beginPath(); c.arc(0, 0, 86, 0, PI * 2); c.stroke();
    c.font = `800 84px ${fonts.display}`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("ns", 0, -4);
    c.font = `700 14px ${fonts.mono}`;
    const ring = "WORK-FRIENDLY CAFES · SEATTLE METRO · ", step = (PI * 2) / ring.length;
    [...ring].forEach((ch, i) => { c.save(); c.rotate(i * step); c.fillText(ch, 0, -101); c.restore(); });
    c.restore();
    c.fillStyle = INK; c.textAlign = "center"; c.textBaseline = "alphabetic"; c.font = `800 44px ${fonts.display}`;
    c.fillText("LAPTOPS WELCOME", 1024 - 420, 160); c.fillText("STAY A WHILE", 1024 + 420, 160);
  }
  const sleeveTex = tex(sleeveCv);

  // Marker decal over the front, redrawn only while the barista writes.
  const DT = 0.9, D0 = 1.3, D1 = 2.35;
  const X0 = xOf(-DT), X1 = xOf(DT), Y0 = yOf(D1), Y1 = yOf(D0);
  const MW = 1024, MS = MW / (X1 - X0), MH = Math.round((Y1 - Y0) * MS);
  const markCv = canvasOf(MW, MH), mctx = markCv.getContext("2d")!;
  const markTex = tex(markCv);
  type Mark = { text: string; t: number; dur: number };
  const marks = { rows: ROWS.map((): Mark => ({ text: "", t: 1, dur: 0.42 })), name: { text: "", t: 1, dur: 0.6 } as Mark, here: { text: "", t: 1, dur: 0.35 } as Mark };
  let marksDirty = true;
  const setMark = (m: Mark, text: string, delay = 0) => { if (m.text === text) return; m.text = text; m.t = RM ? 1 : -delay / m.dur; marksDirty = true; };
  const stroke = (pts: number[][], width: number, p: number) => {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    mctx.lineWidth = width; mctx.setLineDash([len * p, len + 1]);
    mctx.beginPath(); mctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(q => mctx.lineTo(q[0], q[1])); mctx.stroke();
    mctx.setLineDash([]);
  };
  const check = (x: number, y: number, s: number, p: number) => stroke([[x + s * .14, y + s * .52], [x + s * .42, y + s * .86], [x + s * 1.12, y - s * .14]], 6.5, p);
  const write = (text: string, x: number, y: number, size: number, p: number, tilt: number, maxW: number) => {
    if (p <= 0 || !text) return;
    mctx.save(); mctx.font = `${size}px ${fonts.marker}`;
    let w = mctx.measureText(text).width;
    if (w > maxW) { size *= maxW / w; mctx.font = `${size}px ${fonts.marker}`; w = maxW; }
    mctx.translate(x, y); mctx.rotate(tilt);
    mctx.beginPath(); mctx.rect(-8, -size * 1.2, (w + 16) * p, size * 1.7); mctx.clip();
    mctx.fillText(text, 0, 0); mctx.restore();
  };
  function drawMarks() {
    mctx.setTransform(1, 0, 0, 1, 0, 0); mctx.clearRect(0, 0, MW, MH);
    mctx.setTransform(MS, 0, 0, MS, -X0 * MS, -Y0 * MS);
    mctx.strokeStyle = mctx.fillStyle = MARK; mctx.lineCap = "round"; mctx.lineJoin = "round"; mctx.globalAlpha = 0.93;
    marks.rows.forEach((m, i) => {
      const p = clamp(m.t, 0, 1), cy = rowY(i);
      if (p <= 0) return;
      if (m.text === "—") stroke([[926, cy + 2], [968, cy - 1]], 6, p);
      else { check(872, cy - 18, 36, clamp(p * 2, 0, 1)); write(m.text, 926, cy + 15, 40, clamp(p * 1.7 - 0.5, 0, 1), i % 2 ? 0.04 : -0.035, 128); }
    });
    write(marks.name.text, 1092, 164, 56, clamp(marks.name.t, 0, 1), -0.05, 214);
    if (marks.here.text) check(1088, 222, 30, clamp(marks.here.t, 0, 1));
  }
  function tickMarks(dt: number) {
    let dirty = marksDirty; marksDirty = false;
    [...marks.rows, marks.name, marks.here].forEach(m => {
      if (m.t < 1) { const before = m.t; m.t = Math.min(1, m.t + dt / m.dur); if (m.t > 0 || before > 0) dirty = true; }
    });
    return dirty;
  }

  // root (tilt) › spin (yaw) › cupG (hop + bob) › parts
  const root = new T.Group(), spin = new T.Group(), cupG = new T.Group(), lidG = new T.Group();
  scene.add(root); root.add(spin); spin.add(cupG); cupG.add(lidG);
  const body = new T.Mesh(new T.CylinderGeometry(RT, RB, CH, 128, 1, true, -PI, PI * 2), new T.MeshStandardMaterial({ map: printTex, roughness: 0.8, envMapIntensity: 0.7 }));
  body.position.y = CH / 2; cupG.add(body);
  const bottom = new T.Mesh(new T.CircleGeometry(RB, 64), new T.MeshStandardMaterial({ color: 0xefe6d8, roughness: 0.9 }));
  bottom.rotation.x = PI / 2; bottom.position.y = 0.004; cupG.add(bottom);
  const rimRing = new T.Mesh(new T.TorusGeometry(RT + 0.01, 0.05, 16, 128), new T.MeshStandardMaterial({ color: 0xfff8ee, roughness: 0.75, envMapIntensity: 0.7 }));
  rimRing.rotation.x = PI / 2; rimRing.position.y = CH; cupG.add(rimRing);
  const S0 = 0.42, S1 = 1.22, ST = 0.03;
  const sleeve = new T.Mesh(new T.CylinderGeometry(rAt(S1) + ST, rAt(S0) + ST, S1 - S0, 128, 1, true, -PI, PI * 2), new T.MeshStandardMaterial({ map: sleeveTex, roughness: 0.95, envMapIntensity: 0.6 }));
  sleeve.position.y = (S0 + S1) / 2; cupG.add(sleeve);
  const kraftEdge = new T.MeshStandardMaterial({ color: 0x9c8062, roughness: 0.95 });
  [S0, S1].forEach(y => { const r = new T.Mesh(new T.TorusGeometry(rAt(y) + ST * 0.55, ST * 0.55, 8, 128), kraftEdge); r.rotation.x = PI / 2; r.position.y = y; cupG.add(r); });
  const markMesh = new T.Mesh(
    new T.CylinderGeometry(rAt(D1) + 0.004, rAt(D0) + 0.004, D1 - D0, 64, 1, true, -DT, DT * 2),
    new T.MeshStandardMaterial({ map: markTex, transparent: true, roughness: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, envMapIntensity: 0.7 }),
  );
  markMesh.position.y = (D0 + D1) / 2; cupG.add(markMesh);
  const LID_Y = 2.6;
  const lidPts = [[0, 2.6], [0.55, 2.6], [0.66, 2.615], [0.74, 2.68], [0.82, 2.712], [0.92, 2.706], [0.99, 2.672], [1.05, 2.61], [1.11, 2.588], [1.13, 2.54], [1.125, 2.5], [1.09, 2.485]].map(([x, y]) => new T.Vector2(x, y));
  const lid = new T.Mesh(new T.LatheGeometry(new T.SplineCurve(lidPts).getPoints(90), 128), new T.MeshStandardMaterial({ color: 0x2e2621, roughness: 0.32, envMapIntensity: 1.1, side: T.DoubleSide }));
  lid.position.y = -LID_Y; lidG.add(lid);
  const SIP = 0.42;
  const sip = new T.Mesh(new T.BoxGeometry(0.22, 0.04, 0.07), new T.MeshBasicMaterial({ color: 0x0b0806 }));
  sip.position.set(0.87 * Math.sin(SIP), 2.706 - LID_Y, 0.87 * Math.cos(SIP)); sip.rotation.y = SIP; lidG.add(sip);

  const shCv = canvasOf(256, 256), shx = shCv.getContext("2d")!;
  const g = shx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, "rgba(40,50,34,.5)"); g.addColorStop(0.45, "rgba(40,50,34,.22)"); g.addColorStop(1, "rgba(40,50,34,0)");
  shx.fillStyle = g; shx.fillRect(0, 0, 256, 256);
  const shadow = new T.Mesh(new T.PlaneGeometry(2.9, 2.9), new T.MeshBasicMaterial({ map: tex(shCv), transparent: true, depthWrite: false }));
  shadow.rotation.x = -PI / 2; shadow.position.y = 0.002; scene.add(shadow);

  const steamGeo = new T.PlaneGeometry(0.2, 2.0, 1, 60); steamGeo.translate(0, 1.0, 0);
  const ribbons = ([[-0.09, 1.0, 0], [0.03, 0.82, 2.1], [0.13, 0.92, 4.2]] as const).map(([ox, sy, ph]) => {
    const m = new T.Mesh(steamGeo, new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uPhase: { value: ph }, uWind: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: `uniform float uTime; uniform float uPhase; uniform float uWind; varying vec2 vUv;
        void main(){ vUv = uv; vec3 p = position; float h = uv.y; p.x *= 1.0 + h * 2.4;
          p.x += sin(h * 5.0 - uTime * 1.1 + uPhase) * 0.18 * h + sin(h * 12.0 - uTime * 1.8 + uPhase * 1.3) * 0.04 * h;
          p.x += uWind * h * h * 1.5; p.z += cos(h * 4.0 - uTime * 0.9 + uPhase) * 0.08 * h;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `uniform float uOpacity; uniform float uTime; uniform float uPhase; varying vec2 vUv;
        void main(){ float a = smoothstep(0.0,0.5,vUv.x) * smoothstep(1.0,0.5,vUv.x) * smoothstep(0.0,0.14,vUv.y) * (1.0 - smoothstep(0.35,1.0,vUv.y));
          a *= 0.62 + 0.38 * sin(vUv.y * 9.0 - uTime * 1.5 + uPhase); gl_FragColor = vec4(1.0, 1.0, 1.0, a * uOpacity); }`,
      transparent: true, depthWrite: false,
    }));
    m.scale.y = sy; m.userData.ox = ox; scene.add(m); return m;
  });

  // Back the camera off until shadow, cup, lid and steam all fit with a margin.
  const FIT = [[0, 0, 1.4], [0, 0, -1.4], [1.4, 0, 0], [-1.4, 0, 0], [1.2, 2.75, 0], [-1.2, 2.75, 0], [0, 2.8, 1.15], [0, 4.2, 0]].map(([x, y, z]) => new T.Vector3(x, y, z));
  const probe = new T.Vector3(), EL = 0.22;
  const place = (d: number) => { camera.position.set(0, LOOK.y + Math.sin(EL) * d, Math.cos(EL) * d); camera.lookAt(LOOK); camera.updateMatrixWorld(); };
  const fits = () => FIT.every(p => { probe.copy(p).project(camera); return Math.abs(probe.x) <= 0.9 && probe.y >= -0.84 && probe.y <= 0.92; });
  function resize() {
    const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    let lo = 4, hi = 40;
    for (let i = 0; i < 24; i++) { const d = (lo + hi) / 2; place(d); if (fits()) hi = d; else lo = d; }
    place(hi);
  }
  const ro = new ResizeObserver(resize); ro.observe(wrap); resize();

  const ptr = { nx: 0, ny: 0, vx: 0, has: false };
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width * 2 - 1, ny = -((e.clientY - r.top) / r.height * 2 - 1);
    if (ptr.has) ptr.vx += nx - ptr.nx;
    ptr.nx = nx; ptr.ny = ny; ptr.has = true;
  };
  window.addEventListener("pointermove", onMove, { passive: true });
  let drag: { lx: number; t: number; moved: number } | null = null, yaw = 0.12, yawVel = 0, puff = 0;
  const hop = { y: 0, v: 0 }, wob = { a: 0, v: 0 }, lidS = { y: RM ? 0 : 1.5, v: 0, delay: RM ? 0 : 0.35 };
  const onDown = (e: PointerEvent) => { drag = { lx: e.clientX, t: performance.now(), moved: 0 }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; };
  const onDrag = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.lx; drag.lx = e.clientX; drag.moved += Math.abs(dx);
    const now = performance.now(), dts = Math.max(8, now - drag.t) / 1000; drag.t = now;
    yaw += dx * 0.012; yawVel = clamp(dx * 0.012 / dts, -12, 12);
  };
  const onUp = () => { if (!drag) return; if (drag.moved < 6) { hop.v += 2.6; puff = 1.1; wob.v += 1.4; } drag = null; canvas.style.cursor = ""; };
  canvas.addEventListener("pointerdown", onDown); canvas.addEventListener("pointermove", onDrag);
  canvas.addEventListener("pointerup", onUp); canvas.addEventListener("pointercancel", onUp);

  let focus: "name" | "idle" = "idle", focusUntil = 0;
  const sipW = new T.Vector3(), hit = new T.Vector3(), ndc = new T.Vector2();
  const ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1), 0);
  let t = 0, last = performance.now(), raf = 0, visible = true, tiltX = 0, tiltZ = 0, wind = 0;
  function frame(now: number) {
    raf = 0; if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    if (lidS.delay > 0) lidS.delay -= dt; else { lidS.v += (-150 * lidS.y - 14 * lidS.v) * dt; lidS.y += lidS.v * dt; }
    lidG.position.y = LID_Y + lidS.y; lidG.rotation.z = lidS.y * 0.2; lidG.rotation.x = lidS.y * 0.08;
    hop.v += (-150 * hop.y - 13 * hop.v) * dt; hop.y += hop.v * dt;
    wob.v += (-70 * wob.a - 8 * wob.v) * dt; wob.a += wob.v * dt;
    cupG.position.y = Math.max(0, hop.y) + (RM ? 0 : (Math.sin(t * 1.1) * 0.5 + 0.5) * 0.04);
    const txT = RM ? 0 : clamp(-ptr.ny * 0.06, -0.08, 0.1), tzT = RM ? 0 : clamp(-ptr.nx * 0.07, -0.1, 0.1);
    tiltX += (txT - tiltX) * Math.min(1, dt * 3); tiltZ += (tzT - tiltZ) * Math.min(1, dt * 3);
    root.rotation.x = tiltX + wob.a * 0.35; root.rotation.z = tiltZ + wob.a;
    if (!drag) {
      const base = focus === "name" ? -0.5 : now < focusUntil ? 0.44 : 0.12;
      const rest = base + (RM ? 0 : clamp(ptr.nx, -1.5, 1.5) * 0.14);
      const d = Math.atan2(Math.sin(rest - yaw), Math.cos(rest - yaw));
      if (Math.abs(yawVel) < 3) yawVel += d * 12 * dt;
      yawVel *= Math.exp(-(Math.abs(yawVel) > 3 ? 1.1 : 5) * dt); yaw += yawVel * dt;
    }
    spin.rotation.y = yaw + (RM ? 0 : Math.sin(t * 0.45) * 0.025);
    const lift = cupG.position.y;
    shadow.scale.setScalar(1 + lift * 0.5);
    (shadow.material as InstanceType<Three["MeshBasicMaterial"]>).opacity = clamp(1 - lift * 1.6, 0.35, 1);
    sip.getWorldPosition(sipW);
    let windT = 0;
    if (ptr.has && !RM) {
      plane.constant = -sipW.z; ndc.set(ptr.nx, ptr.ny); ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(plane, hit)) {
        const dx = hit.x - sipW.x, dy = hit.y - (sipW.y + 0.9);
        const near = Math.max(0, 1 - Math.hypot(dx / 1.1, dy / 1.3));
        windT = (-Math.sign(dx) * 0.8 + clamp(ptr.vx * 5, -0.9, 0.9)) * near;
      }
    }
    ptr.vx *= Math.exp(-8 * dt); wind += (windT - wind) * Math.min(1, dt * 2); puff *= Math.exp(-2 * dt);
    const steamOn = clamp(1 - lidS.y, 0, 1) * (1 + puff * 0.6);
    ribbons.forEach(r => {
      r.position.set(sipW.x + r.userData.ox, sipW.y - 0.02, sipW.z);
      const u = (r.material as InstanceType<Three["ShaderMaterial"]>).uniforms;
      u.uTime.value = t * (RM ? 0.3 : 1); u.uWind.value = wind; u.uOpacity.value = 0.62 * steamOn;
    });
    if (tickMarks(dt)) { drawMarks(); markTex.needsUpdate = true; }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  });
  io.observe(wrap);

  drawPrint(); drawSleeve();
  document.fonts.ready.then(() => { drawPrint(); drawSleeve(); printTex.needsUpdate = true; sleeveTex.needsUpdate = true; marksDirty = true; }).catch(() => {});

  let first = true;
  const api: CounterCupHandle = {
    setOrder(codes) {
      const changed = codes.some((code, i) => marks.rows[i].text !== code);
      codes.forEach((code, i) => setMark(marks.rows[i], code, first ? 0.75 + i * 0.14 : 0));
      if (first) setMark(marks.here, "✓", 1.5);
      if (!first && changed) wob.v += 1.0;
      first = false;
    },
    showName(name) { setMark(marks.name, name, marks.here.t < 1 ? 1.75 : 0); },
    focus(which) {
      if (which === "name") focus = "name";
      else { focus = "idle"; if (which === "column") focusUntil = performance.now() + 2600; }
    },
  };
  return {
    api,
    dispose() {
      cancelAnimationFrame(raf); visible = false; io.disconnect(); ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      renderer.dispose(); pmrem.dispose(); envTex.dispose();
    },
  };
}
