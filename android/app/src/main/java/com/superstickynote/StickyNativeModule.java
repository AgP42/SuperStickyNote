package com.superstickynote;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
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
    static final int MAX_CARDS = 8;
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

    private static final class Card {
        String id;
        View view;
        TextView iconView;
        TextView titleView;
        View dividerView;
        EditText body;
        View doneView;
        View closeView;
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

                TextView glyph = new TextView(ctx);
                glyph.setTag(BUBBLE_TAG);
                glyph.setText("✚");
                glyph.setTextColor(Color.BLACK);
                glyph.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
                glyph.setGravity(Gravity.CENTER);
                glyph.setPadding(dp(12), dp(8), dp(12), dp(8));
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
                    boolean collapsed = n.hasKey("collapsed") && n.getBoolean("collapsed");
                    int fontSp = n.hasKey("fontSize") && !n.isNull("fontSize")
                            ? n.getInt("fontSize") : DEFAULT_FONT_SP;
                    int x = n.hasKey("x") && !n.isNull("x") ? n.getInt("x") : -1;
                    int y = n.hasKey("y") && !n.isNull("y") ? n.getInt("y") : -1;
                    int w = n.hasKey("w") && !n.isNull("w") ? n.getInt("w") : -1;
                    int h = n.hasKey("h") && !n.isNull("h") ? n.getInt("h") : -1;
                    if (x < 0 || y < 0) {
                        x = dp(24) + (i % 4) * dp(30);
                        y = dp(90) + (i % 4) * dp(30);
                    }
                    Card existing = cards.get(id);
                    if (existing != null) {
                        updateCard(existing, icon, body, x, y, w, h, collapsed, fontSp);
                    } else {
                        addCard(ctx, id, icon, body, x, y, w, h, collapsed, fontSp);
                    }
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

    private void addCard(Context ctx, String id, String icon, String body,
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

        // Header: icon (→ manager) + title (first line) + ✓ done + ✕ close.
        LinearLayout header = new LinearLayout(ctx);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView iconV = new TextView(ctx);
        iconV.setText(icon);
        iconV.setTextColor(Color.BLACK);
        iconV.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        iconV.setPadding(dp(2), dp(2), dp(10), dp(2));
        header.addView(iconV, wrapLP());
        c.iconView = iconV;

        TextView titleV = new TextView(ctx);
        titleV.setText(firstLine(body));
        titleV.setTextColor(Color.BLACK);
        titleV.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp); // title scales with the size setting
        titleV.setTypeface(titleV.getTypeface(), android.graphics.Typeface.BOLD);
        titleV.setSingleLine(true);
        titleV.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleLP =
                new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        header.addView(titleV, titleLP);
        c.titleView = titleV;

        TextView doneV = new TextView(ctx);
        doneV.setText("✓");
        doneV.setTextColor(Color.BLACK);
        doneV.setTypeface(doneV.getTypeface(), android.graphics.Typeface.BOLD);
        doneV.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        doneV.setPadding(dp(8), dp(2), dp(8), dp(2));
        doneV.setVisibility(View.GONE);
        header.addView(doneV, wrapLP());
        c.doneView = doneV;

        TextView closeV = new TextView(ctx);
        closeV.setText("✕");
        closeV.setTextColor(Color.BLACK);
        closeV.setTypeface(closeV.getTypeface(), android.graphics.Typeface.BOLD);
        closeV.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        closeV.setPadding(dp(8), dp(2), dp(4), dp(2));
        header.addView(closeV, wrapLP());
        c.closeView = closeV;

        panel.addView(header, matchWidthLP());

        View div = new View(ctx);
        div.setBackgroundColor(Color.BLACK);
        LinearLayout.LayoutParams divLP =
                new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1));
        divLP.topMargin = dp(6); divLP.bottomMargin = dp(6);
        panel.addView(div, divLP);
        c.dividerView = div;

        EditText bodyV = new EditText(ctx);
        bodyV.setBackgroundColor(Color.TRANSPARENT);
        bodyV.setPadding(0, 0, 0, 0);
        bodyV.setTextColor(Color.BLACK);
        bodyV.setHintTextColor(Color.parseColor("#000000"));
        bodyV.setHint("Tap to write…");
        bodyV.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
        bodyV.setGravity(Gravity.TOP | Gravity.START);
        bodyV.setInputType(InputType.TYPE_CLASS_TEXT
                | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        bodyV.setSingleLine(false);
        bodyV.setMinLines(2);
        bodyV.setMaxLines(8);
        bodyV.setVerticalScrollBarEnabled(true);
        c.muteWatcher = true;
        bodyV.setText(body);
        c.muteWatcher = false;
        c.body = bodyV;

        bodyV.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int cnt) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int cnt) {}
            @Override public void afterTextChanged(Editable e) {
                c.titleView.setText(firstLine(e.toString()));
                // Stream to JS (JS debounces the disk write) so text is never lost —
                // a focusable overlay can't reliably detect blur, so we don't wait for it.
                if (c.muteWatcher) return;
                WritableMap m = Arguments.createMap();
                m.putString("id", c.id);
                m.putString("body", e.toString());
                emit("onCardEdited", m);
            }
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
        handle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        handle.setPadding(dp(10), dp(4), dp(2), dp(2));
        LinearLayout.LayoutParams handleLP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        handleLP.gravity = Gravity.END;
        panel.addView(handle, handleLP);
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
            if (ev.getAction() == MotionEvent.ACTION_OUTSIDE && c.editing) {
                exitEdit(c, true);
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
                    } else if (hitView(c.doneView, ev)) {
                        exitEdit(c, true);
                    } else if (hitView(c.closeView, ev)) {
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

    private void updateCard(Card c, String icon, String body, int x, int y, int w, int h,
                            boolean collapsed, int fontSp) {
        try {
            c.iconView.setText(icon);
            c.titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
            c.body.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSp);
            if (!c.editing && !c.body.getText().toString().equals(body)) {
                c.muteWatcher = true;
                c.body.setText(body);
                c.muteWatcher = false;
                c.titleView.setText(firstLine(body));
            }
            if (w > 0) c.params.width = w;
            if (h > 0) {
                c.fixedHeight = h;
                LinearLayout.LayoutParams blp = (LinearLayout.LayoutParams) c.body.getLayoutParams();
                if (blp.weight != 1f) { blp.height = 0; blp.weight = 1f; c.body.setLayoutParams(blp); }
            }
            if (c.collapsed != collapsed) { c.collapsed = collapsed; }
            applyCollapse(c); // also applies height (fixedHeight vs wrap)
            c.params.x = x; c.params.y = y;
            wm.updateViewLayout(c.view, c.params);
        } catch (Exception ignored) {}
    }

    private void setCollapsed(Card c, boolean collapsed) {
        c.collapsed = collapsed;
        applyCollapse(c);
    }

    private void applyCollapse(Card c) {
        int vis = c.collapsed ? View.GONE : View.VISIBLE;
        c.dividerView.setVisibility(vis);
        c.body.setVisibility(vis);
        c.resizeHandle.setVisibility(vis);
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
                    emit("onCardEdited", m);
                }
            }
        } catch (Exception ignored) {}
        c.clipBar.setVisibility(View.GONE);
    }

    // ---- Inline edit (focusable toggle → soft keyboard) -------------------

    private void enterEdit(Card c) {
        if (c.editing) return;
        if (editingId != null && !editingId.equals(c.id)) {
            Card prev = cards.get(editingId);
            if (prev != null) exitEdit(prev, true);
        }
        c.editing = true;
        editingId = c.id;
        try {
            c.params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
            c.params.flags |= WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
            wm.updateViewLayout(c.view, c.params);
        } catch (Exception ignored) {}
        c.doneView.setVisibility(View.VISIBLE);
        c.body.post(() -> {
            c.body.setFocusableInTouchMode(true);
            c.body.requestFocus();
            c.body.setSelection(c.body.getText().length());
            InputMethodManager imm = (InputMethodManager)
                    getReactApplicationContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(c.body, InputMethodManager.SHOW_FORCED);
        });
    }

    private void exitEdit(Card c, boolean emitText) {
        if (!c.editing) return;
        c.editing = false;
        if (c.id.equals(editingId)) editingId = null;
        try {
            InputMethodManager imm = (InputMethodManager)
                    getReactApplicationContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(c.body.getWindowToken(), 0);
        } catch (Exception ignored) {}
        c.body.clearFocus();
        c.doneView.setVisibility(View.GONE);
        try {
            c.params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
            c.params.flags &= ~WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
            wm.updateViewLayout(c.view, c.params);
        } catch (Exception ignored) {}
        if (emitText) {
            WritableMap m = Arguments.createMap();
            m.putString("id", c.id);
            m.putString("body", c.body.getText().toString());
            emit("onCardEdited", m);
        }
    }

    private void removeCardInternal(String id) {
        Card c = cards.remove(id);
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

    private static String firstLine(String body) {
        if (body == null) return "Untitled";
        for (String line : body.split("\n")) {
            String t = line.trim();
            if (!t.isEmpty()) return t;
        }
        return "Untitled";
    }

    // ---- Ghost cleanup ----------------------------------------------------

    @ReactMethod
    @SuppressWarnings("unchecked")
    public void clearAll(Promise promise) {
        main.post(() -> {
            int removed = 0;
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
            bubbleView = null; bubbleParams = null;
            cards.clear();
            editingId = null;
            if (promise != null) promise.resolve(removed);
        });
    }

    // ---- Files / PluginJanitor -------------------------------------------

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

    private GradientDrawable roundedBg(int fill, int stroke, int radius, int strokeW) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(radius);
        g.setStroke(strokeW, stroke);
        return g;
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
