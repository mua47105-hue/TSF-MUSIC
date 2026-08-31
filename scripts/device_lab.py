#!/usr/bin/env python3
"""TSF Music device lab (v3.2) — Playwright walkthrough on Expo web with
react-native-web, emulating real hardware viewports (no browser chrome).

Devices (v3.4.2, five viewports): Pixel 7 (412x915 @2.625), iPhone 13
(390x844 @3), portrait tablet (600x960), LANDSCAPE tablet (960x600) and
a desktop-style window (1280x800) — the last two exist because v3.4.2
removes the orientation lock (the tablet letterbox root fix), so the UI
must provably hold in wide/landscape windows, not just portrait ones.

The critical v3.2 regression test lives here: complete onboarding →
RELOAD → assert onboarding never reappears and Home greets by name
(the user-reported re-ask bug).
"""
import json
import os
import sys
import time

from playwright.sync_api import sync_playwright, expect

URL = os.environ.get("TSF_URL", "http://localhost:8123")
SHOT_DIR = os.environ.get("TSF_SHOTS", "/home/z/my-project/screenshots")
DEVICES = [
    ("pixel7", {"viewport": {"width": 412, "height": 915}, "device_scale_factor": 2.625, "is_mobile": True, "has_touch": True, "user_agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"}),
    ("iphone13", {"viewport": {"width": 390, "height": 844}, "device_scale_factor": 3, "is_mobile": True, "has_touch": True, "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"}),
    # v3.4.1 W2/W3: the tablet viewport from the user's field report
    # (600x960 screenshot, 16:10) — the layout must fill ANY window with
    # the tab bar pinned to the bottom of that window.
    ("tablet", {"viewport": {"width": 600, "height": 960}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True, "user_agent": "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}),
    # v3.4.2 R5: orientation is no longer locked, so the layout must
    # survive LANDSCAPE tablet windows (the OS will hand us these
    # whenever the user rotates — and Samsung DeX / desktop windows are
    # landscape by default).
    ("tablet-landscape", {"viewport": {"width": 960, "height": 600}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True, "user_agent": "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}),
    # v3.4.2 R5: a wide desktop-style window (Samsung desktop windowing /
    # DeX defaults). Not mobile-emulated: desktop windows are mouse-first.
    ("desktop-window", {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 1, "is_mobile": False, "has_touch": True, "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}),
]

results = []
console_errors = []


def log(device, step, ok, note=""):
    results.append({"device": device, "step": step, "ok": bool(ok), "note": note})
    print(f"[{'OK ' if ok else 'FAIL'}] {device:9s} {step} {note}")


def shot(page, device, name):
    path = os.path.join(SHOT_DIR, device, f"{name}.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    page.wait_for_timeout(450)
    page.screenshot(path=path, full_page=False)
    return path


# RN-web ScrollViews do not respond to mouse.wheel in headless Chromium
# (proven by scripts/probe_scroll.py: scrollTop stays 0). Direct scrollTop
# assignment + a scroll event makes react-native-web fire onScroll /
# onEndReached, which is what the feed triggers listen to.
# NOTE: tab screens stay mounted and stacked (the home feed's ScrollView
# can be taller than the search list while INACTIVE underneath it), and a
# bounding-rect visibility check can't tell them apart. Instead: take the
# topmost element at the viewport CENTER (document.elementFromPoint) and
# walk up to ITS scrollable ancestor — exactly the scroller a user's
# wheel/finger would move.
SCROLL_JS = """(dy) => {
    const cx = innerWidth / 2, cy = innerHeight / 2;
    let el = document.elementFromPoint(cx, cy);
    while (el && el !== document.body && el !== document.documentElement) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
            && el.scrollHeight > el.clientHeight + 10) {
            el.scrollTop = Math.min(el.scrollTop + dy, el.scrollHeight);
            el.dispatchEvent(new Event('scroll'));
            return true;
        }
        el = el.parentElement;
    }
    return false;
}"""

SCROLL_TOP_JS = """() => {
    [...document.querySelectorAll('div')].forEach(d => {
        const s = getComputedStyle(d);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollTop > 0) {
            d.scrollTop = 0;
            d.dispatchEvent(new Event('scroll'));
        }
    });
    window.scrollTo(0, 0);
}"""

def scroll(page, dy, times=1):
    for _ in range(times):
        page.evaluate(SCROLL_JS, dy)
        page.wait_for_timeout(260)


def tab(page, name):
    """Robust bottom-tab click: testID first, then role/text fallback."""
    sel = f'[data-testid="tab-{name}"]'
    if page.locator(sel).count() > 0:
        page.click(sel)
        return
    # react-native-web tab bar: match by accessible label text
    label = "Your Library" if name == "library" else name.capitalize()
    page.get_by_text(label, exact=True).last.click()


def run_device(pw, name, cfg):
    browser = pw.chromium.launch(args=["--force-device-scale-factor=1"])
    ctx = browser.new_context(**cfg)
    page = ctx.new_page()
    page.on("console", lambda m: console_errors.append(f"{name}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(f"{name}: pageerror {e}"))

    try:
        # 01 — fresh install: What's new dialog
        page.goto(URL, wait_until="domcontentloaded", timeout=120000)
        page.wait_for_selector('[data-testid="whatsnew-continue"]', timeout=90000)
        shot(page, name, "01-whatsnew")
        page.click('[data-testid="whatsnew-continue"]')
        log(name, "whatsnew-dismiss", True)

        # 02 — onboarding step 1: name
        page.wait_for_selector('[data-testid="onb-name-input"]', timeout=60000)
        shot(page, name, "02-onb-name")
        page.fill('[data-testid="onb-name-input"]', "Rahul")
        page.click('[data-testid="onb-continue"]')

        # 03 — onboarding step 2: REAL artist photos
        page.wait_for_selector('[data-testid="onb-artist"]', timeout=60000)
        page.wait_for_timeout(1800)  # let photos paint
        artists = page.locator('[data-testid="onb-artist"]')
        count = artists.count()
        shot(page, name, "03-onb-artists")
        log(name, "onb-artists-pool", count >= 15, f"{count} tiles")

        # pick 3 artists spread across the grid
        for i in (0, 4, 8):
            artists.nth(i).click()
            page.wait_for_timeout(220)
        shot(page, name, "03b-onb-picked")
        log(name, "onb-pick-artists", True, "3 picked")

        # 03c — More tile expands the pool
        before = artists.count()
        page.locator('[data-testid="onb-more"]').scroll_into_view_if_needed()
        page.click('[data-testid="onb-more"]')
        page.wait_for_timeout(1200)
        after = artists.count()
        shot(page, name, "03c-onb-more")
        log(name, "onb-more-expands", after > before, f"{before} -> {after}")

        # 03d — artist search returns photo tiles
        page.fill('[data-testid="onb-search"]', "arijit")
        page.press('[data-testid="onb-search"]', "Enter")
        page.wait_for_timeout(1500)
        hits = page.locator('[data-testid="onb-artist"]').count()
        shot(page, name, "03d-onb-search")
        log(name, "onb-search", hits >= 1, f"{hits} hits")
        page.fill('[data-testid="onb-search"]', "")
        page.wait_for_timeout(400)

        page.click('[data-testid="onb-continue"]')

        # 04 — onboarding step 3: genres
        page.wait_for_selector('[data-testid="onb-genre"]', timeout=30000)
        shot(page, name, "04-onb-genres")
        page.locator('[data-testid="onb-genre"]').nth(0).click()
        page.locator('[data-testid="onb-genre"]').nth(2).click()
        page.wait_for_timeout(250)
        shot(page, name, "04b-onb-genres-picked")
        page.click('[data-testid="onb-continue"]')
        page.wait_for_timeout(1200)
        log(name, "onb-finish", True)

        # 05 — ★ PERSISTENCE REGRESSION: reload must NOT re-ask
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(6000)
        reask = page.locator('[data-testid="onb-name-input"]').count()
        log(name, "PERSISTENCE-no-reask", reask == 0, f"onb visible={reask}")
        # greeting appears when the mixes shelf builds (seed-driven) — wait for it
        greeting = 0
        for _ in range(10):
            greeting = page.get_by_text("Made for Rahul", exact=False).count()
            if greeting >= 1:
                break
            page.wait_for_timeout(1500)
        shot(page, name, "05-after-reload")
        log(name, "PERSISTENCE-greeting", greeting >= 1, f"'Made for Rahul' x{greeting}")

        # 06 — home loaded + deep scroll proof
        page.wait_for_timeout(2500)
        shot(page, name, "06-home")
        scroll(page, 1400, 2)
        shot(page, name, "07-home-scrolled1")
        scroll(page, 1600, 2)
        shot(page, name, "08-home-scrolled2")
        scroll(page, 1800, 3)
        page.wait_for_timeout(1200)
        shot(page, name, "09-home-scrolled3")
        artists_rail = page.locator('[data-testid="home-artist"]').count()
        log(name, "home-artist-rail", artists_rail >= 6, f"{artists_rail} artist cards")
        shelves = page.get_by_text("New releases", exact=False).count() + page.get_by_text("Featured playlists", exact=False).count()
        log(name, "home-deep-shelves", shelves >= 1, f"editorial shelves x{shelves}")
        # back to top
        page.evaluate(SCROLL_TOP_JS)
        page.wait_for_timeout(600)

        # ── v3.4.1 W3 / v3.4.2 R5: TAB BAR PINS TO THE WINDOW BOTTOM ──
        # The field bug: bar rendered mid-screen with a void below (OS
        # letterbox, root-caused in v3.4.2 to the portrait orientation
        # lock). In-app, the flex chain must fill the viewport: the
        # tab bar's bottom edge sits within 70px of the viewport bottom
        # — in EVERY window shape now, including landscape/desktop.
        try:
            bar_bb = page.locator("text=Your Library").last.bounding_box()
            vh = page.viewport_size["height"]
            bar_bottom_dist = (vh - (bar_bb["y"] + bar_bb["height"])) if bar_bb else 9999
            log(name, "v341-tabbar-at-window-bottom", bar_bottom_dist < 70, f"bottom gap {bar_bottom_dist:.0f}px of {vh}px viewport")
        except Exception as e:
            log(name, "v341-tabbar-at-window-bottom", False, str(e)[:120])
        shot(page, name, "06b-tabbar-position")

        # v3.4.2 R5: wide windows must not produce horizontal overflow
        # (content wider than the window = broken adaptive layout).
        try:
            overflow_x = page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            log(name, "v342-no-horizontal-overflow", overflow_x <= 1, f"overflowX {overflow_x}px")
        except Exception as e:
            log(name, "v342-no-horizontal-overflow", False, str(e)[:120])

        # ── v3.4.1 F2: ENDLESS HOME FEED — scroll forever ─────────────
        # Deep scroll: the endless feed must materialize song batches
        # (endless-feed-songs sections) as the user approaches the bottom.
        feed_sections = 0
        for burst in range(6):
            scroll(page, 2200, 3)
            page.wait_for_timeout(1400)
            feed_sections = page.locator('[data-testid="endless-feed-songs"]').count()
            if feed_sections >= 2:
                break
        shot(page, name, "09b-endless-feed")
        log(name, "v341-endless-feed-batches", feed_sections >= 1, f"{feed_sections} song sections loaded")
        feed_rows = page.locator('[data-testid="endless-feed-song"]').count()
        log(name, "v341-endless-feed-rows", feed_rows >= 6, f"{feed_rows} playable rows")

        # ── v3.4.1 F3: a feed row PLAYS with the full loaded queue ────
        if feed_rows > 0:
            page.locator('[data-testid="endless-feed-song"]').first.click()
            page.wait_for_timeout(1800)
            mini = page.locator('[data-testid="mini-player"]').count()
            log(name, "v341-endless-feed-plays", mini >= 1, f"mini-player visible={mini}")
            try:
                page.locator('[data-testid="player-dismiss"]').first.click(timeout=8000)
                page.wait_for_timeout(800)
            except Exception:
                page.keyboard.press("Escape")
                page.wait_for_timeout(800)
        else:
            log(name, "v341-endless-feed-plays", False, "no feed rows to tap")

        # back to top for the search phase
        page.evaluate(SCROLL_TOP_JS)
        page.wait_for_timeout(600)

        # 07 — search: browse grid + top result
        tab(page, "search")
        page.wait_for_timeout(900)
        shot(page, name, "10-search-browse")

        # 07b — SEARCH V2: typeahead rail (recents+suggestions+topquery)
        field = page.get_by_placeholder("What do you want to listen to?")
        field.fill("tum")
        # count INSIDE the rail's visibility window (suggestions ~240ms,
        # search replaces them at ~850ms) — before the shot's own settle
        page.wait_for_timeout(420)
        rail_rows = page.locator('[data-testid="search-suggest-row"]').count()
        topq = page.locator('[data-testid="search-suggest-topquery"]').count()
        log(name, "search-typeahead-rail", rail_rows >= 1, f"{rail_rows} suggest rows")
        log(name, "search-typeahead-topquery", topq >= 1, f"best-guess rows: {topq}")
        shot(page, name, "10b-search-typeahead")

        # 07c — SEARCH V2: honest zero state (no unrelated rows)
        field.fill("zzqqxx")
        page.wait_for_timeout(2600)
        shot(page, name, "10c-search-zero")
        zero_text = page.get_by_text("No results", exact=False).count()
        junk_rows = page.locator('[data-testid="search-top-result"]').count()
        log(name, "search-honest-zero", zero_text >= 1 and junk_rows == 0, f"zero-state={zero_text} junk-top={junk_rows}")

        # 07d — SEARCH V2: lyric fragment search (S1 flow, webmock lrclib)
        field.fill("hum tere bin ab reh nahi sakte")
        page.wait_for_timeout(3000)
        shot(page, name, "10d-search-lyric")
        lyric_rows = page.locator('[data-testid="track-row"]').count()
        top_after = page.locator('[data-testid="search-top-result"]').count()
        chip = page.locator('[data-testid="top-lyric-chip"]').count()
        log(name, "search-lyric-flow", lyric_rows >= 1 or top_after >= 1, f"rows={lyric_rows} chip={chip}")

        # 07 — classic: top result via the seeded fixture query
        field.fill("mashooqa")
        page.wait_for_timeout(2200)
        shot(page, name, "11-search-results")
        top = page.locator('[data-testid="search-top-result"]').count()
        log(name, "search-top-result", top >= 1)

        # ── v3.4.1 F1: INFINITE SEARCH RESULTS — page 2+ appends ─────
        # Scroll the results list to the bottom: pagination must append
        # page-2 rows (webmock serves synthetic pages 2-3, then an empty
        # page 4 → the honest end marker).
        rows_before = page.locator('[data-testid="track-row"]').count()
        for burst in range(8):
            scroll(page, 1800, 3)
            page.wait_for_timeout(900)
            end_note = page.locator('[data-testid="search-end-note"]').count()
            if end_note >= 1:
                break
        rows_after = page.locator('[data-testid="track-row"]').count()
        end_note = page.locator('[data-testid="search-end-note"]').count()
        shot(page, name, "11a-search-paginated")
        log(name, "v341-search-pagination-appends", rows_after > rows_before, f"{rows_before} -> {rows_after} rows")
        log(name, "v341-search-pagination-honest-end", end_note >= 1, f"end-note={end_note}")
        # fresh search resets pagination (no stale end-note on a new query).
        # NOTE: re-filling the SAME string is a React no-op (state dedupe) —
        # clear first, then retype, to model a genuine new search.
        field.fill("")
        page.wait_for_timeout(1200)
        field.fill("mashooqa")
        page.wait_for_timeout(2600)
        stale_note = page.locator('[data-testid="search-end-note"]').count()
        log(name, "v341-search-pagination-resets", stale_note == 0, f"stale end-note={stale_note}")

        # ── v3.4.0 — SIG RESCUE (title-authority gap): "tu chaiye" has only
        # a sub-floor same-name cover in the catalog; the canonical recording
        # lives on YouTube → rescue ladder → rank 1 + honest label
        field.fill("tu chaiye")
        page.wait_for_timeout(3200)
        shot(page, name, "11b-search-rescued")
        rescued_label = page.get_by_text("Found on YouTube · full song, ad-free", exact=False).count()
        top_is_yt = page.locator('[data-testid="search-top-result"]').count() > 0 and (
            page.get_by_text("Tu Chahiye", exact=True).count() >= 1
        )
        log(name, "v34-sig-rescued-label", rescued_label >= 1, f"label x{rescued_label}")
        log(name, "v34-sig-rescued-top", top_is_yt, "canonical row present")

        # ── v3.4.0 — SOURCE TOGGLE: Catalog | YouTube chips exist and switch
        cat_chip = page.locator('[data-testid="source-toggle-catalog"]').count()
        yt_chip = page.locator('[data-testid="source-toggle-youtube"]').count()
        log(name, "v34-source-toggle-chips", cat_chip == 1 and yt_chip == 1, f"catalog={cat_chip} youtube={yt_chip}")

        # ── v3.4.0 — YOUTUBE MODE: the YT catalog answers directly
        page.locator('[data-testid="source-toggle-youtube"]').click()
        page.wait_for_timeout(2600)
        shot(page, name, "11c-search-youtube-mode")
        yt_rows = page.locator('[data-testid="track-row"]').count()
        yt_song_badge = page.get_by_text("YT Song", exact=True).count()
        log(name, "v34-youtube-mode-rows", yt_rows >= 2, f"{yt_rows} rows")
        log(name, "v34-youtube-mode-badge", yt_song_badge >= 1, f"YT Song badges x{yt_song_badge}")
        page.locator('[data-testid="source-toggle-catalog"]').click()
        page.wait_for_timeout(900)

        # ── v3.4.0 — play the RESCUED youtube row end-to-end (never-blank path).
        # play(0) navigates to the full Player screen (pre-existing top-card
        # behavior) — verify it rendered, then dismiss back to search.
        page.locator('[data-testid="search-top-result"]').first.click()
        page.wait_for_timeout(1800)
        shot(page, name, "11d-rescued-playing")
        mini = page.locator('[data-testid="mini-player"]').count()
        log(name, "v34-rescued-plays", mini >= 1, f"mini-player visible={mini}")
        try:
            page.locator('[data-testid="player-dismiss"]').first.click(timeout=8000)
            page.wait_for_timeout(900)
        except Exception:
            page.keyboard.press("Escape")
            page.wait_for_timeout(900)

        # 08 — play from the Top result card → mini player → full player
        field.fill("mashooqa")
        page.wait_for_timeout(2200)
        if page.locator('[data-testid="search-top-result"]').count() > 0:
            page.locator('[data-testid="search-top-result"]').first.click()
            page.wait_for_timeout(1500)
            shot(page, name, "12-miniplayer")
            try:
                page.locator('[data-testid="mini-player"]').click(force=True, timeout=8000)
            except Exception:
                page.locator('[data-testid="mini-player"]').focus()
                page.keyboard.press("Enter")
            page.wait_for_selector('[data-testid="player-queue-btn"]', timeout=20000)
            page.evaluate("window.__TsfMock && window.__TsfMock.seek(95)")
            page.evaluate("window.__TsfMock && window.__TsfMock.force('playing')")
            page.wait_for_timeout(900)
            shot(page, name, "13-player-playing")
            log(name, "player-open", True)
            page.click('[data-testid="player-dismiss"]')
            page.wait_for_timeout(700)
        else:
            log(name, "player-open", False, "no top-result card")

        # 09 — library + premium tabs render
        tab(page, "library")
        page.wait_for_timeout(900)
        shot(page, name, "14-library")
        log(name, "library", True)
        tab(page, "premium")
        page.wait_for_timeout(900)
        shot(page, name, "15-premium")
        log(name, "premium", True)

    except Exception as e:
        try:
            shot(page, name, "99-failure")
        except Exception:
            pass
        log(name, "EXCEPTION", False, str(e)[:300])
    finally:
        ctx.close()
        browser.close()


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    # TSF_DEVICES: comma-separated device names (default: all) — lets a
    # sandbox run one device per invocation when background processes
    # can't outlive a single session.
    wanted = os.environ.get("TSF_DEVICES")
    selected = DEVICES if not wanted else [d for d in DEVICES if d[0] in wanted.split(",")]
    with sync_playwright() as pw:
        for name, cfg in selected:
            run_device(pw, name, cfg)
    report = {
        "total": len(results),
        "passed": sum(1 for r in results if r["ok"]),
        "console_errors": console_errors,
        "steps": results,
    }
    with open(os.path.join(SHOT_DIR, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ("total", "passed", "console_errors")}, indent=2))
    sys.exit(0 if report["passed"] == report["total"] and not console_errors else 1)


if __name__ == "__main__":
    main()
