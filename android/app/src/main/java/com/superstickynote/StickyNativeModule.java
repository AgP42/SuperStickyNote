package com.superstickynote;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Native bridge for SuperStickyNote — a launcher bubble + up to
 * {@link #MAX_CARDS} floating post-it cards, each an inline editor.
 *
 * A card is one WRAP_CONTENT overlay window (touches between cards fall
 * through to the note canvas). Its body is an EditText:
 *  - tap the BODY        → edit inline (window flips FOCUSABLE so the soft
 *                          keyboard opens; ✓ or opening another card restores
 *                          non-focusable so pen/lasso keep working)
 *  - tap the HEADER BAR  → collapse / expand (collapsed shows only the first
 *                          line as the title)
 *  - tap the ICON        → open the Manager (onOpenManager)
 *  - long-press the BODY  → in-card Copy / Paste bar
 *  - drag the header     → move (onCardMoved) · ✕ closes (onCardClose)
 * Text edits stream to JS (onCardEdited).
 */
public class StickyNativeModule extends ReactContextBaseJavaModule {
    /**
     * HARD ceiling on floating cards. The user's own maximum (default 8) is a
     * setting on the JS side; this only stops a runaway sync from opening
     * hundreds of overlay windows.
     */
    static final int MAX_CARDS = 40;
    private static final String BUBBLE_TAG = "SSN_BUBBLE";
    private static final String CARD_TAG_PREFIX = "SSN_CARD:";
    private static final int DEFAULT_FONT_SP = 14;

    private final Handler main = new Handler(Looper.getMainLooper());

    private static WindowManager wm;
    private static View bubbleView;
    private static WindowManager.LayoutParams bubbleParams;
    private static int bubbleX = -1, bubbleY = -1;
    private int bStartX, bStartY;
    private float bStartRawX, bStartRawY;
    private boolean bDragging;

    private static final Map<String, Card> cards = new HashMap<>();
    private static String editingId = null;
    /** Private folder for ink files (captures and drawings), set by JS at boot. */
    private static String inkDir = "";
    /** The firmware pen, claimed by at most ONE card at a time. */
    private static FirmwareInk firmwareInk;
    private static Card writingCard = null;

    private static final class Card {
        String id;
        View view;
        TextView iconView;
        TextView titleView;
        LinearLayout labelsBox;
        View dividerView;
        /** The captured handwriting (PNG), above the text. GONE when there is none. */
        ImageView inkView;
        String inkPath = "";
        EditText body;
        View doneView;
        View closeView;
        /** ✎ to write with the pen in the card; shows ✓ while writing. */
        ToolIcon penBtn;
        ToolIcon pasteBtn;
        ToolIcon undoBtn;
        /** Bottom-left, away from ✕: a first tap arms it (inverted), a second deletes. */
        ToolIcon deleteBtn;
        boolean deleteArmed;
        int deleteGen;
        /** Width before writing widened the card to fit its tools, and the width it was given. */
        int widthBeforeWrite = 0;
        int widenedTo = 0;
        /** The hand-drawn layer, or null while the card has no drawing. */
        InkPad pad;
        /** Eraser · undo, under the pad while writing. */
        ToolIcon eraserBtn;
        String drawPath = "";
        /** Room the card had below its header when writing started: the pad fills at least that. */
        int writeFillH = 0;
        /** When writing last ended: the pen leaving the card (after ✓) must not start it again. */
        long finishedAt = 0;
        /** The icon on show, so a sync that repeats it repaints nothing. */
        String iconKey = null;
        /** "text", "ink" or "mixed" (see applyKind). */
        String kind = "";
        View resizeHandle;
        LinearLayout clipBar;
        WindowManager.LayoutParams params;
        int startX, startY;
        float startRawX, startRawY;
        int startW, startH;
        int fixedHeight; // >0 once the user has resized/loaded a fixed height
        boolean dragging;
        boolean editing;
        boolean collapsed;
        boolean muteWatcher;
        /** The label set last painted, so an unchanged list isn't rebuilt. */
        String labelsKey = null;
        /**
         * Bumped on every LOCAL text change and echoed to JS with the text. A
         * sync carrying a LOWER rev is a stale echo of the user's own typing
         * (the JS round-trip is slower than the keyboard) — see updateCard().
         */
        int rev;
    }

    public StickyNativeModule(ReactApplicationContext ctx) {
        super(ctx);
    }

    @Override
    public String getName() {
        return "StickyNative";
    }

    private void emit(String event, WritableMap payload) {
        getReactApplicationContext()
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(event, payload);
    }

    // ---- Permission -------------------------------------------------------

    @ReactMethod
    public void checkPermission(Promise promise) {
        boolean ok = Build.VERSION.SDK_INT < 23
                || Settings.canDrawOverlays(getReactApplicationContext());
        promise.resolve(ok);
    }

    @ReactMethod
    public void requestPermission(Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("PERM_REQ_FAILED", e.getMessage(), e);
        }
    }

    // ---- Launcher bubble --------------------------------------------------

    @ReactMethod
    public void showBubble(Promise promise) {
        main.post(() -> {
            try {
                Context ctx = getReactApplicationContext();
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
                    promise.reject("NO_PERMISSION", "overlay permission not granted");
                    return;
                }
                removeBubbleInternal();
                wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

                ImageView glyph = new ImageView(ctx);
                glyph.setTag(BUBBLE_TAG);
                // Draw the icon ourselves (Canvas) — loading R.drawable inside the
                // plugin host proved unreliable (rendered a broken-image bar).
                glyph.setImageBitmap(makeBubbleIcon(dp(28)));
                glyph.setPadding(dp(12), dp(12), dp(12), dp(12));
                glyph.setBackground(roundedBg(Color.WHITE, Color.BLACK, dp(20), dp(3)));

                bubbleParams = overlayParams();
                final boolean first = bubbleX < 0;
                bubbleParams.x = bubbleX >= 0 ? bubbleX : dp(40);
                bubbleParams.y = bubbleY >= 0 ? bubbleY : dp(120);

                glyph.setOnTouchListener((v, ev) -> {
                    switch (ev.getAction()) {
                        case MotionEvent.ACTION_DOWN:
                            bStartX = bubbleParams.x; bStartY = bubbleParams.y;
                            bStartRawX = ev.getRawX(); bStartRawY = ev.getRawY();
                            bDragging = false;
                            return true;
                        case MotionEvent.ACTION_MOVE: {
                            float dx = ev.getRawX() - bStartRawX, dy = ev.getRawY() - bStartRawY;
                            if (!bDragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) bDragging = true;
                            if (bDragging) {
                                int maxX = Math.max(0, screenW() - v.getWidth());
                                int maxY = Math.max(0, screenH() - v.getHeight());
                                bubbleParams.x = clamp(bStartX + (int) dx, 0, maxX);
                                bubbleParams.y = clamp(bStartY + (int) dy, 0, maxY);
                                bubbleX = bubbleParams.x; bubbleY = bubbleParams.y;
                                try { wm.updateViewLayout(bubbleView, bubbleParams); } catch (Exception ignored) {}
                            }
                            return true;
                        }
                        case MotionEvent.ACTION_UP:
                            if (!bDragging) emit("onNewNote", Arguments.createMap());
                            return true;
                        default:
                            return false;
                    }
                });

                bubbleView = glyph;
                wm.addView(bubbleView, bubbleParams);
                if (first) {
                    glyph.post(() -> {
                        try {
                            int x = Math.max(0, screenW() - glyph.getWidth() - dp(12));
                            bubbleParams.x = x; bubbleX = x; bubbleY = bubbleParams.y;
                            wm.updateViewLayout(glyph, bubbleParams);
                        } catch (Exception ignored) {}
                    });
                }
                promise.resolve(true);
            } catch (Exception e) {
                promise.reject("SHOW_BUBBLE_FAILED", e.getMessage(), e);
            }
        });
    }

    @ReactMethod
    public void hideBubble(Promise promise) {
        main.post(() -> { removeBubbleInternal(); promise.resolve(true); });
    }

    private void removeBubbleInternal() {
        if (bubbleView != null && wm != null) {
            try { wm.removeView(bubbleView); } catch (Exception ignored) {}
        }
        bubbleView = null;
        bubbleParams = null;
    }

    // ---- Cards ------------------------------------------------------------

    /**
     * Reconcile on-screen cards with the given open notes. Each entry:
     * {id, icon, body, x, y, collapsed, fontSize}. Beyond MAX_CARDS ignored;
     * cards not in the list are removed.
     */
    @ReactMethod
    public void syncCards(ReadableArray notes, Promise promise) {
        main.post(() -> {
            try {
                Context ctx = getReactApplicationContext();
                if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) {
                    promise.reject("NO_PERMISSION", "overlay permission not granted");
                    return;
                }
                wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);

                int count = Math.min(notes.size(), MAX_CARDS);
                List<String> wanted = new ArrayList<>();
                for (int i = 0; i < count; i++) wanted.add(notes.getMap(i).getString("id"));

                for (String id : new ArrayList<>(cards.keySet())) {
                    if (!wanted.contains(id)) removeCardInternal(id);
                }

                for (int i = 0; i < count; i++) {
                    ReadableMap n = notes.getMap(i);
                    String id = n.getString("id");
                    String icon = n.hasKey("icon") ? n.getString("icon") : "";
                    String body = n.hasKey("body") ? n.getString("body") : "";
                    List<String> labels = new ArrayList<>();
                    if (n.hasKey("labels") && !n.isNull("labels")) {
                        com.facebook.react.bridge.ReadableArray la = n.getArray("labels");
                        if (la != null) for (int k = 0; k < la.size(); k++) labels.add(la.getString(k));
                    }
                    String font = n.hasKey("font") && !n.isNull("font") ? n.getString("font") : "sans";
                    boolean collapsed = n.hasKey("collapsed") && n.getBoolean("collapsed");
                    String ink = n.hasKey("ink") && !n.isNull("ink") ? n.getString("ink") : "";
                    String drawing = n.hasKey("drawing") && !n.isNull("drawing") ? n.getString("drawing") : "";
                    String kind = n.hasKey("kind") && !n.isNull("kind") ? n.getString("kind") : "text";
                    int fontSp = n.hasKey("fontSize") && !n.isNull("fontSize")
                            ? n.getInt("fontSize") : DEFAULT_FONT_SP;
                    int x = n.hasKey("x") && !n.isNull("x") ? n.getInt("x") : -1;
                    int y = n.hasKey("y") && !n.isNull("y") ? n.getInt("y") : -1;
                    int w = n.hasKey("w") && !n.isNull("w") ? n.getInt("w") : -1;
                    int h = n.hasKey("h") && !n.isNull("h") ? n.getInt("h") : -1;
                    // Revision of the body JS last heard from THIS card (-1 = unknown).
                    int rev = n.hasKey("rev") && !n.isNull("rev") ? n.getInt("rev") : -1;
                    if (x < 0 || y < 0) {
                        x = dp(24) + (i % 4) * dp(30);
                        y = dp(90) + (i % 4) * dp(30);
                    }
                    Card existing = cards.get(id);
                    if (existing != null) {
                        updateCard(existing, icon, body, labels, x, y, w, h, collapsed, fontSp, rev);
                    } else {
                        addCard(ctx, id, icon, body, labels, x, y, w, h, collapsed, fontSp);
                    }
                    applyInk(cards.get(id), ink);
                    applyKind(cards.get(id), kind);
                    applyDrawing(cards.get(id), drawing);
                    applyFont(cards.get(id), font);
                }
                promise.resolve(true);
            } catch (Exception e) {
                promise.reject("SYNC_CARDS_FAILED", e.getMessage(), e);
            }
        });
    }

    @ReactMethod
    public void hideAllCards(Promise promise) {
        main.post(() -> {
            for (String id : new ArrayList<>(cards.keySet())) removeCardInternal(id);
            promise.resolve(true);
        });
    }

    @ReactMethod
    public void beginEdit(String id, Promise promise) {
        main.post(() -> {
            Card c = cards.get(id);
            if (c != null) { if (c.collapsed) setCollapsed(c, false); enterEdit(c); }
            promise.resolve(c != null);
        });
    }

    @ReactMethod
    public void bringToFront(String id, Promise promise) {
        main.post(() -> {
            Card c = cards.get(id);
            if (c != null && wm != null) {
                try { wm.removeView(c.view); wm.addView(c.view, c.params); } catch (Exception ignored) {}
            }
            promise.resolve(true);
        });
    }

    private void addCard(Context ctx, String id, String icon, String body, List<String> labels,
                         int x, int y, int w, int h, boolean collapsed, int fontSp) {
        Card c = new Card();
        c.id = id;
        c.collapsed = collapsed;
        final boolean fixedH = h > 0;
        c.fixedHeight = fixedH ? h : 0;

        LinearLayout panel = new LinearLayout(ctx);
        panel.setTag(CARD_TAG_PREFIX + id);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(roundedBg(Color.WHITE, Color.BLACK, dp(10), dp(3)));
        panel.setPadding(dp(10), dp(8), dp(10), dp(10));

        // Header (single row): icon (→ manager) · title · label chips · ✓ done · ✕ close.
        // The title takes the leftover space (weight) so the label chips sit right
        // after it and get clipped by the card edge when there's no room. Tapping
        // the header (except icon/done/close) collapses/expands — labels are inert.
        LinearLayout header = new LinearLayout(ctx);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView iconV = new TextView(ctx);
        iconV.setTextColor(Color.BLACK);
        iconV.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        iconV.setPadding(dp(8), dp(8), dp(12), dp(8));
        iconV.setMinWidth(dp(44));
        iconV.setMinHeight(dp(44));
        iconV.setGravity(Gravity.CENTER);
        header.addView(iconV, wrapLP());
        c.iconView = iconV;
        setIcon(c, icon);

        TextView titleV = new TextView(ctx);
        titleV.setText(firstLine(body, false, false));
        titleV.setTextColor(Color.BLACK);
        titleV.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp); // title scales with the size setting
        titleV.setTypeface(titleV.getTypeface(), android.graphics.Typeface.BOLD);
        titleV.setSingleLine(true);
        titleV.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleLP =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(titleV, titleLP);
        c.titleView = titleV;

        LinearLayout labelsBox = new LinearLayout(ctx);
        labelsBox.setOrientation(LinearLayout.HORIZONTAL);
        labelsBox.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(labelsBox, wrapLP());
        c.labelsBox = labelsBox;
        fillLabels(ctx, labelsBox, labels);

        // Tools, all the same size and style (ToolIcon). The eraser and undo show
        // only while writing; paste only when not. ✕ keeps its distance: a tap
        // that misses a tool must not close the card.
        ToolIcon eraserV = toolIcon(ctx, header, ToolIcon.Kind.ERASER);
        eraserV.setVisibility(View.GONE);
        c.eraserBtn = eraserV;
        ToolIcon undoV = toolIcon(ctx, header, ToolIcon.Kind.UNDO);
        undoV.setVisibility(View.GONE);
        undoV.setDim(true);
        c.undoBtn = undoV;
        c.pasteBtn = toolIcon(ctx, header, ToolIcon.Kind.PASTE);
        ToolIcon doneV = toolIcon(ctx, header, ToolIcon.Kind.DONE); // finishes typing
        doneV.setVisibility(View.GONE);
        c.doneView = doneV;
        c.penBtn = toolIcon(ctx, header, ToolIcon.Kind.PEN);
        ToolIcon closeV = toolIcon(ctx, header, ToolIcon.Kind.CLOSE);
        ((LinearLayout.LayoutParams) closeV.getLayoutParams()).leftMargin = dp(20);
        c.closeView = closeV;

        panel.addView(header, matchWidthLP());

        View div = new View(ctx);
        div.setBackgroundColor(Color.BLACK);
        LinearLayout.LayoutParams divLP =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
        divLP.topMargin = dp(6); divLP.bottomMargin = dp(6);
        panel.addView(div, divLP);
        c.dividerView = div;

        // Captured handwriting, shown as drawn. Read-only: the text below stays
        // the editable part. WRAP width keeps it at its size on the page (a
        // one-word capture is not blown up to the card's width); a wider one is
        // scaled down to fit, keeping its aspect ratio.
        ImageView inkV = new ImageView(ctx);
        inkV.setAdjustViewBounds(true);
        inkV.setScaleType(ImageView.ScaleType.FIT_START);
        inkV.setVisibility(View.GONE);
        LinearLayout.LayoutParams inkLP = wrapLP();
        inkLP.bottomMargin = dp(6);
        panel.addView(inkV, inkLP);
        c.inkView = inkV;

        EditText bodyV = new EditText(ctx);
        bodyV.setBackgroundColor(Color.TRANSPARENT);
        bodyV.setPadding(0, 0, 0, 0);
        bodyV.setTextColor(Color.BLACK);
        bodyV.setHintTextColor(Color.parseColor("#000000"));
        bodyV.setHint("Tap to type…");
        bodyV.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
        bodyV.setGravity(Gravity.TOP | Gravity.START);
        bodyV.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        bodyV.setSingleLine(false);
        bodyV.setMinLines(2);
        // No maxLines cap: the body fills the card's height (all lines that fit)
        // and scrolls for the rest. Only cap the height when the card auto-sizes
        // (not user-resized), so a long note doesn't grow the card off-screen.
        if (!fixedH) bodyV.setMaxHeight(dp(260));
        bodyV.setVerticalScrollBarEnabled(true);
        c.muteWatcher = true;
        bodyV.setText(body);
        c.muteWatcher = false;
        c.body = bodyV;

        bodyV.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int cnt) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int cnt) {}
            @Override public void afterTextChanged(Editable e) {
                c.titleView.setText(titleFor(c, e.toString()));
                // Stream to JS (JS debounces the disk write) so text is never lost —
                // a focusable overlay can't reliably detect blur, so we don't wait for it.
                if (c.muteWatcher) return;
                WritableMap m = Arguments.createMap();
                m.putString("id", c.id);
                m.putString("body", e.toString());
                m.putInt("rev", ++c.rev);
                emit("onCardEdited", m);
            }
        });
        // Flip the window focusable as EARLY as possible (on touch-down), so the
        // keyboard can open on this very tap. Doing it only on click-up lost the
        // window-focus race and forced a second tap. We return false so the
        // EditText still handles the tap (cursor placement + view focus).
        bodyV.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == MotionEvent.ACTION_DOWN && !c.editing) {
                setWindowFocusable(c, true);
            }
            return false;
        });
        bodyV.setOnClickListener(v -> enterEdit(c));
        bodyV.setOnLongClickListener(v -> { toggleClipBar(c); return true; });
        // Auto-save when the post-it loses focus (tap the note, dismiss keyboard, …).
        bodyV.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus && c.editing) exitEdit(c, true);
        });

        LinearLayout.LayoutParams bodyLP = fixedH
                ? new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
                : matchWidthLP();
        panel.addView(bodyV, bodyLP);

        // In-card Copy / Paste bar (hidden until long-press).
        LinearLayout clip = new LinearLayout(ctx);
        clip.setOrientation(LinearLayout.HORIZONTAL);
        clip.setVisibility(View.GONE);
        LinearLayout.LayoutParams clipLP = matchWidthLP();
        clipLP.topMargin = dp(6);
        clip.addView(makeClipBtn(ctx, "Copy", v -> doCopy(c)), wrapLP());
        clip.addView(makeClipBtn(ctx, "Paste", v -> doPaste(c)), wrapLP());
        panel.addView(clip, clipLP);
        c.clipBar = clip;

        // Bottom-right resize handle.
        TextView handle = new TextView(ctx);
        handle.setText("◢");
        handle.setTextColor(Color.BLACK);
        handle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        // Generous on the top/left so the finger has somewhere to land without
        // covering the text, tight on the bottom/right where the corner is.
        handle.setPadding(dp(18), dp(12), dp(6), dp(6));
        handle.setMinWidth(dp(48));
        handle.setMinHeight(dp(44));
        handle.setGravity(Gravity.BOTTOM | Gravity.END);
        // Bottom row: the bin on the left (far from ✕), the resize handle on the right.
        LinearLayout bottom = new LinearLayout(ctx);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(Gravity.BOTTOM);
        ToolIcon delV = new ToolIcon(ctx, ToolIcon.Kind.DELETE);
        bottom.addView(delV, new LinearLayout.LayoutParams(dp(TOOL_DP), dp(TOOL_DP)));
        delV.setOnClickListener(v -> onDeleteTap(c));
        c.deleteBtn = delV;
        bottom.addView(new View(ctx), new LinearLayout.LayoutParams(0, 1, 1f));
        bottom.addView(handle, wrapLP());
        panel.addView(bottom, matchWidthLP());
        c.resizeHandle = handle;

        WindowManager.LayoutParams lp = overlayParams();
        lp.width = w > 0 ? w : dp(200);
        if (fixedH) lp.height = h;
        lp.x = x; lp.y = y;
        c.params = lp;
        c.view = panel;

        // While editing the window carries FLAG_WATCH_OUTSIDE_TOUCH, so a tap
        // anywhere outside the post-it lands here as ACTION_OUTSIDE → commit + close.
        panel.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == MotionEvent.ACTION_OUTSIDE) {
                logLine("ACTION_OUTSIDE editing=" + c.editing + " id=" + c.id);
                if (c.editing) exitEdit(c, true);
                // The PEN outside the card ends writing; a resting palm or a
                // finger does not.
                int tool = ev.getToolType(0);
                if (c == writingCard && (tool == MotionEvent.TOOL_TYPE_STYLUS
                        || tool == MotionEvent.TOOL_TYPE_ERASER)) {
                    finishWriting(c);
                }
            }
            return false;
        });

        header.setOnTouchListener((v, ev) -> {
            switch (ev.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    c.startX = c.params.x; c.startY = c.params.y;
                    c.startRawX = ev.getRawX(); c.startRawY = ev.getRawY();
                    c.dragging = false;
                    return true;
                case MotionEvent.ACTION_MOVE: {
                    float dx = ev.getRawX() - c.startRawX, dy = ev.getRawY() - c.startRawY;
                    if (!c.dragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) c.dragging = true;
                    if (c.dragging) {
                        int maxX = Math.max(0, screenW() - v.getWidth());
                        int maxY = Math.max(0, screenH() - v.getHeight());
                        c.params.x = clamp(c.startX + (int) dx, 0, maxX);
                        c.params.y = clamp(c.startY + (int) dy, 0, maxY);
                        try { wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
                    }
                    return true;
                }
                case MotionEvent.ACTION_UP:
                    if (c.dragging) {
                        WritableMap m = Arguments.createMap();
                        m.putString("id", c.id);
                        m.putInt("x", c.params.x);
                        m.putInt("y", c.params.y);
                        emit("onCardMoved", m);
                    } else if (hitView(c.iconView, ev)) {
                        emit("onOpenManager", Arguments.createMap());
                    } else if (hitView(c.labelsBox, ev)) {
                        emit("onOpenManager", Arguments.createMap()); // tap labels → open Manager
                    } else if (c == writingCard && hitView(c.eraserBtn, ev)) {
                        boolean on = !c.eraserBtn.isOn();
                        c.eraserBtn.setOn(on);
                        if (c.pad != null) c.pad.setEraserTool(on);
                        // Nothing to paint while erasing: no live ink trailing the eraser.
                        firmwareInk().setWritable(!on);
                        logLine("[ink] eraser tool " + (on ? "on" : "off"));
                    } else if (c == writingCard && hitView(c.undoBtn, ev)) {
                        if (c.pad != null) c.pad.undo();
                    } else if (hitView(c.pasteBtn, ev)) {
                        // Save what is being written first: JS pastes the saved note.
                        if (c == writingCard) finishWriting(c);
                        WritableMap m = Arguments.createMap();
                        m.putString("id", c.id);
                        emit("onCardPaste", m);
                    } else if (hitView(c.penBtn, ev)) {
                        if (c == writingCard) finishWriting(c);
                        else startWriting(c);
                    } else if (hitView(c.doneView, ev)) {
                        exitEdit(c, true);
                    } else if (hitView(c.closeView, ev)) {
                        if (c == writingCard) finishWriting(c);
                        exitEdit(c, false);
                        removeCardInternal(c.id);
                        WritableMap m = Arguments.createMap();
                        m.putString("id", c.id);
                        emit("onCardClose", m);
                    } else {
                        // tap on the bar → collapse / expand
                        if (c.editing) exitEdit(c, true);
                        setCollapsed(c, !c.collapsed);
                        WritableMap m = Arguments.createMap();
                        m.putString("id", c.id);
                        m.putBoolean("collapsed", c.collapsed);
                        emit("onCardCollapsed", m);
                    }
                    return true;
                default:
                    return false;
            }
        });

        handle.setOnTouchListener((v, ev) -> {
            switch (ev.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    c.startRawX = ev.getRawX(); c.startRawY = ev.getRawY();
                    c.startW = c.params.width > 0 ? c.params.width : c.view.getWidth();
                    c.startH = c.params.height > 0 ? c.params.height : c.view.getHeight();
                    // Freeze current size and let the body fill the growing height.
                    c.params.width = c.startW; c.params.height = c.startH;
                    c.fixedHeight = c.startH;
                    LinearLayout.LayoutParams blp =
                            (LinearLayout.LayoutParams) c.body.getLayoutParams();
                    blp.height = 0; blp.weight = 1f;
                    c.body.setLayoutParams(blp);
                    c.body.setMaxHeight(Integer.MAX_VALUE); // fill the resized height
                    try { wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
                    return true;
                case MotionEvent.ACTION_MOVE:
                    c.params.width = clamp((int) (c.startW + (ev.getRawX() - c.startRawX)),
                            dp(140), screenW());
                    c.params.height = clamp((int) (c.startH + (ev.getRawY() - c.startRawY)),
                            dp(90), screenH());
                    c.fixedHeight = c.params.height;
                    try { wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
                    return true;
                case MotionEvent.ACTION_UP: {
                    WritableMap m = Arguments.createMap();
                    m.putString("id", c.id);
                    m.putInt("w", c.params.width);
                    m.putInt("h", c.params.height);
                    emit("onCardResized", m);
                    return true;
                }
                default:
                    return false;
            }
        });

        try {
            wm.addView(panel, lp);
            cards.put(id, c);
            applyCollapse(c);
        } catch (Exception ignored) {}
    }

    private void updateCard(Card c, String icon, String body, List<String> labels,
                            int x, int y, int w, int h, boolean collapsed, int fontSp,
                            int rev) {
        try {
            setIcon(c, icon);
            c.titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
            // fillLabels() tears down and rebuilds a TextView + GradientDrawable per
            // label, forcing a relayout and an e-ink repaint of the card. Skip it
            // whenever the list is the same one we already painted.
            String labelsKey = joinLabels(labels);
            if (c.labelsBox != null && !labelsKey.equals(c.labelsKey)) {
                fillLabels(c.labelsBox.getContext(), c.labelsBox, labels);
                c.labelsKey = labelsKey;
            }
            c.body.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
            // A payload whose rev is BEHIND our counter is an echo of the user's own
            // typing that crossed the bridge late: applying it would rewind the text
            // and — because setText() collapses the selection — drop the caret to 0,
            // scrambling the sentence being typed (device 2026-09-20).
            boolean staleEcho = rev >= 0 && rev < c.rev;
            // The point of skipping while editing is to not yank the text from
            // under someone's fingers. But Android keeps VIEW focus when a window
            // loses WINDOW focus, so opening the Manager left c.editing true and
            // the card then ignored every update from it until it was closed and
            // reopened. Nobody can be typing here without window focus.
            boolean typingHere = c.editing && c.view != null && c.view.hasWindowFocus();
            if (!typingHere && !staleEcho && !c.body.getText().toString().equals(body)) {
                int sel = c.body.getSelectionStart();
                c.muteWatcher = true;
                c.body.setText(body);
                c.muteWatcher = false;
                if (sel > 0) { // setText() puts the caret at 0 — put it back
                    try {
                        c.body.setSelection(Math.min(sel, c.body.getText().length()));
                    } catch (Exception ignored) {}
                }
                c.titleView.setText(titleFor(c, body));
            }
            if (w > 0 && c != writingCard) c.params.width = w;
            if (h > 0) {
                c.fixedHeight = h;
                LinearLayout.LayoutParams blp = (LinearLayout.LayoutParams) c.body.getLayoutParams();
                if (blp.weight != 1f) { blp.height = 0; blp.weight = 1f; c.body.setLayoutParams(blp); }
                c.body.setMaxHeight(Integer.MAX_VALUE);
            }
            if (c.collapsed != collapsed) { c.collapsed = collapsed; }
            applyCollapse(c); // also applies height (fixedHeight vs wrap)
            c.params.x = x; c.params.y = y;
            wm.updateViewLayout(c.view, c.params);
        } catch (Exception ignored) {}
    }

    private static final Map<String, android.graphics.Typeface> fontCache = new HashMap<>();

    /** Resolve a font selection to a Typeface: system keys, or a MyStyle/fonts path (cached). */
    private android.graphics.Typeface fontFor(String sel) {
        if (sel == null || sel.isEmpty() || "sans".equals(sel)) return android.graphics.Typeface.SANS_SERIF;
        if ("serif".equals(sel)) return android.graphics.Typeface.SERIF;
        if ("mono".equals(sel)) return android.graphics.Typeface.MONOSPACE;
        android.graphics.Typeface tf = fontCache.get(sel);
        if (tf == null) {
            try { tf = android.graphics.Typeface.createFromFile(sel); }
            catch (Exception e) { tf = android.graphics.Typeface.SANS_SERIF; }
            fontCache.put(sel, tf);
        }
        return tf;
    }

    /**
     * Show the card's handwriting PNG, or hide the view. Decoded only when the
     * path changes — a sync carries every open card, and re-decoding on each one
     * would repaint the e-ink panel for nothing. A missing file (a backup
     * restored on another device) just leaves the text.
     */
    private void applyInk(Card c, String path) {
        if (c == null || c.inkView == null) return;
        String p = path == null ? "" : path;
        if (p.equals(c.inkPath)) return;
        android.graphics.Bitmap bmp = null;
        if (!p.isEmpty() && new File(p).isFile()) {
            try { bmp = android.graphics.BitmapFactory.decodeFile(p); } catch (Exception ignored) {}
        }
        c.inkPath = bmp != null ? p : "";
        c.inkView.setImageBitmap(bmp);
        // Auto-sized cards cap the picture like the body, so a tall capture
        // doesn't push the card off-screen; a resized card gives the text the rest.
        c.inkView.setMaxHeight(dp(260));
        c.titleView.setText(titleFor(c, c.body.getText().toString()));
        applyCollapse(c);
    }

    private void applyFont(Card c, String path) {
        if (c == null) return;
        android.graphics.Typeface tf = fontFor(path);
        if (c.titleView != null) c.titleView.setTypeface(tf, android.graphics.Typeface.BOLD);
        if (c.body != null) c.body.setTypeface(tf);
    }

    /** List usable font files in MyStyle/fonts as [{name, path}]. */
    @ReactMethod
    public void listFonts(Promise promise) {
        try {
            File dir = new File("/storage/emulated/0/MyStyle/fonts");
            File[] files = dir.listFiles();
            com.facebook.react.bridge.WritableArray out = Arguments.createArray();
            if (files != null) {
                java.util.Arrays.sort(files, (a, b) -> a.getName().compareToIgnoreCase(b.getName()));
                for (File f : files) {
                    String n = f.getName().toLowerCase();
                    if (f.isFile() && (n.endsWith(".ttf") || n.endsWith(".otf"))) {
                        WritableMap m = Arguments.createMap();
                        m.putString("name", f.getName().replaceAll("(?i)\\.(ttf|otf)$", ""));
                        m.putString("path", f.getAbsolutePath());
                        out.pushMap(m);
                    }
                }
            }
            promise.resolve(out);
        } catch (Exception e) {
            promise.reject("LIST_FONTS_FAILED", e.getMessage(), e);
        }
    }

    private static String joinLabels(List<String> labels) {
        if (labels == null || labels.isEmpty()) return "";
        StringBuilder sb = new StringBuilder();
        for (String l : labels) sb.append(l).append('\u0001');
        return sb.toString();
    }

    private void setCollapsed(Card c, boolean collapsed) {
        c.collapsed = collapsed;
        applyCollapse(c);
    }

    private void applyCollapse(Card c) {
        int vis = c.collapsed ? View.GONE : View.VISIBLE;
        refreshTitle(c);
        c.dividerView.setVisibility(vis);
        // A handwritten note has no text to type; nor does a card being written on.
        c.body.setVisibility(c == writingCard || "ink".equals(c.kind) ? View.GONE : vis);
        c.resizeHandle.setVisibility(vis);
        c.deleteBtn.setVisibility(vis);
        if (c.collapsed) disarmDelete(c);
        if (c.pad != null) c.pad.setVisibility(vis);
        if (c.inkView != null) {
            c.inkView.setVisibility(c.collapsed || c.inkPath.isEmpty() ? View.GONE : View.VISIBLE);
        }
        if (c.collapsed) {
            c.clipBar.setVisibility(View.GONE);
            c.params.height = WindowManager.LayoutParams.WRAP_CONTENT; // shrink to the bar
        } else {
            c.params.height = c.fixedHeight > 0
                    ? c.fixedHeight : WindowManager.LayoutParams.WRAP_CONTENT;
        }
        try { if (wm != null) wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
    }

    // ---- Copy / paste -----------------------------------------------------

    private TextView makeClipBtn(Context ctx, String label, View.OnClickListener cb) {
        TextView t = new TextView(ctx);
        t.setText(label);
        t.setTextColor(Color.BLACK);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        t.setPadding(dp(12), dp(5), dp(12), dp(5));
        t.setBackground(roundedBg(Color.WHITE, Color.BLACK, dp(8), dp(2)));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(8);
        t.setLayoutParams(lp);
        t.setOnClickListener(cb);
        return t;
    }

    private void toggleClipBar(Card c) {
        boolean show = c.clipBar.getVisibility() != View.VISIBLE;
        c.clipBar.setVisibility(show ? View.VISIBLE : View.GONE);
        try { if (wm != null) wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
    }

    private ClipboardManager clipboard() {
        return (ClipboardManager) getReactApplicationContext()
                .getSystemService(Context.CLIPBOARD_SERVICE);
    }

    /** System clipboard access for the Manager editor (RN core no longer ships Clipboard). */
    @ReactMethod
    public void clipboardSet(String text, Promise promise) {
        main.post(() -> {
            try {
                clipboard().setPrimaryClip(ClipData.newPlainText("supersticky", text == null ? "" : text));
                promise.resolve(true);
            } catch (Exception e) { promise.reject("CLIP_SET", e.getMessage(), e); }
        });
    }

    @ReactMethod
    public void clipboardGet(Promise promise) {
        main.post(() -> {
            try {
                ClipboardManager cm = clipboard();
                String out = "";
                if (cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                        && cm.getPrimaryClip().getItemCount() > 0) {
                    CharSequence cs = cm.getPrimaryClip().getItemAt(0)
                            .coerceToText(getReactApplicationContext());
                    out = cs == null ? "" : cs.toString();
                }
                promise.resolve(out);
            } catch (Exception e) { promise.reject("CLIP_GET", e.getMessage(), e); }
        });
    }

    private void doCopy(Card c) {
        try {
            clipboard().setPrimaryClip(ClipData.newPlainText("post-it", c.body.getText().toString()));
            Toast.makeText(getReactApplicationContext(), "Copied", Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) {}
        c.clipBar.setVisibility(View.GONE);
    }

    private void doPaste(Card c) {
        try {
            ClipboardManager cm = clipboard();
            if (cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                    && cm.getPrimaryClip().getItemCount() > 0) {
                CharSequence paste = cm.getPrimaryClip().getItemAt(0).coerceToText(getReactApplicationContext());
                if (paste != null) {
                    Editable e = c.body.getText();
                    int start = c.body.getSelectionStart();
                    int end = c.body.getSelectionEnd();
                    if (start < 0 || end < 0) { e.append(paste); }
                    else { e.replace(Math.min(start, end), Math.max(start, end), paste); }
                    // Save now (edits otherwise persist only on focus-out).
                    WritableMap m = Arguments.createMap();
                    m.putString("id", c.id);
                    m.putString("body", c.body.getText().toString());
                    m.putInt("rev", c.rev);
                    emit("onCardEdited", m);
                }
            }
        } catch (Exception ignored) {}
        c.clipBar.setVisibility(View.GONE);
    }

    // ---- Writing with the pen in a card ----------------------------------

    /**
     * The Manager is on screen. The pen draws live ink over a plugin view, and
     * nothing there records it: so while the Manager shows, the pen is ours
     * with the ink off. Writing happens on a card (it claims with ink on, and
     * hands back to "ink off" when done).
     */
    private boolean managerOpen;

    private void inkOffForManager() {
        firmwareInk().claim();
        firmwareInk().setWritable(false);
    }

    @ReactMethod
    public void setManagerOpen(boolean open, Promise promise) {
        main.post(() -> {
            managerOpen = open;
            if (open) {
                if (writingCard != null) finishWriting(writingCard); // it re-applies "ink off"
                else inkOffForManager();
                logLine("[ink] Manager open → pen ink off");
            } else if (writingCard == null && firmwareInk().isClaimed()) {
                firmwareInk().release();
            }
            promise.resolve(true);
        });
    }

    private FirmwareInk firmwareInk() {
        if (firmwareInk == null) firmwareInk = new FirmwareInk(this::logLine);
        return firmwareInk;
    }

    private File drawingFile(Card c) {
        return !c.drawPath.isEmpty() ? new File(c.drawPath) : new File(inkDir, "draw_" + c.id + ".json");
    }

    /**
     * What the card is: "text" (typed, no pen), "ink" (handwritten, no
     * keyboard) or "mixed" (a note from before the two kinds: it shows both).
     */
    private void applyKind(Card c, String kind) {
        if (c == null) return;
        String k = kind == null || kind.isEmpty() ? "text" : kind;
        if (k.equals(c.kind)) return;
        c.kind = k;
        if ("text".equals(k) && c == writingCard) finishWriting(c);
        c.penBtn.setVisibility("text".equals(k) ? View.GONE : View.VISIBLE);
        c.titleView.setText(titleFor(c, c.body.getText().toString()));
        refreshRest(c);
        applyCollapse(c);
    }

    /**
     * A handwritten card always shows its pad, grey with "✎ Write here" while
     * nobody writes on it, so the pen has somewhere to go and a reason to.
     */
    private void refreshRest(Card c) {
        boolean ink = "ink".equals(c.kind);
        if (ink) ensurePad(c);
        if (c.pad != null) c.pad.setResting(ink && c != writingCard);
        sizePad(c);
    }

    /** Show (or drop) the card's saved drawing. Never touches a card being written on. */
    private void applyDrawing(Card c, String path) {
        if (c == null || c == writingCard) return;
        String p = path == null ? "" : path;
        if (p.equals(c.drawPath)) return;
        c.drawPath = p;
        if (p.isEmpty()) {
            if ("ink".equals(c.kind)) { ensurePad(c); c.pad.load(null); refreshRest(c); }
            else removePad(c);
            return;
        }
        ensurePad(c);
        c.pad.load(new File(p));
        sizePad(c);
        applyCollapse(c);
    }

    private void ensurePad(Card c) {
        if (c.pad != null) return;
        Context ctx = c.view.getContext();
        InkPad pad = new InkPad(ctx);
        pad.setHint("Write here with the pen · ✓ to finish");
        LinearLayout panel = (LinearLayout) c.view;
        // Under the captured ink, above the text.
        int at = panel.indexOfChild(c.body);
        panel.addView(pad, at, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(40)));

        pad.setListener(new InkPad.Listener() {
            @Override public void onErased() { firmwareInk().clearInk(); }
            @Override public void onFocusGained() {
                if (c == writingCard) {
                    logLine("[ink] focus gained → claim");
                    claimFor(c);
                }
            }
            @Override public void onPenNear(boolean down) {
                if (c != writingCard) return;
                // The firmware can hand the pen back to the note without the
                // card losing focus (seen once on the Manta: strokes on the
                // card AND on the page). Claiming is cheap and idempotent, so
                // claim again each time the pen comes near, before it writes.
                boolean focus = c.view != null && c.view.hasWindowFocus();
                if (!focus) logLine("[ink] pen " + (down ? "down" : "near") + " but the card has no focus → claim");
                if (!down || !focus) claimFor(c);
            }
            @Override public void onFocusLost() {
                logLine("[ink] focus lost while writing");
                // Another window took focus (the Manager, a dialog): the firmware
                // has handed the pen back, so stop writing — unless focus returns
                // at once, as it can while the window flags change.
                main.postDelayed(() -> {
                    if (c == writingCard && c.view != null && !c.view.hasWindowFocus()) finishWriting(c);
                }, 400);
            }
            @Override public void onUndoChanged(boolean canUndo) { c.undoBtn.setDim(!canUndo); }
            @Override public void onPenApproach() {
                if (c == writingCard || !"ink".equals(c.kind) || c.collapsed) return;
                if (android.os.SystemClock.uptimeMillis() - c.finishedAt < 1500) return;
                logLine("[ink] pen over " + c.id + " → writing");
                startWriting(c);
            }
            @Override public void onPenDownAtRest() {
                if (c == writingCard || !"ink".equals(c.kind) || c.collapsed) return;
                // The pen leaving ✓ is not a new stroke on the card.
                if (android.os.SystemClock.uptimeMillis() - c.finishedAt < 1500) return;
                // The approach was not seen in time: that stroke is on the page.
                logLine("[ink] pen down on resting " + c.id + " (no hover seen) → writing");
                startWriting(c);
                if (c == writingCard) {
                    Toast.makeText(getReactApplicationContext(),
                            "Now writing in the sticky note", Toast.LENGTH_SHORT).show();
                }
            }
        });
        c.pad = pad;
    }

    private void removePad(Card c) {
        if (c.pad == null) return;
        try { ((LinearLayout) c.view).removeView(c.pad); } catch (Exception ignored) {}
        c.pad = null;
        try { if (wm != null) wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
    }

    /**
     * The pad is the card's whole content when there is no text under it (a
     * handwritten note, or any card being written on): it fills a card the
     * user sized, and while writing it is never smaller than the card was,
     * with room below what is there. A mixed card shows just the drawing.
     */
    private void sizePad(Card c) {
        if (c.pad == null) return;
        int content = c.pad.contentBottom();
        boolean alone = c == writingCard || "ink".equals(c.kind);
        int h;
        float weight = 0f;
        if (alone && c.fixedHeight > 0) {
            h = 0;
            weight = 1f;
        } else if (c == writingCard) {
            h = Math.max(Math.max(dp(200), content + dp(140)), c.writeFillH);
            h = Math.min(h, Math.max(dp(200), screenH() * 7 / 10));
        } else if ("ink".equals(c.kind)) {
            h = Math.max(dp(84), content + dp(40)); // the drawing, and "✎ Write here" under it
            h = Math.min(h, Math.max(dp(200), screenH() * 7 / 10));
        } else {
            h = Math.max(dp(24), content + dp(4));
        }
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) c.pad.getLayoutParams();
        if (lp.height != h || lp.weight != weight) { lp.height = h; lp.weight = weight; c.pad.setLayoutParams(lp); }
        try { if (wm != null) wm.updateViewLayout(c.view, c.params); } catch (Exception ignored) {}
    }

    private void startWriting(Card c) {
        if (inkDir.isEmpty() || !firmwareInk().available()) {
            Toast.makeText(getReactApplicationContext(),
                    "Writing in a sticky note isn't available on this device", Toast.LENGTH_LONG).show();
            logLine("[ink] cannot write: inkDir=" + inkDir + " service=" + firmwareInk().available());
            return;
        }
        if (writingCard != null && writingCard != c) finishWriting(writingCard);
        if (c.editing) exitEdit(c, true);
        if (c.collapsed) {
            setCollapsed(c, false);
            // The store must know, or its next sync folds the card back mid-writing.
            WritableMap cm = Arguments.createMap();
            cm.putString("id", c.id);
            cm.putBoolean("collapsed", false);
            emit("onCardCollapsed", cm);
        }
        // The frame takes the whole card: at least the room under the header now.
        int top = c.pad != null && c.pad.getVisibility() == View.VISIBLE ? c.pad.getTop() : c.dividerView.getBottom();
        c.writeFillH = Math.max(0, c.view.getHeight() - top - c.view.getPaddingBottom()
                - c.resizeHandle.getHeight());
        ensurePad(c);
        writingCard = c;
        applyTools(c);
        // Room for the writing tools in the header.
        int minW = dp(4 * TOOL_DP + 20 + 44 + 24);
        c.widthBeforeWrite = 0;
        c.widenedTo = 0;
        if (c.params.width > 0 && c.params.width < minW) {
            c.widthBeforeWrite = c.params.width;
            c.widenedTo = minW;
            c.params.width = minW;
        }
        c.pad.setPen(firmwareInk().pen());
        c.pad.setResting(false);
        c.pad.setWriting(true);
        applyCollapse(c);
        sizePad(c);
        setWindowFocusable(c, true);
        // Claim now AND on every focus gain: the firmware hands the pen to
        // whichever window takes focus.
        c.pad.post(() -> { if (c == writingCard) claimFor(c); });
        logLine("[ink] writing in " + c.id);
        WritableMap m = Arguments.createMap();
        m.putString("id", c.id);
        emit("onCardWriting", m);
    }

    /** Take the pen for the writing card, live ink off if its eraser is on. */
    private void claimFor(Card c) {
        firmwareInk().claim();
        if (c.pad != null && c.pad.isEraserTool()) firmwareInk().setWritable(false);
    }

    /**
     * Stop writing: save the drawing, give the pen back to the note. Always
     * tells JS how many strokes are left, so an empty handwritten note can go.
     */
    private void finishWriting(Card c) {
        if (c != writingCard) return;
        writingCard = null;
        c.finishedAt = android.os.SystemClock.uptimeMillis();
        if (c.pad != null) c.pad.setWriting(false);
        firmwareInk().release();
        if (managerOpen) inkOffForManager(); // back over the Manager: no ink there
        setWindowFocusable(c, false);
        applyTools(c);
        // Back to its width, unless the user resized it meanwhile (then theirs stands).
        if (c.widthBeforeWrite > 0 && c.params.width == c.widenedTo) {
            c.params.width = c.widthBeforeWrite;
            // A tap on ◢ while writing stored the wide width: store this one.
            WritableMap rm = Arguments.createMap();
            rm.putString("id", c.id);
            rm.putInt("w", c.params.width);
            rm.putInt("h", c.fixedHeight > 0 ? c.fixedHeight : -1);
            emit("onCardResized", rm);
        }
        c.widthBeforeWrite = 0;
        c.widenedTo = 0;
        WritableMap m = Arguments.createMap();
        m.putString("id", c.id);
        if (c.pad == null || c.pad.isEmpty()) {
            boolean had = !c.drawPath.isEmpty();
            if (had) drawingFile(c).delete();
            c.drawPath = "";
            if (!"ink".equals(c.kind)) removePad(c);
            m.putInt("count", 0);
            m.putBoolean("changed", had);
            emit("onCardDrawn", m);
        } else if (c.pad.hasChanges()) {
            File json = drawingFile(c);
            boolean saved = c.pad.save(json);
            File png = new File(inkDir, "draw_" + c.id + "_" + System.currentTimeMillis() + ".png");
            int[] size = c.pad.renderPng(png);
            logLine("[ink] saved " + c.pad.strokeCount() + " strokes to " + json + " ok=" + saved
                    + " png=" + (size != null ? size[0] + "x" + size[1] : "failed"));
            if (saved) {
                c.drawPath = json.getPath();
                m.putInt("count", c.pad.strokeCount());
                m.putBoolean("changed", true);
                m.putString("strokes", json.getPath());
                m.putString("png", size != null ? png.getPath() : "");
                m.putInt("w", size != null ? size[0] : 0);
                m.putInt("h", size != null ? size[1] : 0);
                emit("onCardDrawn", m);
            }
        }
        refreshRest(c);
        applyCollapse(c);
    }

    /** JS: open a card straight in writing (a new handwritten note from the bubble). */
    @ReactMethod
    public void beginWriting(String id, Promise promise) {
        main.post(() -> {
            Card c = cards.get(id);
            if (c != null) startWriting(c);
            promise.resolve(c != null && c == writingCard);
        });
    }

    /**
     * JS: handwriting lassoed on the page → the strokes of note `id`, saved and
     * rendered like a drawing written in the card (so it can be erased and
     * added to). Resolves {strokes, png, w, h, count, cardW} or null.
     */
    @ReactMethod
    public void importDrawing(String json, String id, Promise promise) {
        main.post(() -> {
            try {
                if (inkDir.isEmpty()) { promise.resolve(null); return; }
                InkPad pad = new InkPad(getReactApplicationContext());
                int maxW = screenW() * 3 / 4 - dp(20);
                int maxH = screenH() * 6 / 10;
                int n = pad.importPage(json, maxW, maxH);
                if (n == 0) { promise.resolve(null); return; }
                File js = new File(inkDir, "draw_" + id + ".json");
                File png = new File(inkDir, "draw_" + id + "_" + System.currentTimeMillis() + ".png");
                boolean saved = pad.save(js);
                int[] size = pad.renderPng(png);
                logLine("[ink] imported " + n + " lassoed strokes into " + id + " ok=" + saved
                        + " png=" + (size != null ? size[0] + "x" + size[1] : "failed"));
                if (!saved) { promise.resolve(null); return; }
                WritableMap m = Arguments.createMap();
                m.putString("strokes", js.getPath());
                m.putString("png", size != null ? png.getPath() : "");
                m.putInt("w", size != null ? size[0] : 0);
                m.putInt("h", size != null ? size[1] : 0);
                m.putInt("count", n);
                // Wide enough to show it at its size: the card's padding around the pad.
                m.putInt("cardW", Math.max(dp(200), pad.contentRight() + dp(24)));
                promise.resolve(m);
            } catch (Throwable e) {
                logLine("[ink] import failed: " + e);
                promise.resolve(null);
            }
        });
    }

    @ReactMethod
    public void setInkDir(String path, Promise promise) {
        inkDir = path == null ? "" : path;
        promise.resolve(true);
    }

    /**
     * The note's pen (getPenInfo): the card writes with it, and sets it back
     * when it gives the pen back. Called just after writing starts.
     */
    @ReactMethod
    public void setNotePen(int type, int width, int color, Promise promise) {
        main.post(() -> {
            int[] pen = firmwareInk().setNotePen(type, width, color);
            logLine("[ink] note pen type=" + type + " width=" + width + " color=" + color
                    + (pen == null ? " → no pen code, writing with the needle" : " → " + pen[0] + "/" + pen[1] + "/" + pen[2]));
            if (writingCard != null && writingCard.pad != null) writingCard.pad.setPen(firmwareInk().pen());
            promise.resolve(pen != null);
        });
    }

    // ---- Inline edit (focusable toggle → soft keyboard) -------------------

    private void setWindowFocusable(Card c, boolean focusable) {
        try {
            if (focusable) {
                c.params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                c.params.flags |= WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
            } else {
                c.params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                c.params.flags &= ~WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
            }
            if (wm != null) wm.updateViewLayout(c.view, c.params);
        } catch (Exception ignored) {}
    }

    private void enterEdit(Card c) {
        if (c.editing) return;
        if (c == writingCard) finishWriting(c);
        if (editingId != null && !editingId.equals(c.id)) {
            Card prev = cards.get(editingId);
            if (prev != null) exitEdit(prev, true);
        }
        c.editing = true;
        editingId = c.id;
        setWindowFocusable(c, true); // usually already flipped on touch-down
        c.doneView.setVisibility(View.VISIBLE);
        c.body.setFocusableInTouchMode(true);
        final InputMethodManager imm = (InputMethodManager)
                getReactApplicationContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        // The window's focus grant is asynchronous; fire a few attempts so the
        // keyboard reliably opens on the FIRST tap whenever the grant lands.
        for (int d : new int[] {0, 120, 280}) {
            main.postDelayed(() -> {
                if (!c.editing) return;
                c.body.requestFocus();
                c.body.setSelection(c.body.getText().length());
                if (imm != null) imm.showSoftInput(c.body, InputMethodManager.SHOW_FORCED);
            }, d);
        }
        // "Kick" the window once the keyboard has settled: re-applying the layout
        // registers FLAG_WATCH_OUTSIDE_TOUCH so the FIRST tap outside dismisses it.
        // (Without this the user had to move the card first to trigger the same
        // updateViewLayout before outside-tap worked — device 2026-08-15.)
        main.postDelayed(() -> { if (c.editing) setWindowFocusable(c, true); }, 450);
    }

    private void exitEdit(Card c, boolean emitText) {
        if (!c.editing) return;
        logLine("exitEdit id=" + c.id + " emit=" + emitText);
        c.editing = false;
        if (c.id.equals(editingId)) editingId = null;
        try {
            InputMethodManager imm = (InputMethodManager)
                    getReactApplicationContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(c.body.getWindowToken(), 0);
        } catch (Exception ignored) {}
        c.body.clearFocus();
        c.doneView.setVisibility(View.GONE);
        setWindowFocusable(c, false);
        if (emitText) {
            WritableMap m = Arguments.createMap();
            m.putString("id", c.id);
            m.putString("body", c.body.getText().toString());
            m.putInt("rev", c.rev);
            emit("onCardEdited", m);
        }
    }

    private void removeCardInternal(String id) {
        Card c = cards.get(id);
        if (c != null && c == writingCard) finishWriting(c);
        c = cards.remove(id);
        if (c != null) {
            if (c.id.equals(editingId)) editingId = null;
            if (c.view != null && wm != null) {
                try { wm.removeView(c.view); } catch (Exception ignored) {}
            }
        }
    }

    private boolean hitView(View target, MotionEvent ev) {
        if (target == null || target.getVisibility() != View.VISIBLE) return false;
        int[] loc = new int[2];
        target.getLocationOnScreen(loc);
        float rx = ev.getRawX(), ry = ev.getRawY();
        return rx >= loc[0] && rx <= loc[0] + target.getWidth()
                && ry >= loc[1] && ry <= loc[1] + target.getHeight();
    }

    /**
     * The header's title: the text's first line. A handwritten card shows its
     * ink, not a placeholder, so with no title it shows none (the Manager can
     * give it one).
     */
    private String titleFor(Card c, String body) {
        boolean hand = "ink".equals(c.kind) || !c.inkPath.isEmpty() || c.pad != null;
        // Folded, the ink is hidden: an untitled card would be an empty bar.
        return firstLine(body, hand, "ink".equals(c.kind) && !c.collapsed);
    }

    private void refreshTitle(Card c) {
        String t = titleFor(c, c.body.getText().toString());
        if (!t.contentEquals(c.titleView.getText())) c.titleView.setText(t);
    }

    private static String firstLine(String body, boolean hasInk, boolean handwritten) {
        String none = handwritten ? "" : hasInk ? "Handwritten note" : "Untitled";
        if (body == null) return none;
        for (String line : body.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) return t;
        }
        return none;
    }

    // ---- Ghost cleanup ----------------------------------------------------

    /**
     * JS teardown: finish the card being written on (saves it, sends
     * onCardDrawn) BEFORE JS writes notes.json and clearAll removes the
     * windows. Resolves whether a card was being written on.
     */
    @ReactMethod
    public void finishWritingNow(Promise promise) {
        main.post(() -> {
            boolean was = writingCard != null;
            if (was) {
                try { finishWriting(writingCard); } catch (Throwable ignored) {}
            }
            promise.resolve(was);
        });
    }

    @ReactMethod
    @SuppressWarnings("unchecked")
    public void clearAll(Promise promise) {
        main.post(() -> {
            int removed = 0;
            // Teardown: never leave the pen claimed (the note could not write),
            // and finish while the card's window is still there.
            if (writingCard != null) {
                try { finishWriting(writingCard); } catch (Throwable ignored) {}
            }
            try {
                Class<?> wmg = Class.forName("android.view.WindowManagerGlobal");
                Object inst = wmg.getMethod("getInstance").invoke(null);
                java.lang.reflect.Field f = wmg.getDeclaredField("mViews");
                f.setAccessible(true);
                List<View> views = (List<View>) f.get(inst);
                WindowManager w = (WindowManager) getReactApplicationContext()
                        .getSystemService(Context.WINDOW_SERVICE);
                for (View v : new ArrayList<>(views)) {
                    Object tag = v != null ? v.getTag() : null;
                    if (tag instanceof String
                            && (BUBBLE_TAG.equals(tag) || ((String) tag).startsWith(CARD_TAG_PREFIX))) {
                        try { w.removeViewImmediate(v); removed++; } catch (Exception ignored) {}
                    }
                }
            } catch (Throwable ignored) {}
            if (firmwareInk != null && firmwareInk.isClaimed()) firmwareInk.release();
            writingCard = null;
            bubbleView = null; bubbleParams = null;
            cards.clear();
            editingId = null;
            if (promise != null) promise.resolve(removed);
        });
    }

    // ---- Files / PluginJanitor -------------------------------------------

    /**
     * The host process's PRIVATE files dir (/data/.../files). App-private, never
     * cloud-synced and permission-free — the safe fallback for notes.json when
     * PluginManager.getPluginDirPath() is unavailable, instead of a visible
     * (cloud-synced) MyStyle folder.
     */
    @ReactMethod
    public void getFilesDir(Promise promise) {
        try {
            promise.resolve(getReactApplicationContext().getFilesDir().getAbsolutePath());
        } catch (Exception e) {
            promise.reject("FILESDIR_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void writeFile(String path, String content, Promise promise) {
        try {
            File f = new File(path);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            File tmp = new File(path + ".tmp");
            try (java.io.FileWriter w = new java.io.FileWriter(tmp, false)) {
                w.write(content); w.flush();
            }
            if (!tmp.renameTo(f)) {
                f.delete();
                if (!tmp.renameTo(f)) throw new java.io.IOException("rename failed");
            }
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("WRITE_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void readTextFile(String path, Promise promise) {
        try {
            File f = new File(path);
            if (!f.exists()) { promise.resolve(""); return; }
            byte[] all = java.nio.file.Files.readAllBytes(f.toPath());
            promise.resolve(new String(all, "UTF-8"));
        } catch (Exception e) {
            promise.reject("READ_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void deleteFile(String path, Promise promise) {
        try {
            File f = new File(path);
            promise.resolve(!f.exists() || f.delete());
        } catch (Exception e) {
            promise.reject("DELETE_FAILED", e.getMessage(), e);
        }
    }

    /** Copy a file (the handwriting to and from the .json backup's folder). */
    @ReactMethod
    public void copyFile(String from, String to, Promise promise) {
        try {
            File src = new File(from);
            if (!src.isFile()) { promise.resolve(false); return; }
            File dst = new File(to);
            File parent = dst.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            java.nio.file.Files.copy(src.toPath(), dst.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("COPY_FAILED", e.getMessage(), e);
        }
    }

    /** Delete the files directly in `dir` whose name is not in `keepNames`. Resolves how many. */
    @ReactMethod
    public void pruneDir(String dir, ReadableArray keepNames, Promise promise) {
        try {
            java.util.Set<String> keep = new java.util.HashSet<>();
            for (int i = 0; i < keepNames.size(); i++) keep.add(keepNames.getString(i));
            File[] files = new File(dir).listFiles();
            int n = 0;
            if (files != null) {
                for (File f : files) {
                    if (f.isFile() && !keep.contains(f.getName()) && f.delete()) n++;
                }
            }
            promise.resolve(n);
        } catch (Exception e) {
            promise.reject("PRUNE_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void fileExists(String path, Promise promise) {
        try {
            promise.resolve(new File(path).isFile());
        } catch (Exception e) {
            promise.reject("EXISTS_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void ensureDir(String path, Promise promise) {
        try {
            File d = new File(path);
            if (!d.exists()) d.mkdirs();
            promise.resolve(d.isDirectory());
        } catch (Exception e) {
            promise.reject("MKDIR_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void cleanupOldVersions(String dirPath, Promise promise) {
        try {
            File dir = new File(dirPath);
            File[] files = dir.listFiles();
            WritableMap m = Arguments.createMap();
            if (files == null) { m.putDouble("freed", 0); m.putString("kept", "none"); promise.resolve(m); return; }
            long maxTs = -1;
            for (File f : files) {
                String n = f.getName();
                if (n.startsWith("app_") && n.endsWith(".npk")) {
                    long ts = leadingTs(n.substring(4));
                    if (ts > maxTs) maxTs = ts;
                }
            }
            if (maxTs < 0) { m.putDouble("freed", 0); m.putString("kept", "none"); promise.resolve(m); return; }
            String keep = Long.toString(maxTs);
            long freed = 0;
            for (File f : files) {
                String n = f.getName();
                if (n.startsWith("app_") && !n.contains(keep)) freed += deleteRecursively(f);
            }
            File oat = new File(dir, "oat");
            if (oat.isDirectory()) freed += cleanOat(oat, keep);
            m.putDouble("freed", (double) freed);
            m.putString("kept", keep);
            promise.resolve(m);
        } catch (Exception e) {
            promise.reject("CLEANUP_FAILED", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void appendLog(String text, Promise promise) {
        try {
            File f = new File("/storage/emulated/0/MyStyle/superstickynote-log.txt");
            if (f.length() > 262_144) f.delete();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) { w.write(text + "\n"); }
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("LOG_FAILED", e.getMessage(), e);
        }
    }

    /** Append a diagnostic line to the same log file the JS side uses. */
    private void logLine(String s) {
        try {
            File f = new File("/storage/emulated/0/MyStyle/superstickynote-log.txt");
            if (f.length() > 262_144) f.delete();
            try (java.io.FileWriter w = new java.io.FileWriter(f, true)) {
                w.write("[native] " + s + "\n");
            }
        } catch (Exception ignored) {}
    }

    private static long leadingTs(String s) {
        int i = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
        if (i == 0) return -1;
        try { return Long.parseLong(s.substring(0, i)); } catch (Exception e) { return -1; }
    }

    private static long deleteRecursively(File f) {
        long sum = 0;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) sum += deleteRecursively(k);
        } else { sum += f.length(); }
        f.delete();
        return sum;
    }

    private static long cleanOat(File oat, String keep) {
        long sum = 0;
        File[] kids = oat.listFiles();
        if (kids == null) return 0;
        for (File k : kids) {
            if (k.isDirectory()) sum += cleanOat(k, keep);
            else if (k.getName().startsWith("app_") && !k.getName().contains(keep)) {
                sum += k.length(); k.delete();
            }
        }
        return sum;
    }

    // ---- View helpers -----------------------------------------------------

    private WindowManager.LayoutParams overlayParams() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.OPAQUE);
        lp.gravity = Gravity.TOP | Gravity.START;
        return lp;
    }

    /** Draw the Tabler "square-plus-2" glyph (rounded square, open corner + plus). */
    /** The plugin's own sticky-note glyph (a note with a folded corner), drawn rather than typed. */
    static final String STICKY_ICON = "sticky";

    private Bitmap stickyIconBmp;

    private void setIcon(Card c, String icon) {
        String key = icon == null ? "" : icon;
        if (key.equals(c.iconKey)) return; // repainting it would flash the e-ink panel
        c.iconKey = key;
        if (STICKY_ICON.equals(icon)) {
            c.iconView.setText("");
            if (stickyIconBmp == null) stickyIconBmp = makeStickyIcon(dp(26));
            android.graphics.drawable.BitmapDrawable d = new android.graphics.drawable.BitmapDrawable(
                    c.iconView.getResources(), stickyIconBmp);
            c.iconView.setCompoundDrawablesWithIntrinsicBounds(d, null, null, null);
        } else {
            c.iconView.setCompoundDrawablesWithIntrinsicBounds(null, null, null, null);
            c.iconView.setText(icon);
        }
    }

    /** assets/icon.png, drawn: a rounded square whose bottom-right corner is folded over. */
    private Bitmap makeStickyIcon(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.BLACK);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(size * 2f / 24f);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        float s = size / 24f;
        Path path = new Path();
        path.moveTo(14 * s, 21 * s);
        path.lineTo(5 * s, 21 * s);
        path.quadTo(3 * s, 21 * s, 3 * s, 19 * s);
        path.lineTo(3 * s, 5 * s);
        path.quadTo(3 * s, 3 * s, 5 * s, 3 * s);
        path.lineTo(19 * s, 3 * s);
        path.quadTo(21 * s, 3 * s, 21 * s, 5 * s);
        path.lineTo(21 * s, 14 * s);
        path.lineTo(14 * s, 21 * s);
        cv.drawPath(path, p);
        // The fold.
        Path fold = new Path();
        fold.moveTo(14 * s, 21 * s);
        fold.lineTo(14 * s, 16 * s);
        fold.quadTo(14 * s, 14 * s, 16 * s, 14 * s);
        fold.lineTo(21 * s, 14 * s);
        cv.drawPath(fold, p);
        return bmp;
    }

    private Bitmap makeBubbleIcon(int size) {
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.BLACK);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(size * 2f / 24f);
        p.setStrokeCap(Paint.Cap.ROUND);
        p.setStrokeJoin(Paint.Join.ROUND);
        float s = size / 24f; // SVG viewBox is 24×24
        Path path = new Path();
        path.moveTo(12.5f * s, 21 * s);
        path.lineTo(5 * s, 21 * s);
        path.quadTo(3 * s, 21 * s, 3 * s, 19 * s);
        path.lineTo(3 * s, 5 * s);
        path.quadTo(3 * s, 3 * s, 5 * s, 3 * s);
        path.lineTo(19 * s, 3 * s);
        path.quadTo(21 * s, 3 * s, 21 * s, 5 * s);
        path.lineTo(21 * s, 12.5f * s);
        cv.drawPath(path, p);
        cv.drawLine(16 * s, 19 * s, 22 * s, 19 * s, p); // plus —
        cv.drawLine(19 * s, 16 * s, 19 * s, 22 * s, p); // plus |
        return bmp;
    }

    /**
     * Draw `text` in the font at `fontPath` and save it as a PNG, so the Manager
     * can show a real preview of a MyStyle/fonts face. React Native resolves
     * fontFamily against fonts bundled at build time only, so a font loaded from
     * a path can never be previewed as text — this is the way round it.
     */
    @ReactMethod
    public void renderFontSample(String fontPath, String text, int sizePx, String outPath, Promise promise) {
        new Thread(() -> renderFontSampleBlocking(fontPath, text, sizePx, outPath, promise)).start();
    }

    private void renderFontSampleBlocking(String fontPath, String text, int sizePx, String outPath, Promise promise) {
        Bitmap bmp = null;
        try {
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            p.setTypeface(fontFor(fontPath));
            p.setTextSize(sizePx);
            p.setColor(Color.BLACK);
            Paint.FontMetrics fm = p.getFontMetrics();
            int pad = Math.max(2, sizePx / 12);
            int w = (int) Math.ceil(p.measureText(text)) + pad * 2;
            int h = (int) Math.ceil(fm.bottom - fm.top) + pad * 2;
            if (w <= pad * 2 || h <= pad * 2) {
                promise.reject("FONT_SAMPLE", "font produced no metrics");
                return;
            }
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(bmp);
            cv.drawText(text, pad, pad - fm.top, p);
            File f = new File(outPath);
            File parent = f.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            try (java.io.FileOutputStream os = new java.io.FileOutputStream(f)) {
                bmp.compress(Bitmap.CompressFormat.PNG, 100, os);
            }
            WritableMap m = Arguments.createMap();
            m.putString("path", outPath);
            m.putInt("w", w);
            m.putInt("h", h);
            promise.resolve(m);
        } catch (Exception e) {
            promise.reject("FONT_SAMPLE", e.getMessage(), e);
        } finally {
            if (bmp != null) bmp.recycle(); // also on the failure path
        }
    }

    /** A rounded label chip matching the Manager's look (white fill, black outline). */
    private TextView makeMiniChip(Context ctx, String text) {
        TextView t = new TextView(ctx);
        t.setText(text);
        t.setTextColor(Color.BLACK);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.setPadding(dp(7), dp(1), dp(7), dp(1));
        t.setBackground(roundedBg(Color.WHITE, Color.BLACK, dp(999), dp(1)));
        return t;
    }

    /** Rebuild the header's label chips (display only). */
    private void fillLabels(Context ctx, LinearLayout box, List<String> labels) {
        box.removeAllViews();
        for (String l : labels) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = dp(4);
            box.addView(makeMiniChip(ctx, l), lp);
        }
        box.setVisibility(labels.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private GradientDrawable roundedBg(int fill, int stroke, int radius, int strokeW) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        g.setStroke(strokeW, stroke);
        return g;
    }

    private static final int TOOL_DP = 42;

    /** 🗑 first tap: ask (the bin inverted, a toast); second tap within 3 s: close and delete. */
    private void onDeleteTap(Card c) {
        if (!c.deleteArmed) {
            c.deleteArmed = true;
            c.deleteBtn.setOn(true);
            Toast.makeText(getReactApplicationContext(), "Tap the bin again to delete this sticky note",
                    Toast.LENGTH_SHORT).show();
            int gen = ++c.deleteGen;
            main.postDelayed(() -> { if (gen == c.deleteGen) disarmDelete(c); }, 3000);
            return;
        }
        disarmDelete(c);
        if (c == writingCard) finishWriting(c);
        exitEdit(c, false);
        removeCardInternal(c.id);
        logLine("[card] deleted from the card " + c.id);
        WritableMap m = Arguments.createMap();
        m.putString("id", c.id);
        emit("onCardDelete", m);
    }

    private void disarmDelete(Card c) {
        c.deleteGen++;
        c.deleteArmed = false;
        if (c.deleteBtn != null) c.deleteBtn.setOn(false);
    }

    private ToolIcon toolIcon(Context ctx, LinearLayout header, ToolIcon.Kind kind) {
        ToolIcon t = new ToolIcon(ctx, kind);
        header.addView(t, new LinearLayout.LayoutParams(dp(TOOL_DP), dp(TOOL_DP)));
        return t;
    }

    /** The header while writing: eraser · undo · ✓ · ✕; otherwise paste · ✎ · ✕ with the title. */
    private void applyTools(Card c) {
        boolean w = c == writingCard;
        c.eraserBtn.setVisibility(w ? View.VISIBLE : View.GONE);
        c.undoBtn.setVisibility(w ? View.VISIBLE : View.GONE);
        c.pasteBtn.setVisibility(w ? View.GONE : View.VISIBLE);
        c.titleView.setVisibility(w ? View.INVISIBLE : View.VISIBLE); // keeps its weight: tools stay right
        c.labelsBox.setVisibility(w ? View.GONE : View.VISIBLE);
        c.penBtn.setKind(w ? ToolIcon.Kind.DONE : ToolIcon.Kind.PEN);
        if (!w) { c.eraserBtn.setOn(false); c.undoBtn.setDim(true); }
    }

    private LinearLayout.LayoutParams wrapLP() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams matchWidthLP() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private int screenW() { return getReactApplicationContext().getResources().getDisplayMetrics().widthPixels; }
    private int screenH() { return getReactApplicationContext().getResources().getDisplayMetrics().heightPixels; }
    private int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }
    private int dp(int v) {
        float d = getReactApplicationContext().getResources().getDisplayMetrics().density;
        return (int) (v * d);
    }
}
