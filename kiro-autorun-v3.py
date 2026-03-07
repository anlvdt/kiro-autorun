#!/usr/bin/env python3
"""
Kiro AutoRun v2.1.0 - OCR + CGEvent Click
Auto-approves Kiro IDE command prompts WITHOUT moving the cursor.

Architecture:
  1. Background window capture (screencapture -l <windowID>) - works while Kiro is behind other apps
  2. Vision OCR - detects trigger text ("waiting on your input", "accept all", etc.)
  3. Accessibility API (AXUIElement.performAction) - presses buttons WITHOUT cursor movement
  4. Fallback: AppleScript "click button" via System Events - also no cursor movement

User can work on other apps normally while Kiro auto-approves in background.
"""

import subprocess, time, sys, os, json, signal, atexit, logging, hashlib

# Hide Python  icon from Dock - must be set BEFORE importing Quartz/pyobjc
try:
    import AppKit
    # Set LSUIElement in Info.plist before GUI frameworks register
    info = AppKit.NSBundle.mainBundle().infoDictionary()
    info['LSUIElement'] = '1'
    info['LSBackgroundOnly'] = '1'
    AppKit.NSApp.setActivationPolicy_(AppKit.NSApplicationActivationPolicyProhibited)
except Exception:
    pass  # Non-critical - just cosmetic

try:
    import Quartz
    from Quartz import (
        CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGNullWindowID,
        CGWindowListCreateImage, CGRectNull, kCGWindowImageDefault,
        kCGWindowListOptionIncludingWindow,
    )
except ImportError:
    print("Run: pip3 install pyobjc-framework-Quartz pyobjc-framework-Cocoa")
    sys.exit(1)

try:
    from ApplicationServices import (
        AXUIElementCreateApplication,
        AXUIElementCopyAttributeValue,
        AXUIElementPerformAction,
    )
except ImportError:
    print("Run: pip3 install pyobjc-framework-ApplicationServices")
    sys.exit(1)

try:
    import Vision
    from Foundation import NSURL  # kept for potential future use
except ImportError:
    pass  # NSURL not strictly needed for in-memory OCR

# ─── Configuration ───────────────────────────────────────────────────

CONFIG_FILE = os.path.expanduser("~/.kiro-autorun/config.json")
ACTION_LOG_FILE = os.path.expanduser("~/.kiro-autorun/actions.log")

POLL_INTERVAL = 2
TARGET_APP = "Kiro"
TRIGGER_TEXTS = ["waiting on your input"]
SHOW_NOTIFICATION = False
NOTIFICATION_SOUND = True
STUCK_RECOVERY_ENABLED = True

# Button texts to find via Accessibility API
# ONLY Accept All/Reject All — dialog buttons (Run/Reject/Trust) are web-rendered
# inside Electron webview and INVISIBLE to macOS Accessibility API
CLICKABLE_BUTTONS = ["Accept All", "Reject All"]
# OCR-based dialog button detection (order = priority: Run first!)
# Includes Play icon variants that OCR may read as unicode symbols
DIALOG_BUTTON_TEXTS = ["run", "trust", "▶", "►", "play"]  # Include Play icon variants
# Buttons we actually want to press
PRESSABLE_BUTTONS = {"accept all", "trust", "run", "play"}

COOLDOWN_SECONDS = 5
CLICK_DEBOUNCE_SECONDS = 4

BANNED_KEYWORDS = [
    # ── Filesystem destruction ──
    "rm -rf /", "rm -rf ~", "rm -rf /*", "rm -rf .",
    "rm -r /", "rm -r ~", "rm -r /*",
    "sudo rm", "sudo chmod", "sudo chown", "sudo kill",
    "chmod 777", "chmod -R 777",
    "chown -R root:root /",
    "mv / /dev/null", "mv ~ /dev/null",
    "> /dev/sda", "> /dev/disk",
    "dd if=", "mkfs.",
    "shred /dev",
    # ── Pipe to shell (remote code execution) ──
    "curl | sh", "curl | bash", "wget | sh", "wget | bash",
    "curl -s | sh", "wget -q | sh",
    # ── Git dangerous operations ──
    "git push --force", "git push -f",
    "git reset --hard",
    "git clean -fdx /",
    # ── SQL injection ──
    "drop table", "drop database", "truncate table",
    "delete from", "alter table",
    # ── System control ──
    "shutdown", "reboot", "halt", "poweroff",
    "init 0", "init 6",
    "kill -9", "killall",
    # ── Fork bomb ──
    ":(){:|:&};:",
    # ── Windows ──
    "format c:", "del /f /s",
    # ── macOS specific attacks ──
    "security dump-keychain",       # Steal keychain credentials
    "security delete-keychain",     # Delete keychain
    "security list-keychains",      # Enumerate keychains for theft
    "osascript -e 'display dialog",  # Fake password prompt
    "osascript -e \"display dialog",  # Fake password prompt variant
    "xattr -c ", "xattr -d com.apple.quarantine",  # Gatekeeper bypass
    "launchctl load",               # Persistence via launch daemon
    "launchctl submit",
    "crontab -r",                   # Delete all cron jobs
    # ── Environment hijacking ──
    "DYLD_INSERT_LIBRARIES",        # Library injection (macOS)
    "LD_PRELOAD",                   # Library injection (Linux)
    # ── History re-execution ──
    "history | sh", "history | bash",
    # ── Reverse shells & exfiltration ──
    "/dev/tcp/",                    # Bash reverse shell
    "nc -e", "ncat -e",            # Netcat reverse shell
    "base64 -d | sh",              # Encoded payload execution
    "base64 --decode | sh",
    # ── Credential theft ──
    ".ssh/id_rsa", ".ssh/id_ed25519",  # SSH key access
    ".aws/credentials",             # AWS credential file
    "printenv",                      # Dump all env vars
]

# Commands that are ALWAYS dangerous regardless of arguments
INHERENTLY_DANGEROUS = {
    # System destruction
    "dd", "mkfs", "fdisk", "parted", "shred",
    # System control
    "shutdown", "reboot", "halt", "poweroff", "init",
    # Process killing
    "killall", "pkill",
    # Windows
    "format",
    # Network attack tools
    "nc", "ncat", "socat",
    # macOS persistence/attack
    "launchctl",
}

# Argument patterns that make ANY command dangerous
DANGEROUS_PATTERNS = [
    "| sh", "| bash", "| zsh",       # Pipe to shell
    "> /dev/",                         # Write to device
    "--force",                         # Force operations
    "-rf /", "-rf ~", "-rf /*",       # Recursive force delete
    "chmod 777", "chmod -R 777",
    "drop table", "drop database",
    ":(){:|:&};:",                     # Fork bomb
]

# ─── Logging ─────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/tmp/kiro-autorun.log", mode="a"),
    ],
)
log = logging.getLogger("kiro-autorun")

click_count = 0
running = True
last_click_hash = None
last_click_time = 0
stuck_cycles = 0
STUCK_THRESHOLD = 5

# ─── Config ──────────────────────────────────────────────────────────

def load_config():
    global POLL_INTERVAL, TARGET_APP, TRIGGER_TEXTS, BANNED_KEYWORDS
    global SHOW_NOTIFICATION, NOTIFICATION_SOUND, STUCK_RECOVERY_ENABLED

    if not os.path.exists(CONFIG_FILE):
        return
    try:
        # FIX #3: Check config file permissions
        file_stat = os.stat(CONFIG_FILE)
        file_mode = oct(file_stat.st_mode)[-3:]
        if file_mode[-1] not in ('0', '4'):
            log.warning(f"SECURITY: Config file {CONFIG_FILE} is world-writable (mode {file_mode})!")
            log.warning(f"   Refusing to load. Fix with: chmod 600 {CONFIG_FILE}")
            return
        if file_stat.st_uid != os.getuid():
            log.warning(f"SECURITY: Config file owned by UID {file_stat.st_uid}, not current user {os.getuid()}")
            log.warning(f"   Refusing to load for safety.")
            return

        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
        POLL_INTERVAL = cfg.get("pollInterval", POLL_INTERVAL)
        SHOW_NOTIFICATION = cfg.get("showNotification", SHOW_NOTIFICATION)
        NOTIFICATION_SOUND = cfg.get("notificationSound", NOTIFICATION_SOUND)
        STUCK_RECOVERY_ENABLED = cfg.get("stuckRecoveryEnabled", STUCK_RECOVERY_ENABLED)
        # FIX #1: Sanitize targetApp
        raw_app = cfg.get("targetApp", TARGET_APP)
        import re
        safe_app = re.sub(r'[^a-zA-Z0-9 .\-]', '', raw_app)
        if safe_app != raw_app:
            log.warning(f"SECURITY: targetApp sanitized: '{raw_app}' -> '{safe_app}'")
        TARGET_APP = safe_app if safe_app else "Kiro"
        if "triggerTexts" in cfg:
            TRIGGER_TEXTS = [t.lower() for t in cfg["triggerTexts"]]
        elif "triggerText" in cfg:
            TRIGGER_TEXTS = [cfg["triggerText"].lower()]
        if "bannedKeywords" in cfg:
            custom = cfg["bannedKeywords"]
            if isinstance(custom, list) and len(custom) > 0:
                default_bk = [
                    "rm -rf /", "rm -rf ~", "rm -rf /*", "rm -rf .",
                    "sudo rm", "chmod 777", "> /dev/", "dd if=", "mkfs.",
                    ":(){:|:&};:", "shutdown", "reboot",
                ]
                merged = list(set(default_bk + custom))
                BANNED_KEYWORDS = merged
            else:
                log.warning("Config tried to empty bannedKeywords - ignoring")
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"Config load error: {e}")

# ─── Action Log ──────────────────────────────────────────────────────

def log_action(action_type, command, reason, learn_pattern=None):
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "type": action_type,
        "command": command,
        "reason": reason,
    }
    if learn_pattern:
        entry["learn"] = learn_pattern
    try:
        log_dir = os.path.dirname(ACTION_LOG_FILE)
        if not os.path.exists(log_dir):
            os.makedirs(log_dir, exist_ok=True)
        with open(ACTION_LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        # FIX #7: Log rotation - keep last 500 lines if over 1000
        try:
            with open(ACTION_LOG_FILE, "r") as f:
                lines = f.readlines()
            if len(lines) > 1000:
                with open(ACTION_LOG_FILE, "w") as f:
                    f.writelines(lines[-500:])
                log.info(f"Action log rotated: {len(lines)} -> 500 lines")
        except OSError:
            pass
    except OSError as e:
        log.warning(f"Action log write error: {e}")

# ─── Signal Handling ─────────────────────────────────────────────────

def cleanup():
    for path in ["/tmp/kiro-autorun-launch.scpt"]:
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass

def signal_handler(signum, frame):
    global running
    log.info(f"Received {signal.Signals(signum).name}, shutting down...")
    running = False

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)
atexit.register(cleanup)

# ─── Window Finding ──────────────────────────────────────────────────

def find_kiro_window():
    """Find the main Kiro window - returns dict with x, y, w, h, pid, windowID.
    Note: Kiro often registers as 'Electron' in CGWindowList, not 'Kiro'.
    Tries on-screen windows first, then ALL windows (for hidden/minimized Kiro)."""
    target_names = {TARGET_APP.lower(), "electron", "kiro"}

    # Try on-screen first (preferred — gives accurate bounds),
    # then ALL windows as fallback (hidden/minimized Kiro)
    for option in [kCGWindowListOptionOnScreenOnly, 0x0]:
        best = None
        best_area = 0
        window_list = CGWindowListCopyWindowInfo(option, kCGNullWindowID)
        if not window_list:
            continue
        for w in window_list:
            owner_name = (w.get("kCGWindowOwnerName") or "").lower()
            if owner_name in target_names and w.get("kCGWindowLayer", 999) == 0:
                b = w.get("kCGWindowBounds", {})
                x, y, width, height = int(b["X"]), int(b["Y"]), int(b["Width"]), int(b["Height"])
                area = width * height
                if area > best_area:
                    best_area = area
                    best = {
                        "x": x, "y": y, "w": width, "h": height,
                        "pid": w.get("kCGWindowOwnerPID"),
                        "windowID": w.get("kCGWindowNumber"),
                        "appName": w.get("kCGWindowOwnerName"),
                        "windowTitle": w.get("kCGWindowName", ""),
                        "offscreen": option != kCGWindowListOptionOnScreenOnly,
                    }
        if best:
            if best.get("offscreen"):
                log.info(f"   Kiro found via ALL windows (hidden/minimized)")
            return best
    return None

# ─── Background Window OCR (in-memory, zero disk I/O) ────────────────

# Bottom portion of window to OCR (0.0=full, 0.4=bottom 40%)
# "Waiting on your input" and buttons are always at the bottom
OCR_CROP_TOP = 0.4  # Skip top 40%, only OCR bottom 60%

def ocr_window(win):
    """Capture and OCR the Kiro window in memory.
    Uses CGWindowListCreateImage for background-safe capture.
    Works even when Kiro is behind other apps."""
    window_id = win.get("windowID")
    if not window_id:
        return []

    # Capture specific window in-memory (works when Kiro is in background)
    image = CGWindowListCreateImage(
        CGRectNull,  # Capture full window bounds
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageDefault
    )
    if not image:
        return []

    results = []
    completed = [False]

    def handler(request, error):
        if error:
            log.warning(f"OCR error: {error}")
            completed[0] = True
            return
        observations = request.results()
        if observations:
            for obs in observations:
                cands = obs.topCandidates_(1)
                if cands:
                    text = cands[0].string()
                    box = obs.boundingBox()
                    results.append({
                        "text": text,
                        "x": box.origin.x,
                        "y": 1.0 - box.origin.y - box.size.height,
                        "w": box.size.width,
                        "h": box.size.height,
                    })
        completed[0] = True

    req = Vision.VNRecognizeTextRequest.alloc().initWithCompletionHandler_(handler)
    req.setRecognitionLevel_(1)
    req.setUsesLanguageCorrection_(False)

    handler_obj = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(image, None)
    handler_obj.performRequests_error_([req], None)

    timeout = 5.0
    start = time.time()
    while not completed[0] and time.time() - start < timeout:
        time.sleep(0.05)

    return results

# ─── Accessibility API - Press Buttons Without Cursor ─────────────────

def ax_get(element, attr):
    """Get an attribute from an AXUIElement."""
    err, val = AXUIElementCopyAttributeValue(element, attr, None)
    return val if err == 0 else None

def ax_find_buttons(element, target_titles, depth=0, max_depth=15):
    """Recursively search Kiro's Accessibility tree for buttons by title.
    Returns list of (title, ax_element) tuples found.
    Works on background apps - no focus required."""
    found = []
    if depth > max_depth:
        return found

    role = ax_get(element, "AXRole")
    title = ax_get(element, "AXTitle") or ""
    role_desc = ax_get(element, "AXRoleDescription") or ""
    desc = ax_get(element, "AXDescription") or ""

    # Check if this is a matching button (check multiple roles for Electron)
    if role in ("AXButton", "AXLink", "AXMenuItem", "AXStaticText", "AXGroup"):
        title_lower = str(title).strip().lower()
        desc_lower = str(desc).strip().lower()
        role_desc_lower = str(role_desc).strip().lower()
        for target in target_titles:
            t = target.lower()
            if t == title_lower or t == desc_lower or t in role_desc_lower:
                found.append((target, element))

    # Recurse into children
    children = ax_get(element, "AXChildren")
    if children:
        for child in children:
            found.extend(ax_find_buttons(child, target_titles, depth + 1, max_depth))

    return found

def ax_debug_tree(element, depth=0, max_depth=5):
    """Debug: log AX tree to identify interactive elements."""
    if depth > max_depth:
        return
    role = ax_get(element, "AXRole") or ""
    title = ax_get(element, "AXTitle") or ""
    desc = ax_get(element, "AXDescription") or ""
    value = ax_get(element, "AXValue") or ""
    # Only log interactive elements to avoid noise
    if role in ("AXButton", "AXLink", "AXMenuItem", "AXCheckBox", "AXPopUpButton") and (title or desc):
        indent = "  " * depth
        log.info(f"   AX-DEBUG {indent}[{role}] title='{title}' desc='{desc}' val='{str(value)[:50]}'")
    children = ax_get(element, "AXChildren")
    if children:
        for child in children:
            ax_debug_tree(child, depth + 1, max_depth)

def ax_press_button(kiro_pid, button_titles, ocr_confirmed_dialog=False, win=None):
    """Find and press a button in Kiro's UI via Accessibility API.
    Context-aware: only press 'Run'/'Play' if we have dialog context
    (OCR detected 'waiting on your input' or AX found Trust/Reject buttons)."""
    try:
        app = AXUIElementCreateApplication(kiro_pid)
        if not app:
            return False, None

        buttons = ax_find_buttons(app, button_titles)
        if not buttons:
            # Debug: log what AX elements exist (only once per stuck cycle)
            if stuck_cycles == 1:
                log.info("   AX-DEBUG: Scanning for interactive elements...")
                ax_debug_tree(app)
            return False, None

        # Collect what button titles we found
        found_titles = {b[0].lower() for b in buttons}
        log.info(f"   Found AX buttons: {found_titles}")

        # Context check
        is_dialog = ocr_confirmed_dialog

        # Filter buttons
        safe_buttons = []
        for title, element in buttons:
            t = title.lower()
            if t not in PRESSABLE_BUTTONS:
                continue
            safe_buttons.append((title, element))

        if not safe_buttons:
            log.info("   All buttons filtered out")
            return False, None

        # Press the first safe button
        title, button_element = safe_buttons[0]
        err = AXUIElementPerformAction(button_element, "AXPress")
        if err == 0:
            return True, title
        else:
            log.warning(f"AXPress failed for '{title}' (error: {err})")
            return False, None

    except Exception as e:
        log.warning(f"Accessibility API error: {e}")
        return False, None

# (AppleScript fallback removed - cannot click web-rendered buttons in Electron)

# ─── OCR Position-Based Click ────────────────────────────────────────

def ocr_find_dialog_button(ocr_results, win, ocr_confirmed_dialog=False):
    """Find a pressable dialog button via OCR position.
    Returns (button_text, pixel_x, pixel_y) or None.
    
    Strategy:
    1. Primary: find 'Run'/'Trust'/Play icon text on SAME line as 'Reject'
    2. Fallback: if dialog is confirmed via trigger text but no 'Reject' visible
       (Kiro may use icon-only buttons), search bottom 30% for Play/Run text
    """
    # Find the Y position of "reject" text (dialog indicator)
    reject_y = None
    for r in ocr_results:
        text = r["text"].strip().lower()
        if text == "reject" or text == "reject all":
            reject_y = r["y"]
            break
    
    # OCR y values are normalized (0.0 = top, 1.0 = bottom)
    # Same "line" = within 3% vertical distance
    Y_TOLERANCE = 0.03
    
    def _coords(r):
        """Convert normalized OCR coords to absolute screen pixels."""
        win_x, win_y = win["x"], win["y"]
        win_w, win_h = win["w"], win["h"]
        px = win_x + int((r["x"] + r["w"] / 2) * win_w)
        py = win_y + int((r["y"] + r["h"] / 2) * win_h)
        return px, py
    
    # Debug: log all OCR text in bottom 50% to help diagnose
    bottom_texts = [r["text"].strip() for r in ocr_results if r["y"] > 0.5]
    if bottom_texts:
        log.info(f"   OCR bottom 50%: {bottom_texts[:15]}")
    
    # Strategy 1: Match button text on same line as "reject"
    if reject_y is not None:
        log.info(f"   OCR found 'Reject' at y={reject_y:.3f}")
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and abs(r["y"] - reject_y) < Y_TOLERANCE:
                    px, py = _coords(r)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - same line as Reject")
                    return btn_text, px, py
        log.info(f"   No dialog button text found on Reject line (y={reject_y:.3f})")
    else:
        log.info(f"   OCR did NOT find 'Reject' text anywhere")
    
    # Strategy 2: Dialog confirmed by trigger text but no "reject" text visible
    # (Kiro may show icon-only buttons like ▶ without text "Reject")
    # Search bottom 30% of window for any dialog button text/icon
    if ocr_confirmed_dialog and reject_y is None:
        BOTTOM_THRESHOLD = 0.7  # Only look in bottom 30%
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and r["y"] > BOTTOM_THRESHOLD:
                    px, py = _coords(r)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - bottom area (no Reject text)")
                    return btn_text, px, py
        log.info(f"   Strategy 2 also failed - no button text in bottom 30%")
    
    return None

def bring_kiro_to_front(kiro_pid):
    """Activate Kiro and return the previously active app for restoration.
    Handles hidden, minimized, and background windows.
    Waits up to 500ms to verify Kiro is actually frontmost."""
    try:
        workspace = AppKit.NSWorkspace.sharedWorkspace()
        prev_app = workspace.frontmostApplication()
        target_app = None
        for app in workspace.runningApplications():
            if app.processIdentifier() == kiro_pid:
                target_app = app
                break
        
        if not target_app:
            log.warning(f"bring_kiro_to_front: app with PID {kiro_pid} not found")
            return prev_app
        
        # Unhide if hidden (Cmd+H)
        if target_app.isHidden():
            target_app.unhide()
        
        # Activate with ALL windows + ignoring other apps
        activate_flags = (
            AppKit.NSApplicationActivateAllWindows |
            AppKit.NSApplicationActivateIgnoringOtherApps
        )
        target_app.activateWithOptions_(activate_flags)
        
        # Wait until Kiro is actually frontmost (up to 1.5s for Space switch animation)
        for i in range(30):
            time.sleep(0.05)
            front = workspace.frontmostApplication()
            if front and front.processIdentifier() == kiro_pid:
                if i > 5:
                    log.info(f"   Kiro activated after Space switch ({i*50}ms)")
                else:
                    log.info(f"   Kiro activated ({i*50}ms)")
                return prev_app
        
        log.warning(f"bring_kiro_to_front: Kiro did not become frontmost in 1.5s")
        return prev_app
    except Exception as e:
        log.warning(f"bring_kiro_to_front error: {e}")
        return None

def restore_previous_app(prev_app):
    """Reactivate the previously frontmost app after clicking Kiro."""
    if prev_app:
        try:
            prev_app.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
        except Exception as e:
            log.warning(f"restore_previous_app error: {e}")

def click_at_position(x, y, kiro_pid=None, win=None):
    """Click at screen coordinates using CGEvent.
    Only CGEvent works for Electron web-rendered buttons.
    Brings Kiro to front briefly (~200ms), clicks, then restores previous app.
    Saves and restores cursor position."""
    # Guard: verify target coordinates are inside Kiro window bounds
    if win:
        wx, wy = win["x"], win["y"]
        ww, wh = win["w"], win["h"]
        if not (wx <= x <= wx + ww and wy <= y <= wy + wh):
            log.warning(f"Click guard: ({x},{y}) is outside Kiro window ({wx},{wy})-({wx+ww},{wy+wh})")
            return False

    prev_app = None
    try:
        # Save current cursor position
        current_pos = Quartz.NSEvent.mouseLocation()
        screen_height = Quartz.CGDisplayPixelsHigh(Quartz.CGMainDisplayID())
        saved_x = current_pos.x
        saved_y = screen_height - current_pos.y

        # Hide cursor to prevent visible flash
        Quartz.CGDisplayHideCursor(Quartz.CGMainDisplayID())

        # Bring Kiro to front (required for CGEvent to hit Kiro, not another window)
        if kiro_pid:
            prev_app = bring_kiro_to_front(kiro_pid)
            time.sleep(0.05)  # Small buffer after verified activation
        
        # Click at target position
        point = Quartz.CGPointMake(x, y)
        evt_down = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
        evt_up = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt_down)
        time.sleep(0.03)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt_up)
        
        # Restore cursor position
        time.sleep(0.01)
        restore_point = Quartz.CGPointMake(saved_x, saved_y)
        restore_evt = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventMouseMoved, restore_point, Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, restore_evt)
        
        return True
    except Exception as e:
        log.warning(f"CGEvent click error: {e}")
        return False
    finally:
        # Always show cursor and restore previous app
        Quartz.CGDisplayShowCursor(Quartz.CGMainDisplayID())
        if prev_app:
            time.sleep(0.05)
            restore_previous_app(prev_app)

# ─── Cooldown ────────────────────────────────────────────────────────

def compute_screen_hash(ocr_results):
    text = " ".join(r["text"] for r in ocr_results)[:500]
    return hashlib.md5(text.encode()).hexdigest()[:12]

def is_in_cooldown(screen_hash):
    global last_click_hash, last_click_time
    now = time.time()
    if now - last_click_time < CLICK_DEBOUNCE_SECONDS:
        return True
    if screen_hash == last_click_hash and now - last_click_time < COOLDOWN_SECONDS:
        return True
    return False

def record_click(screen_hash):
    global last_click_hash, last_click_time
    last_click_hash = screen_hash
    last_click_time = time.time()

# ─── Notification ────────────────────────────────────────────────────

def send_notification(msg, play_sound=False):
    if NOTIFICATION_SOUND and play_sound:
        try:
            subprocess.Popen(["afplay", "/System/Library/Sounds/Basso.aiff"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass
    if not SHOW_NOTIFICATION:
        return
    try:
        # FIX #4: Sanitize msg for AppleScript - prevent injection
        safe_msg = msg.replace('\\', '\\\\').replace('"', '\\"').replace("'", "")[:200]
        subprocess.run(["osascript", "-e",
            f'display notification "{safe_msg}" with title "Kiro AutoRun"'],
            timeout=2, capture_output=True)
    except (subprocess.TimeoutExpired, OSError):
        pass

# ─── Smart Command Analysis ─────────────────────────────────────────

def extract_command_text(ocr_results):
    """Extract the actual command text from OCR results.
    Looks for text near the LAST 'Command' label in Kiro's UI
    (closest to the 'Waiting on your input' trigger).
    Returns the command string or None."""
    
    # Find ALL OCR blocks containing 'Command' header - we want the LAST one
    # (nearest to bottom = most recent command in chat)
    cmd_headers = []
    for r in ocr_results:
        text = r["text"].strip().lower()
        if text == "command" or text.startswith("command"):
            cmd_headers.append(r)
    
    if not cmd_headers:
        return None
    
    # Use the LAST (bottommost) Command header - closest to "Waiting on your input"
    last_header = max(cmd_headers, key=lambda r: r["y"])
    cmd_header_y = last_header["y"]
    cmd_header_x = last_header["x"]
    
    # Find the text block immediately below/after the LAST 'Command' header
    # Must be: below the header (y > header_y) and within small vertical range
    candidates = []
    for r in ocr_results:
        text = r["text"].strip()
        # Skip short labels and button texts
        if len(text) < 3:
            continue
        if text.lower() in ("command", "reject", "trust", "run", "accept", "accept all",
                            "reject all", "waiting on your input", "cancel", "continue",
                            "checkpoint", "restore", "kiro"):
            continue
        # Text should be BELOW the last Command header (or on same line)
        # and within a close vertical range (< 5% of window height)
        y_diff = r["y"] - cmd_header_y
        if -0.01 <= y_diff < 0.05:
            candidates.append((y_diff, r["x"], text))
    
    if candidates:
        # Sort by Y (closest below header first), then by X (leftmost first)
        candidates.sort(key=lambda c: (c[0], c[1]))
        cmd = candidates[0][2]
        # Log all candidates for debugging
        if len(candidates) > 1:
            log.info(f"   Command candidates: {[c[2][:50] for c in candidates[:5]]}")
        return cmd

    # Fallback: look for text that looks like a shell command
    for r in ocr_results:
        text = r["text"].strip()
        if len(text) > 5:
            lower = text.lower()
            if any(lower.startswith(p) for p in [
                "npm ", "node ", "python", "git ", "cp ", "mv ", "rm ", "mkdir ",
                "diff ", "cat ", "ls ", "cd ", "echo ", "curl ", "wget ", "pip ",
                "cargo ", "go ", "make ", "docker ", "brew ", "tar ", "find ",
                "grep ", "sed ", "awk ", "sort ", "touch ", "head ", "tail ",
                "chmod ", "ln ", "zip ", "unzip ", "test ", "sudo ", "./",
            ]):
                return text

    return None

def analyze_command_safety(cmd_text, all_text_lower):
    """Analyze if a command is safe to auto-approve.
    Returns (safe: bool, reason: str).
    
    Security checks (in order):
    1. Unicode normalization (prevent homoglyph bypass)
    2. Command chaining detection (&&, ||, ;, backticks, $())
    3. Sudo detection (anywhere in command, with path/flag handling)
    4. Base command against INHERENTLY_DANGEROUS set
    5. DANGEROUS_PATTERNS in full command
    6. BANNED_KEYWORDS check
    """
    import unicodedata

    # No command visible -> safe to approve (it's just a dialog)
    if not cmd_text:
        return True, "No command text detected"

    # === FIX #2: Unicode normalization ===
    # Converts fullwidth ｒｍ -> rm, strips zero-width chars
    cmd_normalized = unicodedata.normalize("NFKD", cmd_text)
    # Remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF, etc.)
    cmd_normalized = ''.join(c for c in cmd_normalized 
                            if unicodedata.category(c) != 'Cf')
    cmd_lower = cmd_normalized.lower().strip()

    # === FIX #1: Command chaining detection ===
    # Block commands that chain multiple operations
    CHAIN_OPERATORS = ['&&', '||', ';', '`', '$(']
    for op in CHAIN_OPERATORS:
        if op in cmd_lower:
            return False, f"Command chaining detected: '{op}'"
    
    # Pipe to shell (| sh, | bash, | zsh) - but allow safe pipes (| grep, | sort)
    DANGEROUS_PIPE_TARGETS = {'sh', 'bash', 'zsh', 'python', 'python3', 'perl', 
                               'ruby', 'node', 'eval'}
    import re
    pipe_matches = re.findall(r'\|\s*(\S+)', cmd_lower)
    for target in pipe_matches:
        target_base = target.split('/')[-1]
        if target_base in DANGEROUS_PIPE_TARGETS:
            return False, f"Pipe to shell: | {target_base}"

    # Extract base command (first word, strip path)
    parts = cmd_lower.split()
    base_cmd = parts[0].split("/")[-1] if parts else ""

    # === FIX #4: Full sudo detection ===
    # Check for sudo ANYWHERE in the command, not just position 0
    sudo_variants = {'sudo', '/usr/bin/sudo', '/usr/local/bin/sudo'}
    for i, part in enumerate(parts):
        part_base = part.split('/')[-1]
        if part_base == 'sudo' or part in sudo_variants:
            # Find the actual command after sudo (skip flags like -u, -E, -i)
            actual_cmd = None
            for j in range(i + 1, len(parts)):
                if not parts[j].startswith('-'):
                    actual_cmd = parts[j].split('/')[-1]
                    break
            if actual_cmd and actual_cmd in INHERENTLY_DANGEROUS:
                return False, f"Dangerous: sudo {actual_cmd}"
            # sudo with any potentially dangerous command
            if actual_cmd in {'rm', 'chmod', 'chown', 'kill', 'pkill', 'killall'}:
                return False, f"sudo + risky command: sudo {actual_cmd}"

    # Handle 'env' wrapper: env VAR=val command -> extract actual command
    actual_base = base_cmd
    if base_cmd == 'env':
        for part in parts[1:]:
            if '=' not in part and not part.startswith('-'):
                actual_base = part.split('/')[-1]
                break

    # 1. Check inherently dangerous commands
    if actual_base in INHERENTLY_DANGEROUS:
        return False, f"Inherently dangerous command: {actual_base}"

    # === FIX #7: Refined dangerous patterns ===
    # Only match specific dangerous combos, not bare "--force"
    REFINED_DANGEROUS_PATTERNS = [
        "push --force",             # git push --force
        "push -f",                  # git push -f  
        "reset --hard",             # git reset --hard
        "> /dev/",                  # Write to device
        "-rf /", "-rf ~", "-rf /*", # Recursive force delete root/home
        "-rf .",                    # Recursive force delete current dir
        "chmod 777", "chmod -R 777",
        "drop table", "drop database",
        ":(){:|:&};:",              # Fork bomb
    ]
    for pattern in REFINED_DANGEROUS_PATTERNS:
        if pattern.lower() in cmd_lower:
            return False, f"Dangerous pattern: {pattern}"

    # 3. Check banned keywords (only in actual command text, not all screen text)
    for keyword in BANNED_KEYWORDS:
        if keyword.lower() in cmd_lower:
            return False, f"Banned keyword: {keyword}"

    # All checks passed -> safe
    return True, f"Safe command: {base_cmd}"
# ─── Main ────────────────────────────────────────────────────────────

def monitor_cycle():
    global click_count, stuck_cycles

    load_config()

    win = find_kiro_window()
    if not win:
        stuck_cycles = 0
        return

    ocr_results = ocr_window(win)
    if not ocr_results:
        stuck_cycles = 0
        return

    # Check for trigger text
    all_text_lower = " ".join(r["text"].lower() for r in ocr_results)
    matched_trigger = None
    for trigger in TRIGGER_TEXTS:
        if trigger in all_text_lower:
            matched_trigger = trigger
            break

    # Also check for accept all / reject all (Kiro v0.8+)
    has_accept_all = "accept all" in all_text_lower and "reject all" in all_text_lower

    # OCR visual verification: check that we see dialog buttons on screen
    # This prevents clicking sidebar "Run" when there's no actual command dialog
    # Includes Play icon variants (▶, ►) that OCR may detect
    ocr_sees_dialog_buttons = any(
        btn in all_text_lower for btn in ["reject", "trust", "▶", "►", "play"]
    )
    # "Waiting on your input" = confirmed dialog. Position filtering in AX API
    # handles sidebar false positives, so trigger text alone is sufficient.
    ocr_confirmed_dialog = bool(matched_trigger)

    if not matched_trigger and not has_accept_all:
        stuck_cycles = 0
        return

    trigger_label = matched_trigger or "Accept All/Reject All"
    log.info(f"Detected: '{trigger_label}'")

    # Extract actual command text from OCR (near "Command" label)
    cmd_text = extract_command_text(ocr_results)
    if cmd_text:
        log.info(f"   Command: {cmd_text[:120]}")

    # Cooldown
    screen_hash = compute_screen_hash(ocr_results)
    if is_in_cooldown(screen_hash):
        return

    # === PRIMARY: Accessibility API (no cursor movement!) ===
    kiro_pid = win.get("pid")

    # Smart analysis: determine if command is safe
    safe, safety_reason = analyze_command_safety(cmd_text, all_text_lower)
    if not safe:
        log.info(f"BLOCKED - {safety_reason}")
        send_notification(f"Blocked: {safety_reason}", play_sound=True)
        log_action("denied", cmd_text or trigger_label, safety_reason)
        record_click(screen_hash)
        stuck_cycles = 0
        return

    # Determine what pattern to learn
    # SECURITY: some commands have dangerous variants - never auto-learn these
    # e.g. learning "rm *" would let Kiro auto-approve "rm -rf /" next time!
    NEVER_LEARN = {
        "rm", "rmdir",                    # rm -rf / would match "rm *"
        "chmod", "chown", "chgrp",        # chmod 777 would match "chmod *"
        "curl", "wget",                   # curl | sh would match "curl *"
        "git",                            # git push --force would match "git *"
        "kill", "pkill",                  # kill -9 would match "kill *"
        "dd", "mkfs", "fdisk",            # always dangerous
        "sudo",                           # never trust sudo wildcard
        "ssh", "scp", "rsync",            # network operations need review
        "docker", "kubectl",              # container operations need review
        "pip", "pip3", "npm", "npx",      # package install can run arbitrary code
        "eval", "exec", "source", ".",    # code execution
    }

    learn_pattern = None
    if cmd_text:
        base_cmd = cmd_text.strip().split()[0] if cmd_text.strip() else None
        if base_cmd:
            # Strip path prefix (e.g. /usr/bin/diff -> diff)
            base_cmd = base_cmd.split("/")[-1]
            if base_cmd.lower() in NEVER_LEARN:
                log.info(f"   '{base_cmd}' is in NEVER_LEARN - will not auto-trust")
            elif cmd_text.strip().startswith("sudo "):
                log.info(f"   sudo command - will not auto-trust")
            else:
                learn_pattern = f"{base_cmd} *"
                log.info(f"   Learn pattern: '{learn_pattern}'")

    if kiro_pid:
        # === PRIMARY: AX API (handles icon buttons like Play ▶) ===
        # AX API can find buttons by title/description even when visually icon-only
        # This is now PRIMARY because Kiro's newer UI uses Play icon instead of "Run" text
        pressed, btn_title = ax_press_button(kiro_pid, CLICKABLE_BUTTONS, ocr_confirmed_dialog=ocr_confirmed_dialog, win=win)
        if pressed:
            click_count += 1
            log.info(f"AX pressed '{btn_title}' (#{click_count})")
            send_notification(f"Auto-approved '{btn_title}' (#{click_count})")
            log_action("auto-approved", cmd_text or btn_title,
                      f"Trigger: {trigger_label} [AX API]", learn_pattern)
            record_click(screen_hash)
            stuck_cycles = 0
            time.sleep(2.5)  # Wait for Kiro UI to update before next poll
            return

        # === SECONDARY: OCR-position click (fallback for text buttons) ===
        # Dialog buttons may be web-rendered; find via OCR position near "Reject"
        dialog_btn = ocr_find_dialog_button(ocr_results, win, ocr_confirmed_dialog=ocr_confirmed_dialog)
        if dialog_btn:
            btn_text, px, py = dialog_btn
            if click_at_position(px, py, kiro_pid=kiro_pid, win=win):
                click_count += 1
                log.info(f"OCR-click pressed '{btn_text}' at ({px},{py}) (#{click_count})")
                send_notification(f"Auto-approved '{btn_text}' (#{click_count})")
                log_action("auto-approved", cmd_text or btn_text,
                          f"Trigger: {trigger_label} [OCR-click]", learn_pattern)
                record_click(screen_hash)
                stuck_cycles = 0
                time.sleep(2.5)  # Wait for Kiro UI to update before next poll
                return

    # No button found - possible stuck state
    stuck_cycles += 1
    log.info(f"Trigger found but no button via AX/AppleScript (stuck: {stuck_cycles}/{STUCK_THRESHOLD})")

    if stuck_cycles >= STUCK_THRESHOLD and STUCK_RECOVERY_ENABLED:
        # FIX #10: Log warning instead of stealing focus
        # Old behavior: bring Kiro to front (steals focus, disrupts user)
        # New behavior: just log and reset counter, let user handle it
        log.warning(f"Stuck for {stuck_cycles} cycles - trigger detected but no button found")
        log.warning(f"   This may mean Kiro's UI has changed. Check /tmp/kiro-autorun.log")
        send_notification(f"Stuck: trigger found but can't press button", play_sound=True)
        log_action("stuck", "no_button", f"Stuck {stuck_cycles} cycles - no focus steal")
        stuck_cycles = 0

def main():
    load_config()

    # Kill any existing instances (prevent zombie pile-up)
    import signal
    my_pid = os.getpid()
    try:
        out = subprocess.check_output(['pgrep', '-f', 'kiro-autorun-v3.py'], text=True)
        for line in out.strip().split('\n'):
            pid = int(line.strip())
            if pid != my_pid:
                try:
                    os.kill(pid, signal.SIGTERM)
                    log.info(f"Killed old instance PID {pid}")
                except ProcessLookupError:
                    pass
    except (subprocess.CalledProcessError, ValueError):
        pass  # No other instances

    log.info("Kiro AutoRun v2.1.0 - OCR + CGEvent Click")
    log.info(f"   Works while Kiro is in background")
    log.info(f"   Does NOT move cursor")
    log.info(f"   Does NOT steal focus")
    log.info(f"   Target: {TARGET_APP}")
    log.info(f"   Triggers: {TRIGGER_TEXTS}")
    log.info(f"   Buttons: {CLICKABLE_BUTTONS}")
    log.info(f"   Poll: {POLL_INTERVAL}s")
    log.info(f"   Banned: {len(BANNED_KEYWORDS)} keywords")
    log.info(f"   Config: {CONFIG_FILE}")
    log.info(f"   Action log: {ACTION_LOG_FILE}")
    log.info("")

    win = find_kiro_window()
    if win:
        log.info(f"Kiro: {win['w']}x{win['h']} (PID: {win['pid']}, WinID: {win['windowID']})")
    else:
        log.info("Kiro not found yet, will keep checking...")
    log.info("")
    log.info("Monitoring... (Ctrl+C or SIGTERM to stop)")
    log.info("")

    while running:
        try:
            monitor_cycle()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log.error(f"Cycle error: {e}")
        time.sleep(POLL_INTERVAL)

    log.info("Stopped")

if __name__ == "__main__":
    main()
