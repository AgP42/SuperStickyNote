package com.superstickynote;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/**
 * The eraser button of a card being written on, drawn like the notebook's own
 * eraser icon: a tilted block with a band. Inverted (white on black) while the
 * eraser is the tool, so the state reads at a glance on e-ink.
 */
final class EraserIcon extends View {
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private boolean on;

    EraserIcon(Context ctx) {
        super(ctx);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeJoin(Paint.Join.ROUND);
        line.setStrokeCap(Paint.Cap.ROUND);
        fill.setStyle(Paint.Style.FILL);
        setContentDescription("Eraser");
    }

    void setOn(boolean on) {
        if (this.on == on) return;
        this.on = on;
        invalidate();
    }

    boolean isOn() { return on; }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        float s = Math.min(w, h);
        int fg = on ? Color.WHITE : Color.BLACK;
        if (on) {
            fill.setColor(Color.BLACK);
            c.drawRoundRect(2, 2, w - 2, h - 2, s * 0.18f, s * 0.18f, fill);
        }
        line.setColor(fg);
        line.setStrokeWidth(Math.max(2f, s * 0.07f));
        float cx = w / 2, cy = h / 2, u = s * 0.30f;
        c.save();
        c.rotate(-40, cx, cy);
        // Block, with the rubber end (left third) filled.
        float l = cx - u * 1.15f, r = cx + u * 1.15f, t = cy - u * 0.55f, b = cy + u * 0.55f;
        fill.setColor(fg);
        c.drawRect(l, t, l + (r - l) * 0.38f, b, fill);
        c.drawRect(l, t, r, b, line);
        c.restore();
        // The line it rubs out.
        Path p = new Path();
        p.moveTo(cx - u * 1.2f, cy + u * 1.35f);
        p.lineTo(cx + u * 1.2f, cy + u * 1.35f);
        c.drawPath(p, line);
    }
}
