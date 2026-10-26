package com.superstickynote;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/**
 * Every button in a card's header, drawn in one style: line icons on a 24×24
 * grid, the same stroke and the same size, so they read as one set on e-ink
 * (font glyphs come in whatever size and weight the font has, when it has them).
 * "On" inverts the icon (white on black): the eraser while it is the tool.
 */
final class ToolIcon extends View {
    enum Kind { PEN, DONE, ERASER, UNDO, PASTE, DELETE, CLOSE }

    private static final float STROKE = 2f; // grid units
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private Kind kind;
    private boolean on;
    private boolean dim;

    ToolIcon(Context ctx, Kind kind) {
        super(ctx);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeJoin(Paint.Join.ROUND);
        line.setStrokeCap(Paint.Cap.ROUND);
        fill.setStyle(Paint.Style.FILL);
        setKind(kind);
    }

    void setKind(Kind k) {
        if (k == kind) return;
        kind = k;
        String d;
        switch (k) {
            case PEN: d = "Write with the pen"; break;
            case DONE: d = "Done"; break;
            case ERASER: d = "Eraser"; break;
            case UNDO: d = "Undo"; break;
            case PASTE: d = "Put on page"; break;
            case DELETE: d = "Delete"; break;
            default: d = "Close";
        }
        setContentDescription(d);
        invalidate();
    }

    Kind kind() { return kind; }

    void setOn(boolean on) {
        if (this.on == on) return;
        this.on = on;
        invalidate();
    }

    boolean isOn() { return on; }

    /** Greyed: nothing to do (undo with nothing to undo). */
    void setDim(boolean dim) {
        if (this.dim == dim) return;
        this.dim = dim;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        float box = Math.min(w, h);
        if (on) {
            fill.setColor(Color.BLACK);
            c.drawRoundRect(2, 2, w - 2, h - 2, box * 0.18f, box * 0.18f, fill);
        }
        int fg = on ? Color.WHITE : dim ? 0xFFB0B0B0 : Color.BLACK;
        float s = box * 0.62f / 24f; // the 24-grid icon fills ~62% of the button
        line.setColor(fg);
        fill.setColor(fg);
        c.save();
        c.translate((w - 24 * s) / 2, (h - 24 * s) / 2);
        c.scale(s, s);
        line.setStrokeWidth(Math.max(2f / s, STROKE));
        switch (kind) {
            case PEN: pen(c); break;
            case DONE: done(c); break;
            case ERASER: eraser(c); break;
            case UNDO: undo(c); break;
            case PASTE: paste(c); break;
            case DELETE: trash(c); break;
            default: close(c);
        }
        c.restore();
    }

    private void pen(Canvas c) {
        Path p = new Path();
        p.moveTo(16.5f, 3.5f);
        p.lineTo(20.5f, 7.5f);
        p.lineTo(8f, 20f);
        p.lineTo(3.5f, 20.5f);
        p.lineTo(4f, 16f);
        p.close();
        c.drawPath(p, line);
        c.drawLine(14f, 6f, 18f, 10f, line);
    }

    private void done(Canvas c) {
        Path p = new Path();
        p.moveTo(4f, 12.5f);
        p.lineTo(9.5f, 18f);
        p.lineTo(20f, 6.5f);
        c.drawPath(p, line);
    }

    private void eraser(Canvas c) {
        c.save();
        c.rotate(-40, 12, 11);
        // Block, with the rubber end filled.
        c.drawRect(4f, 7.5f, 9.5f, 14.5f, fill);
        c.drawRect(4f, 7.5f, 20f, 14.5f, line);
        c.restore();
        c.drawLine(4f, 21f, 20f, 21f, line);
    }

    private void undo(Canvas c) {
        Path p = new Path();
        p.moveTo(9f, 14f);
        p.lineTo(4f, 9f);
        p.lineTo(9f, 4f);
        c.drawPath(p, line);
        Path a = new Path();
        a.moveTo(4f, 9f);
        a.lineTo(14.5f, 9f);
        a.cubicTo(18f, 9f, 20.5f, 11.5f, 20.5f, 14.5f);
        a.cubicTo(20.5f, 17.5f, 18f, 20f, 14.5f, 20f);
        a.lineTo(11f, 20f);
        c.drawPath(a, line);
    }

    private void paste(Canvas c) {
        Path b = new Path();
        b.moveTo(8f, 5f);
        b.lineTo(6f, 5f);
        b.quadTo(4.5f, 5f, 4.5f, 6.5f);
        b.lineTo(4.5f, 20f);
        b.quadTo(4.5f, 21.5f, 6f, 21.5f);
        b.lineTo(18f, 21.5f);
        b.quadTo(19.5f, 21.5f, 19.5f, 20f);
        b.lineTo(19.5f, 6.5f);
        b.quadTo(19.5f, 5f, 18f, 5f);
        b.lineTo(16f, 5f);
        c.drawPath(b, line);
        c.drawRoundRect(8f, 3f, 16f, 7f, 1.2f, 1.2f, line);
        c.drawLine(12f, 10f, 12f, 18f, line);
        c.drawLine(8.8f, 14.8f, 12f, 18f, line);
        c.drawLine(15.2f, 14.8f, 12f, 18f, line);
    }

    private void trash(Canvas c) {
        c.drawLine(4f, 6.5f, 20f, 6.5f, line);
        Path h = new Path();
        h.moveTo(9f, 6.5f);
        h.lineTo(9.5f, 3.5f);
        h.lineTo(14.5f, 3.5f);
        h.lineTo(15f, 6.5f);
        c.drawPath(h, line);
        Path b = new Path();
        b.moveTo(6f, 6.5f);
        b.lineTo(7f, 20.5f);
        b.lineTo(17f, 20.5f);
        b.lineTo(18f, 6.5f);
        c.drawPath(b, line);
        c.drawLine(10f, 10f, 10.3f, 17f, line);
        c.drawLine(14f, 10f, 13.7f, 17f, line);
    }

    private void close(Canvas c) {
        c.drawLine(5.5f, 5.5f, 18.5f, 18.5f, line);
        c.drawLine(18.5f, 5.5f, 5.5f, 18.5f, line);
    }
}
