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
 * A sticky note's hand-drawn layer. Strokes are kept as vectors (x, y,
 * pressure per sample, in pad pixels from the top-left), saved as JSON and
 * rendered here — on the card and, through {@link #renderPng}, for the Manager.
 *
 * While writing, the firmware paints the live stroke ({@link FirmwareInk}) and
 * the pad does not redraw under it: a redraw would repaint the panel over the
 * ink of the next stroke, still being written. It redraws once the pen rests
 * (SETTLE_MS). Without firmware ink it draws the live stroke itself.
 *
 * Only the pen writes; the pen's eraser end removes whole strokes; fingers
 * pass through (the card stays draggable by its header).
 */
final class InkPad extends View {
    interface Listener {
        /** The pen erased: the firmware's live ink of the erased strokes must go. */
        void onErased();
        /** The card's window gained focus while writing: claim the pen again. */
        void onFocusGained();
        /** The card's window lost focus while writing. */
        void onFocusLost();
    }

    private static final long SETTLE_MS = 2000;
    private static final float STROKE_PX = 3.5f;
    private static final float ERASE_RADIUS_PX = 18f;

    /** Each stroke: x0, y0, p0, x1, y1, p1, … */
    private final List<float[]> strokes = new ArrayList<>();
    private final List<Path> paths = new ArrayList<>();
    private float[] cur;
    private int curLen;
    private Path curPath;
    private boolean erasing;
    private boolean writing;
    private boolean firmwareLive;
    private boolean dirty;
    private String hintText = "";
    private Listener listener;

    private final Paint ink = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint frame = new Paint();
    private final Paint hint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Runnable settle = this::invalidate;

    InkPad(Context ctx) {
        super(ctx);
        ink.setColor(Color.BLACK);
        ink.setStyle(Paint.Style.STROKE);
        ink.setStrokeWidth(STROKE_PX);
        ink.setStrokeCap(Paint.Cap.ROUND);
        ink.setStrokeJoin(Paint.Join.ROUND);
        frame.setColor(Color.BLACK);
        frame.setStyle(Paint.Style.STROKE);
        frame.setStrokeWidth(2f);
        hint.setColor(Color.GRAY);
        hint.setTextSize(28f);
        setBackgroundColor(Color.WHITE);
    }

    void setListener(Listener l) { listener = l; }

    void setHint(String s) { hintText = s; }

    /** Writing on (pen claimed or not) or off (the drawing just shows). */
    void setWriting(boolean on, boolean firmwareLive) {
        writing = on;
        this.firmwareLive = on && firmwareLive;
        removeCallbacks(settle);
        cur = null;
        curPath = null;
        invalidate();
    }

    boolean isWriting() { return writing; }

    boolean isEmpty() { return strokes.isEmpty(); }

    int strokeCount() { return strokes.size(); }

    /** Changed since load/save. */
    boolean hasChanges() { return dirty; }

    /** Lowest point drawn, in px (0 when empty): the card sizes the pad on it. */
    int contentBottom() {
        float b = 0;
        for (float[] s : strokes) for (int i = 1; i < s.length; i += 3) b = Math.max(b, s[i]);
        return (int) Math.ceil(b + STROKE_PX);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!writing || listener == null) return;
        if (hasFocus) listener.onFocusGained();
        else listener.onFocusLost();
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        if (!writing) return false;
        int tool = ev.getToolType(0);
        boolean pen = tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER;
        if (!pen) return false;
        switch (ev.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                removeCallbacks(settle);
                erasing = tool == MotionEvent.TOOL_TYPE_ERASER;
                if (erasing) {
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
                if (!firmwareLive && !erasing) invalidate();
                return true;
            case MotionEvent.ACTION_UP:
                if (erasing) {
                    erasing = false;
                    if (listener != null) listener.onErased();
                    invalidate();
                    return true;
                }
                sample(ev.getX(), ev.getY(), ev.getPressure());
                commit();
                if (firmwareLive) postDelayed(settle, SETTLE_MS);
                else invalidate();
                return true;
            case MotionEvent.ACTION_CANCEL:
                // The system took the stream away: keep what was drawn.
                if (!erasing) commit();
                erasing = false;
                invalidate();
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
        if (curLen <= 6) curPath.lineTo(cur[0] + 0.1f, cur[1]); // a dot still shows
        float[] s = new float[curLen];
        System.arraycopy(cur, 0, s, 0, curLen);
        strokes.add(s);
        paths.add(curPath);
        cur = null;
        curPath = null;
        dirty = true;
    }

    private void eraseAt(float x, float y) {
        float r2 = ERASE_RADIUS_PX * ERASE_RADIUS_PX;
        for (int k = strokes.size() - 1; k >= 0; k--) {
            float[] s = strokes.get(k);
            for (int i = 0; i + 1 < s.length; i += 3) {
                float dx = s[i] - x, dy = s[i + 1] - y;
                if (dx * dx + dy * dy <= r2) {
                    strokes.remove(k);
                    paths.remove(k);
                    dirty = true;
                    break;
                }
            }
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (writing) {
            canvas.drawRect(1, 1, getWidth() - 1, getHeight() - 1, frame);
            if (strokes.isEmpty() && cur == null && !hintText.isEmpty()) {
                canvas.drawText(hintText, 16, 40, hint);
            }
        }
        for (Path p : paths) canvas.drawPath(p, ink);
        if (curPath != null && !firmwareLive) canvas.drawPath(curPath, ink);
    }

    // ---- Files --------------------------------------------------------------

    /** Load strokes saved by {@link #save}; a missing or broken file is an empty drawing. */
    void load(File f) {
        strokes.clear();
        paths.clear();
        dirty = false;
        if (f == null || !f.isFile()) { invalidate(); return; }
        try {
            String json = new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8");
            JSONArray arr = new JSONObject(json).getJSONArray("strokes");
            for (int k = 0; k < arr.length(); k++) {
                JSONArray a = arr.getJSONArray(k);
                float[] s = new float[a.length() - a.length() % 3];
                for (int i = 0; i < s.length; i++) s[i] = (float) a.getDouble(i);
                if (s.length < 3) continue;
                strokes.add(s);
                paths.add(pathOf(s));
            }
        } catch (Exception ignored) {}
        invalidate();
    }

    /** Write the strokes as {"v":1,"strokes":[[x,y,p,…],…]} (atomic rename). */
    boolean save(File f) {
        try {
            StringBuilder sb = new StringBuilder("{\"v\":1,\"strokes\":[");
            for (int k = 0; k < strokes.size(); k++) {
                if (k > 0) sb.append(',');
                sb.append('[');
                float[] s = strokes.get(k);
                for (int i = 0; i < s.length; i++) {
                    if (i > 0) sb.append(',');
                    // 0.1 px and 0.01 pressure are plenty.
                    sb.append(i % 3 == 2 ? Math.round(s[i] * 100) / 100f : Math.round(s[i] * 10) / 10f);
                }
                sb.append(']');
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
        for (float[] s : strokes) {
            for (int i = 0; i + 1 < s.length; i += 3) b.union(s[i], s[i + 1]);
        }
        float m = STROKE_PX + 6;
        int w = Math.max(1, (int) Math.ceil(b.width() + 2 * m));
        int h = Math.max(1, (int) Math.ceil(b.height() + 2 * m));
        Bitmap bmp = null;
        try {
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            c.drawColor(Color.WHITE);
            c.translate(m - b.left, m - b.top);
            for (Path p : paths) c.drawPath(p, ink);
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
        if (s.length == 3) p.lineTo(s[0] + 0.1f, s[1]); // a dot
        for (int i = 3; i + 1 < s.length; i += 3) p.lineTo(s[i], s[i + 1]);
        return p;
    }
}
