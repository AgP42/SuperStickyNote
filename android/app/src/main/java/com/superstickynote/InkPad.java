package com.superstickynote;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.MotionEvent;
import android.view.View;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * A handwritten sticky note's ink. Strokes are vectors (x, y, pressure per
 * sample, in pad pixels from the top-left), each with the pen it was written
 * with — the note's own pen, in the firmware's codes (type, width, colour).
 * Saved as JSON, rendered here: on the card and, through {@link #renderPng},
 * for the Manager.
 *
 * While writing, the firmware paints the live stroke ({@link FirmwareInk}) and
 * the pad does not redraw under it: a redraw would repaint the panel over the
 * ink of the next stroke, still being written. It redraws once the pen rests
 * (SETTLE_MS), and its own rendering takes over.
 *
 * Only the pen writes. The eraser tool, or the pen's eraser end, removes whole
 * strokes. Fingers pass through (the card stays draggable by its header).
 */
final class InkPad extends View {
    interface Listener {
        /** Something was erased or undone: the firmware's live ink must go. */
        void onErased();
        /** The card's window gained focus while writing: claim the pen again. */
        void onFocusGained();
        /** The card's window lost focus while writing. */
        void onFocusLost();
        /**
         * The pen came near the pad (hover) or touched it (down): make sure the
         * pen is still the card's before the stroke lands.
         */
        void onPenNear(boolean down);
        /** The undo stack changed (enable/disable the button). */
        void onUndoChanged(boolean canUndo);
        /** At rest: the pen has hovered over the pad for a moment — about to write here. */
        void onPenApproach();
        /** At rest: the pen touched the pad (that stroke went to the page). */
        void onPenDownAtRest();
    }

    // Firmware pen codes (see FirmwareInk).
    static final int PEN_NEEDLE = 10;
    static final int PEN_MARKER = 11;
    static final int PEN_CALLIGRAPHY = 15;
    static final int PEN_INK = 16;
    static final int[] DEFAULT_PEN = {PEN_NEEDLE, 1000, 0};

    private static final long SETTLE_MS = 2000;
    /**
     * Firmware width units → pad px. A first guess, to calibrate against the
     * live firmware ink: tune here if the settled stroke looks thinner or bolder.
     */
    private static final float PX_PER_WIDTH_UNIT = 4.5f / 1000f;
    private static final float ERASE_RADIUS_PX = 18f;

    private static final class Stroke {
        final float[] pts; // x, y, p, …
        final int[] pen;   // type, width, colour (firmware codes)
        final Path path;
        Stroke(float[] pts, int[] pen) { this.pts = pts; this.pen = pen; this.path = pathOf(pts); }
    }

    /** One undoable step: a stroke added, or strokes erased (with their indices). */
    private static final class Op {
        Stroke added;
        final List<Integer> erasedAt = new ArrayList<>();
        final List<Stroke> erased = new ArrayList<>();
    }

    private final List<Stroke> strokes = new ArrayList<>();
    private final List<Op> undo = new ArrayList<>();
    private float[] cur;
    private int curLen;
    private Path curPath;
    private Op eraseOp;
    private boolean erasing;
    private boolean eraserTool;
    private boolean writing;
    private boolean dirty;
    private int[] pen = DEFAULT_PEN;
    private String hintText = "";
    /** A handwritten card not being written on: grey, with an invitation to write. */
    private boolean resting;
    private boolean approachPending;
    private static final long APPROACH_MS = 300;
    private static final int REST_BG = 0xFFEEEEEE;
    private static final String REST_HINT = "✎ Write here";
    private final Runnable approach = () -> {
        approachPending = false;
        if (resting && !this.writing && this.listener != null) this.listener.onPenApproach();
    };
    private Listener listener;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint frame = new Paint();
    private final Paint hint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Runnable settle = this::invalidate;

    InkPad(Context ctx) {
        super(ctx);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeCap(Paint.Cap.ROUND);
        paint.setStrokeJoin(Paint.Join.ROUND);
        frame.setColor(Color.BLACK);
        frame.setStyle(Paint.Style.STROKE);
        frame.setStrokeWidth(2f);
        frame.setPathEffect(new android.graphics.DashPathEffect(new float[]{10f, 8f}, 0f));
        hint.setColor(Color.GRAY);
        hint.setTextSize(28f);
        setBackgroundColor(Color.WHITE);
    }

    void setListener(Listener l) { listener = l; }

    void setHint(String s) { hintText = s; }

    void setResting(boolean on) {
        if (resting == on) return;
        resting = on;
        if (!on) { removeCallbacks(approach); approachPending = false; }
        invalidate();
    }

    /** The pen new strokes are written with (firmware codes). */
    void setPen(int[] p) { pen = p != null ? p : DEFAULT_PEN; }

    void setEraserTool(boolean on) { eraserTool = on; }

    boolean isEraserTool() { return eraserTool; }

    /** Writing on (the firmware inks live) or off (the drawing just shows). */
    void setWriting(boolean on) {
        writing = on;
        eraserTool = false;
        removeCallbacks(settle);
        cur = null;
        curPath = null;
        if (!on) { undo.clear(); notifyUndo(); }
        invalidate();
    }

    boolean isEmpty() { return strokes.isEmpty(); }

    int strokeCount() { return strokes.size(); }

    /** Changed since load/save. */
    boolean hasChanges() { return dirty; }

    /** Lowest point drawn, in px (0 when empty): the card sizes the pad on it. */
    int contentBottom() {
        float b = 0;
        for (Stroke s : strokes) {
            for (int i = 1; i < s.pts.length; i += 3) b = Math.max(b, s.pts[i] + widthOf(s.pen));
        }
        return (int) Math.ceil(b);
    }

    // ---- Undo ---------------------------------------------------------------

    boolean canUndo() { return !undo.isEmpty(); }

    void undo() {
        if (undo.isEmpty()) return;
        Op op = undo.remove(undo.size() - 1);
        if (op.added != null) strokes.remove(op.added);
        // Put erased strokes back where they were, lowest index first.
        for (int k = op.erased.size() - 1; k >= 0; k--) {
            int at = Math.min(op.erasedAt.get(k), strokes.size());
            strokes.add(at, op.erased.get(k));
        }
        dirty = true;
        notifyUndo();
        if (listener != null) listener.onErased(); // the live ink no longer matches
        invalidate();
    }

    private void push(Op op) {
        undo.add(op);
        if (undo.size() > 100) undo.remove(0);
        notifyUndo();
    }

    private void notifyUndo() { if (listener != null) listener.onUndoChanged(canUndo()); }

    // ---- Input --------------------------------------------------------------

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!writing || listener == null) return;
        if (hasFocus) listener.onFocusGained();
        else listener.onFocusLost();
    }

    @Override
    public boolean onHoverEvent(MotionEvent ev) {
        int tool = ev.getToolType(0);
        boolean pen = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
        int a = ev.getActionMasked();
        if (writing && listener != null && pen && a == MotionEvent.ACTION_HOVER_ENTER) listener.onPenNear(false);
        if (!writing && resting && pen) {
            // The pen held over the pad for a moment, not just passing by.
            if (a == MotionEvent.ACTION_HOVER_EXIT) {
                removeCallbacks(approach);
                approachPending = false;
            } else if (!approachPending) {
                approachPending = true;
                postDelayed(approach, APPROACH_MS);
            }
            return true;
        }
        return super.onHoverEvent(ev);
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        int tool = ev.getToolType(0);
        boolean penTool = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
        if (!writing) {
            if (resting && penTool && ev.getActionMasked() == MotionEvent.ACTION_DOWN && listener != null) {
                removeCallbacks(approach);
                approachPending = false;
                listener.onPenDownAtRest();
            }
            return false;
        }
        if (!penTool) return false;
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                if (listener != null) listener.onPenNear(true);
                removeCallbacks(settle);
                erasing = eraserTool || tool == MotionEvent.TOOL_TYPE_ERASER;
                if (erasing) {
                    eraseOp = new Op();
                    eraseAt(ev.getX(), ev.getY());
                } else {
                    cur = new float[96];
                    curLen = 0;
                    curPath = new Path();
                    curPath.moveTo(ev.getX(), ev.getY());
                    add(ev.getX(), ev.getY(), ev.getPressure());
                }
                return true;
            case MotionEvent.ACTION_MOVE:
                for (int h = 0; h < ev.getHistorySize(); h++) {
                    sample(ev.getHistoricalX(h), ev.getHistoricalY(h), ev.getHistoricalPressure(h));
                }
                sample(ev.getX(), ev.getY(), ev.getPressure());
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (erasing) {
                    erasing = false;
                    if (eraseOp != null && !eraseOp.erased.isEmpty()) push(eraseOp);
                    eraseOp = null;
                    if (listener != null) listener.onErased();
                    invalidate();
                    return true;
                }
                if (ev.getActionMasked() == MotionEvent.ACTION_UP) sample(ev.getX(), ev.getY(), ev.getPressure());
                commit();
                postDelayed(settle, SETTLE_MS);
                return true;
            default:
                return true;
        }
    }

    private void sample(float x, float y, float p) {
        if (erasing) { eraseAt(x, y); return; }
        if (cur == null) return;
        add(x, y, p);
        curPath.lineTo(x, y);
    }

    private void add(float x, float y, float p) {
        if (curLen + 3 > cur.length) {
            float[] n = new float[cur.length * 2];
            System.arraycopy(cur, 0, n, 0, curLen);
            cur = n;
        }
        cur[curLen++] = x;
        cur[curLen++] = y;
        cur[curLen++] = p;
    }

    private void commit() {
        if (cur == null) return;
        float[] pts = new float[curLen];
        System.arraycopy(cur, 0, pts, 0, curLen);
        Stroke s = new Stroke(pts, pen);
        strokes.add(s);
        Op op = new Op();
        op.added = s;
        push(op);
        cur = null;
        curPath = null;
        dirty = true;
    }

    private void eraseAt(float x, float y) {
        float r2 = ERASE_RADIUS_PX * ERASE_RADIUS_PX;
        for (int k = strokes.size() - 1; k >= 0; k--) {
            float[] s = strokes.get(k).pts;
            for (int i = 0; i + 1 < s.length; i += 3) {
                float dx = s[i] - x, dy = s[i + 1] - y;
                if (dx * dx + dy * dy <= r2) {
                    Stroke gone = strokes.remove(k);
                    if (eraseOp != null) { eraseOp.erasedAt.add(k); eraseOp.erased.add(gone); }
                    dirty = true;
                    break;
                }
            }
        }
    }

    // ---- Rendering ----------------------------------------------------------

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (writing) {
            canvas.drawRect(1, 1, getWidth() - 1, getHeight() - 1, frame);
            if (strokes.isEmpty() && cur == null && !hintText.isEmpty()) {
                canvas.drawText(hintText, 16, 40, hint);
            }
        } else if (resting) {
            canvas.drawColor(REST_BG);
            canvas.drawText(REST_HINT, 16, getHeight() - 14, hint);
        }
        for (Stroke s : strokes) drawStroke(canvas, s, paint);
    }

    private static float widthOf(int[] pen) {
        float w = Math.max(1.5f, pen[1] * PX_PER_WIDTH_UNIT);
        return pen[0] == PEN_MARKER ? w * 2.5f : w;
    }

    private static int colorOf(int code) {
        switch (code) {
            case -101: case 0x9D: return 0xFF9D9D9D;
            case -102: case 0xC9: return 0xFFC9C9C9;
            case 254: return 0xFFFEFEFE; // = 0xFE, the SDK and firmware agree
            default: return Color.BLACK;
        }
    }

    /**
     * One stroke the way its pen draws it: the pressure pen follows pressure,
     * the calligraphy pen the stroke's direction (a 45° nib), the marker is wide
     * and translucent, the needle constant.
     */
    private static void drawStroke(Canvas c, Stroke s, Paint p) {
        float w = widthOf(s.pen);
        p.setColor(colorOf(s.pen[2]));
        p.setAlpha(s.pen[0] == PEN_MARKER ? 0x90 : 0xFF);
        float[] pts = s.pts;
        boolean variable = s.pen[0] == PEN_INK || s.pen[0] == PEN_CALLIGRAPHY;
        if (!variable || pts.length < 6) {
            p.setStrokeWidth(w);
            c.drawPath(s.path, p);
            return;
        }
        for (int i = 3; i + 2 < pts.length; i += 3) {
            float x0 = pts[i - 3], y0 = pts[i - 2], x1 = pts[i], y1 = pts[i + 1];
            float sw;
            if (s.pen[0] == PEN_INK) {
                float pr = Math.max(0f, Math.min(1f, pts[i + 2]));
                sw = w * (0.35f + 0.95f * pr);
            } else {
                double a = Math.atan2(y1 - y0, x1 - x0) - Math.PI / 4;
                sw = w * (0.3f + 1.1f * (float) Math.abs(Math.sin(a)));
            }
            p.setStrokeWidth(Math.max(1f, sw));
            c.drawLine(x0, y0, x1, y1, p);
        }
    }

    // ---- Files --------------------------------------------------------------

    /** Load strokes saved by {@link #save} (v2), or the v1 format (needle, black). */
    void load(File f) {
        strokes.clear();
        undo.clear();
        dirty = false;
        if (f == null || !f.isFile()) { invalidate(); return; }
        try {
            String json = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
            JSONArray arr = new JSONObject(json).getJSONArray("strokes");
            for (int k = 0; k < arr.length(); k++) {
                Object o = arr.get(k);
                JSONArray a;
                int[] pn = DEFAULT_PEN;
                if (o instanceof JSONObject) {
                    JSONObject so = (JSONObject) o;
                    a = so.getJSONArray("pts");
                    pn = new int[]{so.optInt("pen", PEN_NEEDLE), so.optInt("w", 1000), so.optInt("c", 0)};
                } else {
                    a = (JSONArray) o;
                }
                float[] s = new float[a.length() - a.length() % 3];
                for (int i = 0; i < s.length; i++) s[i] = (float) a.getDouble(i);
                if (s.length < 3) continue;
                strokes.add(new Stroke(s, pn));
            }
        } catch (Exception ignored) {}
        invalidate();
    }

    /**
     * Strokes lassoed on the page: [{pen, w, c, pts:[x, y, p, …]}] in page px,
     * pen/colour in SDK codes, pressure raw. They land at the pad's top-left,
     * shrunk (never enlarged) to fit maxW. Returns how many were kept.
     */
    /** Full pressure on the page (the card keeps 0..1). */
    static final float PAGE_PRESSURE_MAX = 4095f;

    int importPage(String json, float maxW, float maxH) {
        strokes.clear();
        undo.clear();
        List<float[]> raw = new ArrayList<>();
        List<int[]> pens = new ArrayList<>();
        float maxP = 0, maxPen = 0;
        RectF b = new RectF(Float.MAX_VALUE, Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE);
        try {
            JSONArray arr = new JSONArray(json);
            for (int k = 0; k < arr.length(); k++) {
                JSONObject so = arr.getJSONObject(k);
                JSONArray a = so.getJSONArray("pts");
                float[] pts = new float[a.length() - a.length() % 3];
                if (pts.length < 3) continue;
                for (int i = 0; i < pts.length; i++) pts[i] = (float) a.getDouble(i);
                int[] pn = FirmwareInk.mapPen(so.optInt("pen", 10), so.optInt("w", 1000), so.optInt("c", 0));
                if (pn == null) pn = DEFAULT_PEN.clone();
                for (int i = 0; i + 2 < pts.length; i += 3) {
                    b.union(pts[i], pts[i + 1]);
                    maxP = Math.max(maxP, pts[i + 2]);
                }
                maxPen = Math.max(maxPen, widthOf(pn));
                raw.add(pts);
                pens.add(pn);
            }
        } catch (Exception ignored) {}
        if (raw.isEmpty()) { invalidate(); return 0; }
        float m = maxPen + 8;
        float k = Math.min(1f, Math.min(
                Math.max(1f, maxW - 2 * m) / Math.max(1f, b.width()),
                Math.max(1f, maxH - 2 * m) / Math.max(1f, b.height())));
        // Pressure comes raw from the page, 0..4095 (not 0..1 like a MotionEvent):
        // on that scale, so it goes back to the page as it came.
        float pScale = maxP > 1f ? 1f / PAGE_PRESSURE_MAX : 1f;
        for (int j = 0; j < raw.size(); j++) {
            float[] pts = raw.get(j);
            for (int i = 0; i + 2 < pts.length; i += 3) {
                pts[i] = (pts[i] - b.left) * k + m;
                pts[i + 1] = (pts[i + 1] - b.top) * k + m;
                pts[i + 2] = pts[i + 2] * pScale;
            }
            int[] pn = pens.get(j);
            pn[1] = Math.max(1, Math.round(pn[1] * k)); // the line shrinks with the writing
            strokes.add(new Stroke(pts, pn));
        }
        dirty = true;
        invalidate();
        return strokes.size();
    }

    /** Rightmost point drawn, in px. */
    int contentRight() {
        float r = 0;
        for (Stroke s : strokes) {
            for (int i = 0; i < s.pts.length; i += 3) r = Math.max(r, s.pts[i] + widthOf(s.pen));
        }
        return (int) Math.ceil(r);
    }

    /** Write {"v":2,"strokes":[{"pen":10,"w":1000,"c":0,"pts":[x,y,p,…]},…]} (atomic rename). */
    boolean save(File f) {
        try {
            StringBuilder sb = new StringBuilder("{\"v\":2,\"strokes\":[");
            for (int k = 0; k < strokes.size(); k++) {
                Stroke st = strokes.get(k);
                if (k > 0) sb.append(',');
                sb.append("{\"pen\":").append(st.pen[0]).append(",\"w\":").append(st.pen[1])
                        .append(",\"c\":").append(st.pen[2]).append(",\"pts\":[");
                float[] s = st.pts;
                for (int i = 0; i < s.length; i++) {
                    if (i > 0) sb.append(',');
                    // 0.1 px and 0.01 pressure are plenty.
                    sb.append(i % 3 == 2 ? Math.round(s[i] * 100) / 100f : Math.round(s[i] * 10) / 10f);
                }
                sb.append("]}");
            }
            sb.append("]}");
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            File tmp = new File(f.getPath() + ".tmp");
            try (java.io.FileWriter w = new java.io.FileWriter(tmp, false)) { w.write(sb.toString()); }
            if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) return false; }
            dirty = false;
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Render the strokes, cropped to what was drawn, as a PNG on white. Returns {w, h} or null. */
    int[] renderPng(File f) {
        if (strokes.isEmpty()) return null;
        RectF b = new RectF(Float.MAX_VALUE, Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE);
        float maxW = 0;
        for (Stroke s : strokes) {
            maxW = Math.max(maxW, widthOf(s.pen) * 1.4f);
            for (int i = 0; i + 1 < s.pts.length; i += 3) b.union(s.pts[i], s.pts[i + 1]);
        }
        float m = maxW + 6;
        int w = Math.max(1, (int) Math.ceil(b.width() + 2 * m));
        int h = Math.max(1, (int) Math.ceil(b.height() + 2 * m));
        Bitmap bmp = null;
        try {
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            c.drawColor(Color.WHITE);
            c.translate(m - b.left, m - b.top);
            Paint p = new Paint(paint);
            for (Stroke s : strokes) drawStroke(c, s, p);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
            return new int[]{w, h};
        } catch (Exception e) {
            return null;
        } finally {
            if (bmp != null) bmp.recycle();
        }
    }

    private static Path pathOf(float[] s) {
        Path p = new Path();
        p.moveTo(s[0], s[1]);
        if (s.length <= 6) p.lineTo(s[0] + 0.1f, s[1]); // a dot still shows
        for (int i = 3; i + 1 < s.length; i += 3) p.lineTo(s[i], s[i + 1]);
        return p;
    }
}
