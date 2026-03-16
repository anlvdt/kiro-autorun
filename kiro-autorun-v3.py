#!/usr/bin/env python3
"""
Kiro AutoRun v2.1.4 - OCR + CGEvent Click
Auto-approves Kiro IDE command prompts WITHOUT moving the cursor.

Architecture:
  1. Background window capture (screencapture -l <windowID>) - works while Kiro is behind other apps
  2. Vision OCR - detects trigger text ("waiting on your input", "accept all", etc.)
  3. Accessibility API (AXUIElement.performAction) - presses buttons WITHOUT cursor movement
  4. Fallback: AppleScript "click button" via System Events - also no cursor movement

User can work on other apps normally while Kiro auto-approves in background.
"""

import subprocess, time, sys, os, json, signal, atexit, logging, re, unicodedata, tempfile, hashlib

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
DIALOG_BUTTON_TEXTS = ["run", "trust", "▶", "►", "▷", "play", "⏵"]  # Include Play icon variants
# Buttons we actually want to press
PRESSABLE_BUTTONS = {"accept all", "trust", "run", "play"}

COOLDOWN_SECONDS = 5          # Block clicks for 5s after any click (4s sleep + 2s poll = 6s cycle)

# ─── Adaptive poll rates ─────────────────────────────────────────────
POLL_SLOW   = 5.0   # No Kiro window found — conserve CPU
POLL_NORMAL = 2.0   # Kiro visible, no trigger yet — default cadence
POLL_FAST   = 0.8   # Trigger detected — respond quickly

# ─── Learned commands persistent file ────────────────────────────────
LEARNED_FILE = os.path.expanduser("~/.kiro-autorun/learned.json")
AUTO_TRUST_THRESHOLD = 5     # Approve N times → signal TypeScript to auto-trust

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
last_click_cmd = None    # Track by COMMAND text, not screen hash
last_click_time = 0
stuck_cycles = 0
STUCK_THRESHOLD = 5

# ─── Performance: image change detection ─────────────────────────────
_last_img_hash: str | None = None   # MD5 of last captured image bytes
_last_img_had_trigger = False        # Was trigger visible in last OCR?

# ─── Self-learning: approval frequency counter ────────────────────────
try:
    from collections import Counter
    _approval_freq: Counter = Counter()
except ImportError:
    _approval_freq = {}

# ─── Config ──────────────────────────────────────────────────────────

def load_config():
    global POLL_INTERVAL, TARGET_APP, TRIGGER_TEXTS, BANNED_KEYWORDS
    global SHOW_NOTIFICATION, NOTIFICATION_SOUND, STUCK_RECOVERY_ENABLED

    if not os.path.exists(CONFIG_FILE):
        return
    try:
        # Check config file permissions
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
        # Sanitize targetApp to prevent injection
        raw_app = cfg.get("targetApp", TARGET_APP)
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

# ─── Learned Commands: cross-session persistence ─────────────────────

def load_learned() -> None:
    """Load persisted approval frequency counts from learned.json."""
    global _approval_freq
    if not os.path.exists(LEARNED_FILE):
        return
    try:
        with open(LEARNED_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            from collections import Counter
            _approval_freq = Counter(data)
            log.info(f"   Loaded {len(_approval_freq)} learned patterns from {LEARNED_FILE}")
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"learned.json load error: {e}")

def save_learned() -> None:
    """Persist approval frequency counts to learned.json."""
    try:
        learned_dir = os.path.dirname(LEARNED_FILE)
        if not os.path.exists(learned_dir):
            os.makedirs(learned_dir, exist_ok=True)
        with open(LEARNED_FILE, "w") as f:
            json.dump(dict(_approval_freq), f, indent=2)
    except OSError as e:
        log.warning(f"learned.json save error: {e}")

# ─── Action Log ──────────────────────────────────────────────────────

def log_action(action_type, command, reason, learn_pattern=None, auto_trust=False):
    entry = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "type": action_type,
        "command": command,
        "reason": reason,
    }
    if learn_pattern:
        entry["learn"] = learn_pattern
    if auto_trust and learn_pattern:
        entry["auto_trust"] = True   # Signal TypeScript to add to trustedCommands immediately
    try:
        log_dir = os.path.dirname(ACTION_LOG_FILE)
        if not os.path.exists(log_dir):
            os.makedirs(log_dir, exist_ok=True)
        with open(ACTION_LOG_FILE, "a") as f:
            f.write(json.dumps(entry) + "\n")
        # Log rotation — keep last 500 lines when over 1000
        # Read once, write once (single open to minimize TOCTOU window)
        try:
            with open(ACTION_LOG_FILE, "r") as f:
                lines = f.readlines()
            if len(lines) > 1000:
                kept = lines[-500:]
                with open(ACTION_LOG_FILE, "w") as f:
                    f.writelines(kept)
                log.info(f"Action log rotated: {len(lines)} -> {len(kept)} lines")
        except OSError:
            pass
    except OSError as e:
        log.warning(f"Action log write error: {e}")

# ─── Signal Handling ─────────────────────────────────────────────────

def cleanup():
    _path = "/tmp/kiro-autorun-launch.scpt"
    try:
        if os.path.exists(_path):
            os.remove(_path)
    except OSError:
        pass

def signal_handler(signum, frame):
    global running
    try:
        sig_name = signal.Signals(signum).name
    except ValueError:
        sig_name = str(signum)
    log.info(f"Received {sig_name}, shutting down...")
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

def _load_cgimage_from_file(path):
    """Load a PNG/JPEG file as a CGImage for Vision OCR."""
    try:
        from Quartz import CGImageSourceCreateWithURL, CGImageSourceCreateImageAtIndex
        from CoreFoundation import CFURLCreateWithFileSystemPath, kCFAllocatorDefault, kCFURLPOSIXPathStyle
        url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, path, kCFURLPOSIXPathStyle, False)
        src = CGImageSourceCreateWithURL(url, None)
        if src:
            return CGImageSourceCreateImageAtIndex(src, 0, None)
    except Exception as e:
        log.warning(f"_load_cgimage_from_file error: {e}")
    return None


def _screencapture_fallback(window_id):
    """Fallback: use macOS screencapture CLI to capture a window by ID.
    Works when CGWindowListCreateImage fails (permission or Space issues).
    screencapture has its own Screen Recording permission entry and can
    capture windows across macOS Spaces."""
    # Use a unique temp path to avoid race condition if somehow 2 processes run
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".png", prefix="kiro-capture-")
    os.close(tmp_fd)
    try:
        result = subprocess.run(
            ["screencapture", "-l", str(window_id), "-x", "-o", tmp_path],
            timeout=5, capture_output=True
        )
        if result.returncode == 0 and os.path.exists(tmp_path):
            file_size = os.path.getsize(tmp_path)
            if file_size > 1000:  # Minimum sanity check (not just header)
                image = _load_cgimage_from_file(tmp_path)
                if image:
                    return image
            else:
                log.info(f"   screencapture produced tiny file ({file_size}B) — likely blank")
    except (subprocess.TimeoutExpired, OSError) as e:
        log.warning(f"screencapture fallback error: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError as e:
            log.warning(f"   Could not remove screencapture temp file {tmp_path}: {e}")
    return None


def ocr_window(win):
    """Capture and OCR the Kiro window in memory.
    Primary: CGWindowListCreateImage (fast, in-memory, no disk I/O).
    Fallback: screencapture -l (handles permission/Space issues).
    Works even when Kiro is behind other apps."""
    window_id = win.get("windowID")
    if not window_id:
        return []

    used_fallback = False

    # PRIMARY: Capture specific window in-memory
    # kCGWindowImageBoundsIgnoreFraming excludes window shadow/border
    image = CGWindowListCreateImage(
        CGRectNull,
        kCGWindowListOptionIncludingWindow,
        window_id,
        1  # kCGWindowImageBoundsIgnoreFraming
    )

    # FALLBACK chain when CGWindowListCreateImage fails:
    #   1. screencapture CLI (every 3rd attempt)
    #   2. Bring-to-front + capture (every 15th attempt, only when on different Space)
    if not image:
        if not hasattr(ocr_window, '_no_image_count'):
            ocr_window._no_image_count = 0
        ocr_window._no_image_count += 1

        # Fallback 1: screencapture CLI (throttled)
        if ocr_window._no_image_count % 3 == 1:
            image = _screencapture_fallback(window_id)
            if image:
                used_fallback = True
                if ocr_window._no_image_count <= 3:
                    log.info(f"   Using screencapture fallback")
                ocr_window._no_image_count = 0

        # Fallback 2: Bring Kiro to front briefly, capture, restore
        # Only when window is offscreen (different Space) and after 5+ failures
        # Throttled to every 15th attempt to minimize disruption
        if not image and win.get("offscreen") and ocr_window._no_image_count >= 5:
            if ocr_window._no_image_count % 15 == 5:
                kiro_pid = win.get("pid")
                if kiro_pid:
                    log.info(f"   Attempting bring-to-front capture (failures={ocr_window._no_image_count})")
                    prev_app = bring_kiro_to_front(kiro_pid)
                    time.sleep(0.3)  # Brief wait for Space switch animation
                    image = CGWindowListCreateImage(
                        CGRectNull,
                        kCGWindowListOptionIncludingWindow,
                        window_id,
                        1
                    )
                    if image:
                        used_fallback = True
                        log.info(f"   Bring-to-front capture succeeded")
                        ocr_window._no_image_count = 0
                    else:
                        log.info(f"   Bring-to-front capture also failed")
                    restore_previous_app(prev_app)

        if not image:
            if ocr_window._no_image_count <= 3 or ocr_window._no_image_count % 30 == 0:
                log.info(f"   All capture methods failed (wid={window_id}, count={ocr_window._no_image_count})")
            return []

    # ─── Performance: skip OCR if screenshot unchanged ───────────────────
    # Hash the raw pixel data of the captured image. If screen didn't change
    # since last cycle AND last OCR had no trigger text, skip expensive OCR.
    global _last_img_hash, _last_img_had_trigger
    try:
        import Quartz as _Q
        data_provider = _Q.CGImageGetDataProvider(image)
        raw_data = _Q.CGDataProviderCopyData(data_provider)
        if raw_data:
            img_hash = hashlib.md5(bytes(raw_data)).hexdigest()
            if img_hash == _last_img_hash and not _last_img_had_trigger:
                return []   # Screen unchanged and no trigger last time — skip OCR
            _last_img_hash = img_hash
    except Exception:
        pass  # Hash failed — proceed with OCR normally

    # Diagnostic: log image dimensions vs window bounds (Retina check)
    img_w = Quartz.CGImageGetWidth(image)
    img_h = Quartz.CGImageGetHeight(image)
    if not hasattr(ocr_window, '_diag_done'):
        ocr_window._diag_done = True
        src = "screencapture" if used_fallback else "CGWindowListCreateImage"
        log.info(f"   DIAG: image={img_w}x{img_h} window={win['w']}x{win['h']} ratio={img_w/win['w']:.1f}x (via {src})")
        # Save image for visual inspection
        try:
            from Quartz import CGImageDestinationCreateWithURL, CGImageDestinationAddImage, CGImageDestinationFinalize
            from CoreFoundation import CFURLCreateWithFileSystemPath, kCFAllocatorDefault, kCFURLPOSIXPathStyle
            url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, "/tmp/kiro-debug.png", kCFURLPOSIXPathStyle, False)
            dest = CGImageDestinationCreateWithURL(url, "public.png", 1, None)
            if dest:
                CGImageDestinationAddImage(dest, image, None)
                CGImageDestinationFinalize(dest)
                log.info(f"   DIAG: saved /tmp/kiro-debug.png ({img_w}x{img_h})")
        except Exception as e:
            log.info(f"   DIAG: could not save image: {e}")

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

    # Diagnostic: log when image was captured but OCR returned nothing
    if not results and image:
        if not hasattr(ocr_window, '_empty_count'):
            ocr_window._empty_count = 0
        ocr_window._empty_count += 1
        if ocr_window._empty_count <= 3 or ocr_window._empty_count % 30 == 0:
            log.info(f"   OCR returned 0 results (image={img_w}x{img_h}, offscreen={win.get('offscreen', False)}, count={ocr_window._empty_count})")
    elif results:
        ocr_window._empty_count = 0

    # Update trigger cache for image-hash skip decision next cycle
    if results:
        results_text_lower = " ".join(r["text"].lower() for r in results)
        _last_img_had_trigger = any(t in results_text_lower for t in TRIGGER_TEXTS)
    else:
        _last_img_had_trigger = False

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

def ocr_find_dialog_button(ocr_results, win, ocr_confirmed_dialog=False, bg_process_y=None):
    """Find a pressable dialog button via OCR position.
    Returns (button_text, pixel_x, pixel_y) or None.
    
    Strategy:
    1. Primary: find 'Run'/'Trust'/Play icon text on SAME line as 'Reject'
    2. Fallback: if dialog is confirmed via trigger text but no 'Reject' visible
       (Kiro may use icon-only buttons), search bottom 30% for Play/Run text  
    3. Background process: find Play/Run icon near 'Background process' label
    """
    # Find the Y position of "reject" text (dialog indicator)
    reject_y = None
    for r in ocr_results:
        text = r["text"].strip().lower()
        if (text == "reject" or text == "reject all") and r["w"] >= 0.015:
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
    if bottom_texts and bottom_texts != getattr(ocr_find_dialog_button, '_last_bottom', None):
        ocr_find_dialog_button._last_bottom = bottom_texts
        log.info(f"   OCR bottom 50%: {bottom_texts[:15]}")
    
    # Strategy 1: Match button text on same line as "reject"
    if reject_y is not None:
        log.info(f"   OCR found 'Reject' at y={reject_y:.3f}")
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and abs(r["y"] - reject_y) < Y_TOLERANCE:
                    # Strategy 1: Reject on same line = strong signal, no size filter needed
                    px, py = _coords(r)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - same line as Reject (w={r['w']:.3f})")
                    log.info(f"   DIAG: win=({win['x']},{win['y']}) {win['w']}x{win['h']}")
                    log.info(f"   DIAG: norm=({r['x']:.3f},{r['y']:.3f}) size=({r['w']:.3f}x{r['h']:.3f})")
                    log.info(f"   DIAG: relative=({px-win['x']},{py-win['y']}) %=({(px-win['x'])/win['w']*100:.1f}%,{(py-win['y'])/win['h']*100:.1f}%)")
                    return btn_text, px, py
        log.info(f"   No dialog button text found on Reject line (y={reject_y:.3f})")
    else:
        log.info(f"   OCR did NOT find 'Reject' text anywhere")
    
    # Strategy 2: Dialog confirmed by trigger text but no "reject" text visible
    # Kiro may not always show "Reject" as separate text
    # Search bottom 30% for button text, with min-width filter to avoid false positives
    if ocr_confirmed_dialog and reject_y is None:
        BOTTOM_THRESHOLD = 0.7  # Only look in bottom 30%
        MIN_BTN_WIDTH = 0.015  # Filter out tiny false matches
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and r["y"] > BOTTOM_THRESHOLD and r["w"] >= MIN_BTN_WIDTH:
                    px, py = _coords(r)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - bottom area (w={r['w']:.3f})")
                    log.info(f"   DIAG: win=({win['x']},{win['y']}) {win['w']}x{win['h']}")
                    log.info(f"   DIAG: norm=({r['x']:.3f},{r['y']:.3f}) size=({r['w']:.3f}x{r['h']:.3f})")
                    return btn_text, px, py
        log.info(f"   Strategy 2 also failed - no button text in bottom 30% (min_w={MIN_BTN_WIDTH})")
    
    # Strategy 3: Background process Run button
    # Kiro shows 'Background process' blocks with icon buttons (edit, stop, reload, run/play)
    # The ▷/Run button is the RIGHTMOST icon in the header row
    if bg_process_y is not None:
        BG_Y_TOLERANCE = 0.06  # Wider tolerance — icon buttons may be slightly offset

        # 3a: Look for Play/Run icon text near the Background process label line
        bg_btn_texts = ["▶", "►", "▷", "⏵", "run", "play"]
        for btn_text in bg_btn_texts:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and abs(r["y"] - bg_process_y) < BG_Y_TOLERANCE:
                    px, py = _coords(r)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - near Background process (w={r['w']:.3f})")
                    return btn_text, px, py

        # 3b: Look for the rightmost small OCR element near bg_process_y
        rightmost = None
        for r in ocr_results:
            text = r["text"].strip()
            if (len(text) <= 3 and abs(r["y"] - bg_process_y) < BG_Y_TOLERANCE 
                    and r["x"] > 0.8):
                if rightmost is None or r["x"] > rightmost["x"]:
                    rightmost = r
        if rightmost:
            px, py = _coords(rightmost)
            log.info(f"   OCR found rightmost icon '{rightmost['text']}' at ({px}, {py}) - near Background process")
            return "run", px, py

        # 3c: Position-based fallback — icon buttons are NOT text, OCR can't read them
        # Kiro's UI layout: the Run ▷ button is always the rightmost icon at ~97% window width
        # on the same line as "Background process" label
        win_x, win_y = win["x"], win["y"]
        win_w, win_h = win["w"], win["h"]
        # Click at far right (~97% width) on the Background process row
        px = win_x + int(0.97 * win_w)
        py = win_y + int((bg_process_y + 0.008) * win_h)  # Small offset to center vertically on icon
        log.info(f"   Strategy 3c: position-based click at ({px}, {py}) - rightmost icon on BG process row")
        log.info(f"   DIAG: win=({win_x},{win_y}) {win_w}x{win_h}, bg_y={bg_process_y:.3f}")
        return "run", px, py
    
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
    """Click at screen coordinates using CGEvent targeted to Kiro's PID.
    NO focus stealing — click is delivered directly to Kiro even in background.
    Cursor is hidden during the entire sequence — invisible to user.
    """
    # Guard: verify target coordinates are inside Kiro window bounds
    if win:
        wx, wy = win["x"], win["y"]
        ww, wh = win["w"], win["h"]
        if not (wx <= x <= wx + ww and wy <= y <= wy + wh):
            log.warning(f"Click guard: ({x},{y}) is outside Kiro window ({wx},{wy})-({wx+ww},{wy+wh})")
            return False

    display = Quartz.CGMainDisplayID()
    try:
        # Save cursor position
        current_pos = Quartz.NSEvent.mouseLocation()
        screen_height = Quartz.CGDisplayPixelsHigh(display)
        saved_x = current_pos.x
        saved_y = screen_height - current_pos.y

        # HIDE cursor BEFORE any movement
        Quartz.CGDisplayHideCursor(display)

        # Create click events targeted at Kiro's PID (no focus steal)
        point = Quartz.CGPointMake(x, y)
        evt_down = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventLeftMouseDown, point, Quartz.kCGMouseButtonLeft)
        evt_up = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventLeftMouseUp, point, Quartz.kCGMouseButtonLeft)

        # Target specific window/PID — delivers click without bringing to front
        # kCGEventTargetUnixProcessID field index (documented in CGEventTypes.h)
        _CG_EVENT_TARGET_PID = 40
        if kiro_pid:
            Quartz.CGEventSetIntegerValueField(evt_down, _CG_EVENT_TARGET_PID, kiro_pid)
            Quartz.CGEventSetIntegerValueField(evt_up, _CG_EVENT_TARGET_PID, kiro_pid)

        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt_down)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, evt_up)

        # Restore cursor position (still hidden)
        restore_point = Quartz.CGPointMake(saved_x, saved_y)
        restore_evt = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventMouseMoved, restore_point, Quartz.kCGMouseButtonLeft)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, restore_evt)

        time.sleep(0.02)
        return True
    except Exception as e:
        log.warning(f"CGEvent click error: {e}")
        return False
    finally:
        Quartz.CGDisplayShowCursor(display)

# ─── Cooldown ────────────────────────────────────────────────────────

def is_in_cooldown():
    """Time-based only: block clicks for COOLDOWN_SECONDS after any click."""
    now = time.time()
    if now - last_click_time < COOLDOWN_SECONDS:
        return True
    return False

def record_click(cmd_text):
    """Record a click. Returns running total click count."""
    global last_click_cmd, last_click_time, click_count
    click_count += 1
    last_click_cmd = cmd_text
    last_click_time = time.time()
    return click_count

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
    # Block commands that chain multiple operations.
    # IMPORTANT: strip quoted string contents first to avoid false positives.
    # Example: curl -A "Mozilla/5.0 (Macintosh; Intel Mac OS X...)" contains `;`
    # inside a quoted value — that is NOT command chaining.
    # Strategy: replace content of "..." and '...' with placeholder before checking
    # `;`, backtick, and `$(`. Keep `&&` and `||` on full string (safe — they won't
    # appear as values in normal commands).
    cmd_unquoted = re.sub(r'"[^"]*"|\x27[^\x27]*\x27', '""', cmd_lower)

    # && and || are checked on the full string (very unlikely inside quoted values)
    for op in ['&&', '||']:
        if op in cmd_lower:
            return False, f"Command chaining detected: '{op}'"
    # ; backtick $( are checked only OUTSIDE of quoted strings
    for op in [';', '`', '$(']: 
        if op in cmd_unquoted:
            return False, f"Command chaining detected: '{op}'"
    
    # Pipe to shell (| sh, | bash, | zsh) - but allow safe pipes (| grep, | sort)
    DANGEROUS_PIPE_TARGETS = {'sh', 'bash', 'zsh', 'python', 'python3', 'perl',
                               'ruby', 'node', 'eval'}
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

    # DIAGNOSTIC: Log all OCR text periodically (every 10 cycles)
    if not hasattr(monitor_cycle, '_diag_counter'):
        monitor_cycle._diag_counter = 0
    monitor_cycle._diag_counter += 1
    if monitor_cycle._diag_counter % 10 == 1:
        all_texts = [f"'{r['text'].strip()}' y={r['y']:.2f} x={r['x']:.2f} w={r['w']:.3f}" for r in ocr_results]
        log.info(f"   DIAG-OCR: {len(ocr_results)} blocks detected:")
        for t in all_texts[:25]:
            log.info(f"      {t}")

    # Check for trigger text - must be a STANDALONE OCR text block
    # (not part of a longer paragraph like in README/Settings)
    all_text_lower = " ".join(r["text"].lower() for r in ocr_results)
    matched_trigger = None
    trigger_y = None
    for trigger in TRIGGER_TEXTS:
        for r in ocr_results:
            text = r["text"].lower().strip()
            # Trigger must be the dominant text in this OCR block (not a substring in a paragraph)
            # Real dialog: OCR block IS the trigger text or very close to it
            if trigger in text and len(text) < len(trigger) + 20:
                matched_trigger = trigger
                trigger_y = r["y"]
                break
        if matched_trigger:
            break

    # Also check for accept all / reject all (Kiro v0.8+)
    has_accept_all = "accept all" in all_text_lower and "reject all" in all_text_lower

    # Check for 'Background process' block with Run/Play button
    # This is a separate Kiro UI pattern where a background command needs to be started
    bg_process_y = None
    has_bg_process = False
    for r in ocr_results:
        text = r["text"].strip().lower()
        if "background process" in text or (text == "background" and r["w"] > 0.02):
            bg_process_y = r["y"]
            has_bg_process = True
            log.info(f"   Detected 'Background process' at y={bg_process_y:.3f}")
            break

    # OCR visual verification: require "reject" as STANDALONE button text
    # (not substring in paragraph like 'Accept All / Reject All prompts...')
    # Real button: OCR text is exactly "Reject" or "reject" (short, standalone)
    ocr_sees_dialog_buttons = False
    for r in ocr_results:
        text = r["text"].strip().lower()
        if text in ("reject", "reject all", "trust") and len(text) <= 12:
            ocr_sees_dialog_buttons = True
            break

    # Only confirm dialog when BOTH trigger AND standalone dialog buttons are visible
    ocr_confirmed_dialog = bool(matched_trigger) and ocr_sees_dialog_buttons

    if not matched_trigger and not has_accept_all and not has_bg_process:
        stuck_cycles = 0
        return

    # If trigger found but no dialog buttons visible AND no bg process, likely Settings/README/Output panel
    if matched_trigger and not ocr_sees_dialog_buttons and not has_accept_all and not has_bg_process:
        return

    trigger_label = matched_trigger or ("Background process" if has_bg_process else "Accept All/Reject All")
    log.info(f"Detected: '{trigger_label}'")

    # Extract actual command text from OCR (near "Command" label)
    cmd_text = extract_command_text(ocr_results)
    if cmd_text:
        log.info(f"   Command: {cmd_text[:120]}")

    # Cooldown
    if is_in_cooldown():
        return

    # === PRIMARY: Accessibility API (no cursor movement!) ===
    kiro_pid = win.get("pid")

    # Smart analysis: determine if command is safe
    safe, safety_reason = analyze_command_safety(cmd_text, all_text_lower)
    if not safe:
        log.info(f"BLOCKED - {safety_reason}")
        send_notification(f"Blocked: {safety_reason}", play_sound=True)
        log_action("denied", cmd_text or trigger_label, safety_reason)
        record_click(cmd_text)
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
    auto_trust_signal = False   # Set True when frequency threshold crossed
    if cmd_text:
        base_cmd = cmd_text.strip().split()[0] if cmd_text.strip() else None
        if base_cmd:
            base_cmd = base_cmd.split("/")[-1]  # Strip path prefix (/usr/bin/diff → diff)
            if base_cmd.lower() in NEVER_LEARN:
                log.info(f"   '{base_cmd}' is in NEVER_LEARN - will not auto-trust")
            elif cmd_text.strip().startswith("sudo "):
                log.info(f"   sudo command - will not auto-trust")
            else:
                # === Smarter pattern extraction ===
                # Short commands (≤3 tokens, no file paths) → exact pattern (safer)
                # Long commands or path args → wildcard pattern
                cmd_parts = cmd_text.strip().split()
                has_path_arg = any("/" in p and not p.startswith("-") for p in cmd_parts[1:])
                is_short = len(cmd_parts) <= 3
                if is_short and not has_path_arg:
                    # Use exact pattern: "tsc --noEmit" or "make clean"
                    learn_pattern = cmd_text.strip()
                else:
                    # Use wildcard: "eslint *"
                    learn_pattern = f"{base_cmd} *"
                log.info(f"   Learn pattern: '{learn_pattern}' (exact={is_short and not has_path_arg})")

                # === Frequency-based auto-trust ===
                _approval_freq[learn_pattern] = _approval_freq.get(learn_pattern, 0) + 1
                count_seen = _approval_freq[learn_pattern]
                if count_seen >= AUTO_TRUST_THRESHOLD:
                    auto_trust_signal = True
                    log.info(f"   AUTO-TRUST threshold reached ({count_seen}x): '{learn_pattern}'")
                    save_learned()  # Persist updated counts
                elif count_seen % 2 == 0:
                    save_learned()  # Save periodically (every 2 approvals)


    if kiro_pid:
        # === PRIMARY: AX API (handles icon buttons like Play ▶) ===
        # AX API can find buttons by title/description even when visually icon-only
        # This is now PRIMARY because Kiro's newer UI uses Play icon instead of "Run" text
        pressed, btn_title = ax_press_button(kiro_pid, CLICKABLE_BUTTONS, ocr_confirmed_dialog=ocr_confirmed_dialog, win=win)
        if pressed:
            count = record_click(cmd_text)
            log.info(f"AX pressed '{btn_title}' (#{count})")
            send_notification(f"Auto-approved '{btn_title}' (#{count})")
            log_action("auto-approved", cmd_text or btn_title,
                      f"Trigger: {trigger_label} [AX API]", learn_pattern, auto_trust_signal)
            stuck_cycles = 0
            time.sleep(2)  # Wait for Kiro UI to update
            return

        # === SECONDARY: OCR-position click (fallback for web-rendered buttons) ===
        # Dialog buttons may be web-rendered in Electron; find via OCR position near "Reject".
        # Also handles Background process Run buttons (Strategy 3).
        #
        # ⚠️  OFFSCREEN GUARD: Only click when Kiro is on the CURRENT macOS Space.
        # When Kiro is on a different Space (offscreen=True), the pixel coordinates
        # at Kiro's position belong to WHATEVER APP is visible on the current Space.
        # click_at_position() would hit that other app instead of Kiro.
        # AX API above is process-level (cross-Space safe); pixel clicks are not.
        if win.get("offscreen"):
            log.info("   Kiro is on a different Space — OCR-click skipped to prevent misfire on other apps")
            log.info("   AX API method already attempted above; waiting for user to switch to Kiro's Space")
            # Fall through to stuck_cycles so user gets notified after STUCK_THRESHOLD
        else:
            dialog_btn = ocr_find_dialog_button(ocr_results, win, ocr_confirmed_dialog=ocr_confirmed_dialog, bg_process_y=bg_process_y)
            if dialog_btn:
                btn_text, px, py = dialog_btn
                if click_at_position(px, py, kiro_pid=kiro_pid, win=win):
                    count = record_click(cmd_text)
                    source = "BG-process" if has_bg_process else "OCR-click"
                    log.info(f"{source} pressed '{btn_text}' at ({px},{py}) (#{count})")
                    send_notification(f"Auto-approved '{btn_text}' (#{count})")
                    log_action("auto-approved", cmd_text or btn_text,
                              f"Trigger: {trigger_label} [{source}]", learn_pattern, auto_trust_signal)
                    stuck_cycles = 0
                    time.sleep(2)  # Wait for Kiro UI to update
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
    # signal already imported at module level
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

    log.info("Kiro AutoRun v2.1.4 - OCR + CGEvent Click")
    log.info(f"   Works while Kiro is in background")
    log.info(f"   Does NOT move cursor")
    log.info(f"   Does NOT steal focus")
    log.info(f"   Target: {TARGET_APP}")
    log.info(f"   Triggers: {TRIGGER_TEXTS}")
    log.info(f"   Buttons: {CLICKABLE_BUTTONS}")
    log.info(f"   Poll: adaptive {POLL_SLOW}s/{POLL_NORMAL}s/{POLL_FAST}s (idle/normal/trigger)")
    log.info(f"   Banned: {len(BANNED_KEYWORDS)} keywords")
    log.info(f"   Config: {CONFIG_FILE}")
    log.info(f"   Action log: {ACTION_LOG_FILE}")
    log.info("")

    load_learned()   # Restore approval frequency counts from previous session

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
            # Snapshot trigger state before cycle
            kiro_present = bool(find_kiro_window())
            had_trigger_before = _last_img_had_trigger

            monitor_cycle()

            # Adaptive sleep:
            #  - No Kiro window   → POLL_SLOW (5s)  — conserve CPU
            #  - Trigger visible  → POLL_FAST (0.8s) — react immediately
            #  - Normal idle      → POLL_NORMAL (2s)
            if not kiro_present:
                sleep_dur = POLL_SLOW
            elif had_trigger_before or _last_img_had_trigger:
                sleep_dur = POLL_FAST
            else:
                sleep_dur = POLL_NORMAL

        except KeyboardInterrupt:
            break
        except Exception as e:
            log.error(f"Cycle error: {e}")
            sleep_dur = POLL_NORMAL

        time.sleep(sleep_dur)

    log.info("Stopped")  

if __name__ == "__main__":
    main()
