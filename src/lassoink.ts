/**
 * The lassoed handwriting as strokes the card can show, erase and add to.
 *
 * Read while the lasso is still active and before the caller recycles `els`.
 * Strokes come in EMR (rotated 90°, horizontal axis flipped) with the extent
 * carried per element as maxX/maxY — converting with those, as SuperDashboard
 * does, stays right on any page size. Geometries (lines, shapes) are already
 * pixels. Everything goes out in page pixels as
 * [{pen, w, c, pts: [x, y, pressure, …]}], pen and colour in SDK codes; the
 * native side moves it to the card's top-left and maps the pens.
 */
import {PluginCommAPI} from 'sn-plugin-lib';

import {blog} from './native';

type Size = {width: number; height: number};
type Out = {pen: number; w: number; c: number; pts: number[]};

const GEO_SAMPLES = 48;

function geoStroke(g: any): Out | null {
  if (!g) return null;
  const pts: number[] = [];
  // No pressure on a shape: mid-pressure on the page's 0..4095 scale, the
  // same 0.5 the page paste gives a point without one.
  const add = (x: number, y: number) => pts.push(x, y, 2048);
  if ((g.type === 'GEO_circle' || g.type === 'GEO_ellipse') && g.ellipseCenterPoint) {
    const {x: cx, y: cy} = g.ellipseCenterPoint;
    const a = g.ellipseMajorAxisRadius || 0;
    const b = g.ellipseMinorAxisRadius || a;
    if (a <= 0) return null;
    const t0 = ((g.ellipseAngle || 0) * Math.PI) / 180;
    for (let i = 0; i <= GEO_SAMPLES; i++) {
      const t = (i / GEO_SAMPLES) * 2 * Math.PI;
      const x = a * Math.cos(t);
      const y = b * Math.sin(t);
      add(cx + x * Math.cos(t0) - y * Math.sin(t0), cy + x * Math.sin(t0) + y * Math.cos(t0));
    }
  } else if (Array.isArray(g.points) && g.points.length >= 2) {
    for (const p of g.points) if (p && typeof p.x === 'number') add(p.x, p.y);
    if (g.type === 'GEO_polygon' && g.points[0]) add(g.points[0].x, g.points[0].y);
  } else {
    return null;
  }
  return {pen: g.penType || 10, w: g.penWidth > 0 ? g.penWidth : 1000, c: g.penColor || 0, pts};
}

/**
 * A five-pointed star (element type 800) as one stroke through its tips in
 * pentagram order. Its points are its tips (the first repeated last), in
 * page pixels like a geometry — or EMR when they come out larger than the
 * page, then converted like a stroke. Ordered by angle here, so the drawing
 * is a star whatever order they come in.
 */
function starStroke(e: any, W: number, H: number): Out | null {
  const raw: any[] = (e.fiveStar && Array.isArray(e.fiveStar.points) ? e.fiveStar.points : []).filter(
    (p: any) => p && typeof p.x === 'number' && typeof p.y === 'number',
  );
  let tips = raw.slice();
  if (tips.length > 1) {
    const a = tips[0];
    const b = tips[tips.length - 1];
    if (a.x === b.x && a.y === b.y) tips.pop();
  }
  if (tips.length < 5) return null;
  tips = tips.slice(0, 5);
  const emr = tips.some(p => p.x > W * 1.5 || p.y > H * 1.5);
  if (emr && e.maxX && e.maxY) {
    tips = tips.map(p => ({x: W - (p.y / e.maxY) * W, y: (p.x / e.maxX) * H}));
  }
  const cx = tips.reduce((t, p) => t + p.x, 0) / 5;
  const cy = tips.reduce((t, p) => t + p.y, 0) / 5;
  tips.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  const pts: number[] = [];
  for (const i of [0, 2, 4, 1, 3, 0]) pts.push(tips[i].x, tips[i].y, 2048);
  blog(`[ink] lasso star ${emr ? '(EMR) ' : ''}points=${JSON.stringify(raw)}`);
  const st = e.stroke || {};
  return {pen: st.penType || 10, w: e.thickness > 0 ? e.thickness : 400, c: st.penColor || 0, pts};
}

/** JSON of the lassoed strokes and shapes, or null when there are none. */
export async function lassoStrokesJson(els: any[], size: Size): Promise<string | null> {
  const W = size.width;
  const H = size.height;
  const out: Out[] = [];
  let logged = false;
  for (const e of els || []) {
    if (e && e.type === 800) {
      try {
        const st = starStroke(e, W, H);
        if (st) out.push(st);
      } catch (err) {
        blog(`[ink] reading a lassoed star failed: ${(err as Error)?.message}`);
      }
      continue;
    }
    if (!e || e.type !== 0 || !e.stroke) continue;
    const maxX = e.maxX || 0;
    const maxY = e.maxY || 0;
    if (!maxX || !maxY) continue;
    try {
      const n = await e.stroke.points.size();
      if (!n) continue;
      const pts = await e.stroke.points.getRange(0, n);
      let prs: number[] = [];
      try {
        const m = await e.stroke.pressures.size();
        if (m) prs = await e.stroke.pressures.getRange(0, m);
      } catch {}
      const a: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p || typeof p.x !== 'number') continue;
        a.push(W - (p.y / maxY) * W, (p.x / maxX) * H, typeof prs[i] === 'number' ? prs[i] : 2048);
      }
      if (a.length < 3) continue;
      if (!logged) {
        // Calibration: what the page says about its pens.
        blog(
          `[ink] lasso stroke pen=${e.stroke.penType} color=${e.stroke.penColor} thickness=${e.thickness} ` +
            `pts=${pts.length} pressure0=${prs[0]}`,
        );
        logged = true;
      }
      out.push({pen: e.stroke.penType, w: e.thickness, c: e.stroke.penColor, pts: a});
    } catch (err) {
      blog(`[ink] reading a lassoed stroke failed: ${(err as Error)?.message}`);
    }
  }
  try {
    const gr: any = await PluginCommAPI.getLassoGeometries();
    const geos: any[] = gr && gr.success && Array.isArray(gr.result) ? gr.result : [];
    for (const g of geos) {
      const s = geoStroke(g);
      if (s) out.push(s);
    }
  } catch (err) {
    blog(`[ink] getLassoGeometries failed: ${(err as Error)?.message}`);
  }
  return out.length ? JSON.stringify(out) : null;
}
