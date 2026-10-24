package com.superstickynote;

import android.os.IBinder;
import android.os.Parcel;

/**
 * Supernote's firmware pen ink: the pen daemon behind the hidden
 * `service_myservice` binder. Claiming it does two things at once for a card
 * that is being written on: the note stops recording the pen (so nothing lands
 * on the page under the card), and the firmware paints the stroke live, at the
 * latency of the note itself.
 *
 * The binder contract (service name, interface token, transaction codes,
 * parcel layout, sentinel rects) is ported from FirmwareInk.kt in sn-canvas,
 * https://github.com/j-raghavan/sn-canvas — MIT License,
 * Copyright (c) 2026 JRaghavan.
 *
 * Device-tested on the Manta (Chauvet 3.29): a claim from the pluginhost
 * overlay holds while the card's window has focus, and the firmware hands the
 * pen back to whichever window takes focus next, so the card claims again on
 * every focus gain. Nothing here ever throws.
 */
final class FirmwareInk {
    interface Log { void line(String s); }

    private static final String[] SERVICE_NAMES = {"service_myservice", "service.myservice"};
    private static final String IFACE_TOKEN = "android.demo.IMyService";
    private static final String APP_NAME = "SuperStickyNote";
    private static final int TX_WRITE_APP_INFO = 0;
    private static final int TX_DISABLE_AREA = 1;
    private static final int TX_PEN = 2;
    private static final int TX_DRAW_BUFFER = 6;
    private static final int CLEAR_ALL = 255;
    // One sentinel rect [0, 0, edge, edge, 0]: ink on everywhere.
    private static final int WRITABLE_ON_EDGE = 18888;
    // The firmware's needle, black: what the card writes with.
    private static final int[] CARD_PEN = {10, 1000, 0};

    private final Log log;
    private IBinder binder;
    private boolean claimed;
    /** The note's own pen (firmware codes), set back on release; null = unknown. */
    private int[] notePen;

    FirmwareInk(Log log) { this.log = log; }

    /** Whether this device has the firmware ink service at all. */
    boolean available() { return binder() != null; }

    boolean isClaimed() { return claimed; }

    /** Take the pen for the card, ink on everywhere. Safe to repeat. */
    boolean claim() {
        if (binder() == null) return false;
        send(TX_WRITE_APP_INFO, p -> { p.writeInt(0); p.writeInt(0); });
        send(TX_DISABLE_AREA, p -> p.writeInt(0));
        send(TX_PEN, p -> { p.writeInt(CARD_PEN[0]); p.writeInt(CARD_PEN[1]); p.writeInt(CARD_PEN[2]); });
        send(TX_DISABLE_AREA, p -> {
            p.writeInt(1);
            for (int v : new int[]{0, 0, WRITABLE_ON_EDGE, WRITABLE_ON_EDGE, 0}) p.writeInt(v);
        });
        claimed = true;
        return true;
    }

    /** Wipe the firmware's live ink (our own rendering then shows the strokes). */
    void clearInk() {
        if (!claimed) return;
        send(TX_DRAW_BUFFER, p -> { p.writeInt(CLEAR_ALL); p.writeInt(0); });
    }

    /**
     * Give the pen back to the note, writing again with its own pen. The note
     * only re-sends its pen when a tool is tapped, so a pen left as ours would
     * keep writing with the card's needle.
     */
    void release() {
        if (!claimed) return;
        clearInk();
        if (notePen != null) {
            final int[] pen = notePen;
            send(TX_PEN, p -> { p.writeInt(pen[0]); p.writeInt(pen[1]); p.writeInt(pen[2]); });
        }
        send(TX_DISABLE_AREA, p -> {
            p.writeInt(1);
            for (int v : new int[]{0, 0, WRITABLE_ON_EDGE, WRITABLE_ON_EDGE, 0}) p.writeInt(v);
        });
        claimed = false;
        log.line("[ink] pen released to the note (pen " + (notePen == null ? "unknown" : notePen[0] + "/" + notePen[1]) + ")");
    }

    /** The note's pen as getPenInfo reports it (SDK codes), mapped like sn-canvas's FirmwarePen.ofNotePen. */
    void setNotePen(int type, int width, int color) {
        int nib;
        switch (type) {
            case 1: case 16: nib = 16; break;   // pressure pen → ink
            case 10: nib = 10; break;           // fineliner → needle
            case 11: nib = 11; break;           // marker
            case 14: case 15: nib = 15; break;  // calligraphy (the device reports 15)
            default: notePen = null; return;
        }
        int col;
        switch (color) {
            case 0x9D: case -101: col = -101; break;
            case 0xC9: case -102: col = -102; break;
            case 0xFE: col = 254; break;
            default: col = 0;
        }
        notePen = new int[]{nib, width > 0 ? width : 1000, col};
    }

    private IBinder binder() {
        if (binder != null && binder.isBinderAlive()) return binder;
        binder = null;
        try {
            java.lang.reflect.Method get = Class.forName("android.os.ServiceManager")
                    .getMethod("getService", String.class);
            for (String n : SERVICE_NAMES) {
                Object b = get.invoke(null, n);
                if (b instanceof IBinder) { binder = (IBinder) b; break; }
            }
        } catch (Throwable e) {
            log.line("[ink] firmware ink service unavailable: " + e);
        }
        return binder;
    }

    private interface Writer { void write(Parcel p); }

    private void send(int code, Writer w) {
        IBinder b = binder();
        if (b == null) return;
        Parcel data = Parcel.obtain();
        Parcel reply = Parcel.obtain();
        try {
            data.writeInterfaceToken(IFACE_TOKEN);
            data.writeString(APP_NAME);
            w.write(data);
            b.transact(code, data, reply, 0);
        } catch (Throwable e) {
            log.line("[ink] firmware tx " + code + " failed: " + e);
        } finally {
            data.recycle();
            reply.recycle();
        }
    }
}
