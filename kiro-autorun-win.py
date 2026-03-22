#!/usr/bin/env python3
"""
Kiro AutoRun Windows Backend v2.1.21
Auto-approves Kiro IDE command prompts on Windows.

Architecture:
  1. Win32 API window capture (PrintWindow / BitBlt)
  2. Windows OCR via WinRT (or Tesseract fallback)
  3. UI Automation API to press buttons without cursor movement
  4. Fallback: win32api SendMessage click

User can work on other apps normally while Kiro auto-approves in background.
"""

import subprocess, time, sys, os, json, signal, atexit, logging, re, unicodedata, hashlib
import ctypes
import ctypes.wintypes

VERSION = "2.1.24"

# Enforce physical coordinates for correct window bounds and mouse_event targeting
try:
    ctypes.windll.user32.SetProcessDPIAware()
except Exception:
    pass

# ─── Dependency checks ───────────────────────────────────────────────

def check_deps():
    missing = []
    try:
        import win32gui  # noqa: F401
        import win32con  # noqa: F401
        import win32api  # noqa: F401
        import win32ui   # noqa: F401
        import win32process  # noqa: F401
    except ImportError:
        missing.append("pywin32")
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        missing.append("Pillow")
    if missing:
        print(f"Missing dependencies: {', '.join(missing)}")
        print(f"Run: pip install {' '.join(missing)}")
        sys.exit(1)

check_deps()

import win32gui
import win32con
import win32api
import win32ui
import win32process
from PIL import Image

# ─── Configuration ───────────────────────────────────────────────────

CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".kiro-autorun")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
ACTION_LOG_FILE = os.path.join(CONFIG_DIR, "actions.log")
BACKEND_LOG = os.path.join(CONFIG_DIR, "backend.log")
LEARNED_FILE = os.path.join(CONFIG_DIR, "learned.json")
PID_FILE = os.path.join(CONFIG_DIR, "backend.pid")
HEARTBEAT_FILE = os.path.join(CONFIG_DIR, "heartbeat")

POLL_INTERVAL = 2
TARGET_APP = "Kiro"
TRIGGER_TEXTS = ["waiting on your input"]
SHOW_NOTIFICATION = False
NOTIFICATION_SOUND = True
STUCK_RECOVERY_ENABLED = True

CLICKABLE_BUTTONS = ["Run", "Accept All", "Reject All", "Trust", "Play", "Accept"]
DIALOG_BUTTON_TEXTS = ["run", "trust", "▶", "►", "▷", "play", "⏵", "accept all", "accept"]
PRESSABLE_BUTTONS = {"accept all", "accept", "trust", "run", "play", "▶", "►", "▷", "⏵"}

COOLDOWN_SECONDS = 5
POLL_SLOW = 3.0
POLL_NORMAL = 1.0
POLL_FAST = 0.2
AUTO_TRUST_THRESHOLD = 5
MIN_STUCK_FOR_MOUSE_FALLBACK = 1  # Speed up fallback: wait only 1 cycle before trying OCR

BANNED_KEYWORDS = [
    "rm -rf /", "rm -rf ~", "rm -rf /*", "rm -rf .",
    "rm -r /", "rm -r ~", "sudo rm", "sudo chmod", "sudo chown", "sudo kill",
    "chmod 777", "chmod -R 777", "> /dev/", "dd if=", "mkfs.",
    "curl | sh", "curl | bash", "wget | sh", "wget | bash",
    "git push --force", "git push -f", "git reset --hard",
    "drop table", "drop database", "truncate table", "delete from",
    "shutdown", "reboot", "halt", "kill -9", "killall",
    ":(){:|:&};:",
    # Windows-specific
    "format c:", "del /f /s", "rd /s /q c:", "rmdir /s /q c:",
    "reg delete", "reg add",
    "powershell -enc", "powershell -encodedcommand",
    "cmd /c del", "cmd /c rd",
    "net user", "net localgroup",
    "schtasks /create", "schtasks /delete",
]

INHERENTLY_DANGEROUS = {
    "dd", "mkfs", "fdisk", "parted", "shred",
    "shutdown", "reboot", "halt", "poweroff", "init",
    "killall", "pkill",
    "format", "diskpart",
    "nc", "ncat", "socat",
    "reg", "schtasks",
}

DANGEROUS_PATTERNS = [
    "| sh", "| bash", "| zsh", "| powershell", "| cmd",
    "> /dev/", "push --force", "push -f", "reset --hard",
    "-rf /", "-rf ~", "-rf /*", "-rf .",
    "chmod 777", "chmod -R 777",
    "drop table", "drop database",
    ":(){:|:&};:",
    "/s /q c:", "del /f /s /q",
]

# ─── Logging ─────────────────────────────────────────────────────────

os.makedirs(CONFIG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(BACKEND_LOG, mode="a", encoding="utf-8"),
    ],
)
log = logging.getLogger("kiro-autorun-win")

click_count = 0
running = True
last_click_cmd = None
last_click_time = 0
_stuck_cycles = {}     # per-window: {hwnd: int}
STUCK_THRESHOLD = 15
_last_img_hash = {}     # per-window: {hwnd: hash_str}
_last_img_had_trigger = {}  # per-window: {hwnd: bool}
_consecutive_errors = 0
MAX_CONSECUTIVE_ERRORS = 50  # auto-exit after this many to allow extension to restart fresh
ERROR_BACKOFF_THRESHOLD = 10  # after this many errors, log traceback + sleep longer

try:
    from collections import Counter
    _approval_freq = Counter()
except ImportError:
    _approval_freq = {}

# ─── Config ──────────────────────────────────────────────────────────

def load_config():
    global POLL_INTERVAL, TARGET_APP, TRIGGER_TEXTS, BANNED_KEYWORDS
    global SHOW_NOTIFICATION, NOTIFICATION_SOUND, STUCK_RECOVERY_ENABLED

    if not os.path.exists(CONFIG_FILE):
        return
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            cfg = json.load(f)
        POLL_INTERVAL = cfg.get("pollInterval", POLL_INTERVAL)
        SHOW_NOTIFICATION = cfg.get("showNotification", SHOW_NOTIFICATION)
        NOTIFICATION_SOUND = cfg.get("notificationSound", NOTIFICATION_SOUND)
        STUCK_RECOVERY_ENABLED = cfg.get("stuckRecoveryEnabled", STUCK_RECOVERY_ENABLED)
        raw_app = cfg.get("targetApp", TARGET_APP)
        safe_app = re.sub(r'[^a-zA-Z0-9 .\-]', '', raw_app)
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
                    "format c:", "del /f /s", "rd /s /q c:",
                ]
                BANNED_KEYWORDS = list(set(default_bk + custom))
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"Config load error: {e}")

# ─── Learned Commands ────────────────────────────────────────────────

def load_learned():
    global _approval_freq
    if not os.path.exists(LEARNED_FILE):
        return
    try:
        with open(LEARNED_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _approval_freq = Counter(data)
            log.info(f"   Loaded {len(_approval_freq)} learned patterns")
    except (json.JSONDecodeError, OSError) as e:
        log.warning(f"learned.json load error: {e}")

def save_learned():
    try:
        os.makedirs(os.path.dirname(LEARNED_FILE), exist_ok=True)
        with open(LEARNED_FILE, "w", encoding="utf-8") as f:
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
        entry["auto_trust"] = True
    try:
        os.makedirs(os.path.dirname(ACTION_LOG_FILE), exist_ok=True)
        with open(ACTION_LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
        try:
            with open(ACTION_LOG_FILE, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > 1000:
                kept = lines[-500:]
                with open(ACTION_LOG_FILE, "w", encoding="utf-8") as f:
                    f.writelines(kept)
        except OSError:
            pass
    except OSError as e:
        log.warning(f"Action log write error: {e}")

# ─── Signal Handling ─────────────────────────────────────────────────

def signal_handler(signum, frame):
    global running
    log.info(f"Received signal {signum}, shutting down...")
    running = False

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

# ─── Window Finding (Win32) ──────────────────────────────────────────

def _get_dwm_rect(hwnd):
    """Get accurate window rect using DwmGetWindowAttribute (Windows 10+).
    Falls back to GetWindowRect if DWM is unavailable.
    GetWindowRect includes invisible DWM borders (7px each side on Win10+),
    which causes incorrect coordinate calculations."""
    try:
        rect = ctypes.wintypes.RECT()
        # DWMWA_EXTENDED_FRAME_BOUNDS = 9
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect)
        )
        if hr == 0:  # S_OK
            return rect.left, rect.top, rect.right, rect.bottom
    except Exception:
        pass
    return win32gui.GetWindowRect(hwnd)

def find_kiro_windows():
    """Find ALL Kiro windows. Returns list of dicts with hwnd, x, y, w, h, pid.
    Prioritizes exe-name matches (kiro.exe, electron.exe) over title matches."""
    target_exes = {TARGET_APP.lower(), "electron", "kiro"}
    title_suffix = f"- {TARGET_APP}"
    windows = []

    def enum_callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            handle = win32api.OpenProcess(0x0400 | 0x0010, False, pid)
            exe = win32process.GetModuleFileNameEx(handle, 0)
            win32api.CloseHandle(handle)
            exe_name = os.path.basename(exe).lower().replace(".exe", "")
        except Exception:
            exe_name = ""

        is_exe_match = exe_name in target_exes
        is_title_match = title.endswith(title_suffix)

        if not is_exe_match and not is_title_match:
            return True

        x, y, x2, y2 = _get_dwm_rect(hwnd)
        w, h = x2 - x, y2 - y
        if w <= 100 or h <= 100:
            return True

        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        windows.append({
            "hwnd": hwnd,
            "x": x, "y": y, "w": w, "h": h,
            "pid": pid,
            "title": title,
            "exe_match": is_exe_match,
        })
        return True

    try:
        win32gui.EnumWindows(enum_callback, None)
    except Exception as e:
        log.warning(f"EnumWindows error: {e}")

    # Sort: exe matches first, then by area descending
    windows.sort(key=lambda w: (-int(w["exe_match"]), -(w["w"] * w["h"])))
    return windows

# ─── Window Capture (Win32) ──────────────────────────────────────────

def capture_window(win):
    """Capture Kiro window as PIL Image using PrintWindow (works in background)."""
    hwnd = win["hwnd"]
    w, h = win["w"], win["h"]
    if w <= 0 or h <= 0:
        return None

    try:
        hwndDC = win32gui.GetWindowDC(hwnd)
        mfcDC = win32ui.CreateDCFromHandle(hwndDC)
        saveDC = mfcDC.CreateCompatibleDC()
        saveBitMap = win32ui.CreateBitmap()
        saveBitMap.CreateCompatibleBitmap(mfcDC, w, h)
        old_bmp = saveDC.SelectObject(saveBitMap)

        # PrintWindow with PW_RENDERFULLCONTENT (flag 2) for Electron/DWM content
        ctypes.windll.user32.PrintWindow(hwnd, saveDC.GetSafeHdc(), 2)

        bmpinfo = saveBitMap.GetInfo()
        bmpstr = saveBitMap.GetBitmapBits(True)

        img = Image.frombuffer(
            'RGB',
            (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
            bmpstr, 'raw', 'BGRX', 0, 1
        )

        saveDC.SelectObject(old_bmp)
        saveDC.DeleteDC()
        mfcDC.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwndDC)
        win32gui.DeleteObject(saveBitMap.GetHandle())

        return img
    except Exception as e:
        log.warning(f"Window capture error: {e}")
        return None

# ─── OCR ─────────────────────────────────────────────────────────────

_ocr_engine = None

def _init_ocr():
    """Initialize OCR engine. Try WinRT OCR first, then Tesseract."""
    global _ocr_engine

    # Try WinRT OCR (built into Windows 10+)
    try:
        import asyncio
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.globalization import Language
        engine = OcrEngine.try_create_from_language(Language("en-US"))
        if engine:
            _ocr_engine = ("winrt", engine)
            log.info("   OCR: WinRT (built-in Windows OCR)")
            return
    except Exception:
        pass

    # Try winocr wrapper
    try:
        import winocr  # noqa: F401
        _ocr_engine = ("winocr", None)
        log.info("   OCR: winocr wrapper")
        return
    except ImportError:
        pass

    # Fallback: Tesseract
    try:
        import pytesseract  # noqa: F401
        _ocr_engine = ("tesseract", None)
        log.info("   OCR: Tesseract")
        return
    except ImportError:
        pass

    log.error("No OCR engine available! Install one of: winocr, pytesseract")
    log.error("   pip install winocr   (recommended, uses built-in Windows OCR)")
    log.error("   pip install pytesseract   (requires Tesseract binary)")
    sys.exit(1)

def ocr_image(img):
    """Run OCR on a PIL Image. Returns list of {text, x, y, w, h} (normalized coords)."""
    if _ocr_engine is None:
        _init_ocr()

    engine_type = _ocr_engine[0]
    img_w, img_h = img.size

    if engine_type == "winrt":
        return _ocr_winrt(img, img_w, img_h)
    elif engine_type == "winocr":
        return _ocr_winocr(img, img_w, img_h)
    elif engine_type == "tesseract":
        return _ocr_tesseract(img, img_w, img_h)
    return []

def _ocr_winrt(img, img_w, img_h):
    """OCR using WinRT OcrEngine directly."""
    import asyncio
    from winrt.windows.graphics.imaging import SoftwareBitmap, BitmapPixelFormat, BitmapAlphaMode
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.globalization import Language

    results = []
    try:
        # Convert PIL to BGRA bytes
        rgba = img.convert("RGBA")
        pixels = rgba.tobytes()
        # RGBA -> BGRA
        bgra = bytearray(len(pixels))
        for i in range(0, len(pixels), 4):
            bgra[i] = pixels[i + 2]      # B
            bgra[i + 1] = pixels[i + 1]  # G
            bgra[i + 2] = pixels[i]      # R
            bgra[i + 3] = pixels[i + 3]  # A

        # Create SoftwareBitmap via constructor + copy_from_buffer
        # (create_copy_from_buffer static method has compatibility issues
        #  with newer winrt-python versions — "Invalid parameter count")
        bitmap = SoftwareBitmap(BitmapPixelFormat.BGRA8, img_w, img_h, BitmapAlphaMode.PREMULTIPLIED)
        bitmap.copy_from_buffer(bytes(bgra))

        engine = OcrEngine.try_create_from_language(Language("en-US"))
        if not engine:
            return []

        loop = asyncio.new_event_loop()
        ocr_result = loop.run_until_complete(engine.recognize_async(bitmap))
        loop.close()

        for line in ocr_result.lines:
            for word in line.words:
                rect = word.bounding_rect
                results.append({
                    "text": word.text,
                    "x": rect.x / img_w,
                    "y": rect.y / img_h,
                    "w": rect.width / img_w,
                    "h": rect.height / img_h,
                })
    except Exception as e:
        log.warning(f"WinRT OCR error: {e}")
    return results

def _ocr_winocr(img, img_w, img_h):
    """OCR using winocr package."""
    import winocr
    import asyncio
    results = []
    try:
        loop = asyncio.new_event_loop()
        ocr_result = loop.run_until_complete(winocr.recognize_pil(img, lang="en"))
        loop.close()
        for line in ocr_result.get("lines", []):
            for word in line.get("words", []):
                bbox = word.get("bounding_rect", {})
                results.append({
                    "text": word.get("text", ""),
                    "x": bbox.get("x", 0) / img_w,
                    "y": bbox.get("y", 0) / img_h,
                    "w": bbox.get("width", 0) / img_w,
                    "h": bbox.get("height", 0) / img_h,
                })
    except Exception as e:
        log.warning(f"winocr error: {e}")
    return results

def _ocr_tesseract(img, img_w, img_h):
    """OCR using pytesseract."""
    import pytesseract
    results = []
    try:
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
        for i in range(len(data["text"])):
            text = data["text"][i].strip()
            if not text:
                continue
            results.append({
                "text": text,
                "x": data["left"][i] / img_w,
                "y": data["top"][i] / img_h,
                "w": data["width"][i] / img_w,
                "h": data["height"][i] / img_h,
            })
    except Exception as e:
        log.warning(f"Tesseract OCR error: {e}")
    return results

# ─── OCR Window (with caching) ──────────────────────────────────────

def ocr_window(win):
    """Capture and OCR the Kiro window. Returns (img, list of OCR results)."""
    global _last_img_hash, _last_img_had_trigger
    hwnd = win["hwnd"]

    img = capture_window(win)
    if not img:
        return None, []

    # Crop bottom 60% (trigger text and buttons are at the bottom)
    img_w, img_h = img.size
    crop_top = int(img_h * 0.4)
    img_cropped = img.crop((0, crop_top, img_w, img_h))

    # Image hash for change detection (per-window)
    try:
        img_hash = hashlib.md5(img_cropped.tobytes()).hexdigest()
        prev_hash = _last_img_hash.get(hwnd)
        prev_had_trigger = _last_img_had_trigger.get(hwnd, False)
        if img_hash == prev_hash and not prev_had_trigger:
            return img, []
        _last_img_hash[hwnd] = img_hash
    except Exception:
        pass

    results = ocr_image(img_cropped)

    # Adjust Y coordinates back to full-window normalized coords
    crop_ratio = 0.4
    for r in results:
        r["y"] = crop_ratio + r["y"] * (1.0 - crop_ratio)
        r["h"] = r["h"] * (1.0 - crop_ratio)

    # Update trigger cache (per-window)
    if results:
        results_text_lower = " ".join(r["text"].lower() for r in results)
        _last_img_had_trigger[hwnd] = any(t in results_text_lower for t in TRIGGER_TEXTS)
    else:
        _last_img_had_trigger[hwnd] = False

    return img, results

# ─── UI Automation - Press Buttons ───────────────────────────────────

_uia_module = None  # cached UIAutomationClient module

def _get_uia_module():
    """Get the UIAutomationClient comtypes module, generating typelib if needed."""
    global _uia_module
    if _uia_module is not None:
        return _uia_module
    from comtypes import client as com_client
    # Generate typelib wrapper for UIAutomationCore.dll
    com_client.GetModule('UIAutomationCore.dll')
    import comtypes.gen.UIAutomationClient as UIA
    _uia_module = UIA
    return UIA

def uia_press_button(hwnd, button_titles):
    """Find and press a button using UI Automation API.
    Returns (pressed: bool, button_title: str or None).
    Uses partial/case-insensitive matching to handle Electron accessibility labels."""
    try:
        import comtypes  # noqa: F401
        from comtypes import client as com_client
        UIA = _get_uia_module()

        uia = com_client.CreateObject(
            "{ff48dba4-60ef-4201-aa87-54103eef594e}",
            interface=UIA.IUIAutomation
        )
        element = uia.ElementFromHandle(hwnd)
        if not element:
            return False, None

        # Search for buttons
        condition = uia.CreatePropertyCondition(
            UIA.UIA_ControlTypePropertyId,
            UIA.UIA_ButtonControlTypeId
        )
        buttons = element.FindAll(UIA.TreeScope_Descendants, condition)
        if not buttons:
            return False, None

        # Debug: log all button names once per cycle to diagnose matching issues
        all_btn_names = []
        for i in range(buttons.Length):
            btn = buttons.GetElement(i)
            name = (btn.CurrentName or "").strip()
            if name:
                all_btn_names.append(name)
        if all_btn_names:
            log.info(f"   UIA buttons: {all_btn_names[:20]}")

        # Collect all matching buttons with their priority
        # Use partial matching: button name contains target OR target contains button name
        matched = []  # list of (priority_index, btn_element, target_title)
        
        # We need the window rectangle to filter by relative position
        import ctypes
        from ctypes import wintypes
        rect = wintypes.RECT()
        ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
        win_h = max(1, rect.bottom - rect.top)
        
        for i in range(buttons.Length):
            btn = buttons.GetElement(i)
            name = btn.CurrentName or ""
            name_lower = name.strip().lower()
            if not name_lower:
                continue
                
            # Anti-false-positive: exclude buttons at the very top of VS Code (e.g., Debug "Play" button)
            try:
                btn_rect = btn.CurrentBoundingRectangle
                if btn_rect.bottom > 0:
                    btn_y_center = (btn_rect.top + btn_rect.bottom) / 2
                    rel_y = (btn_y_center - rect.top) / win_h
                    if rel_y < 0.15:
                        continue  # Skip buttons in the top 15% of the window (toolbars)
            except Exception:
                pass

            for priority_idx, target in enumerate(button_titles):
                target_lower = target.lower()
                import re
                name_clean = re.sub(r'[^a-z0-9\s]', '', name_lower).strip()
                
                # Exact match only to prevent clicking unrelated VS Code buttons (like "Trust Workspace")
                is_match = (target_lower == name_lower or target_lower == name_clean)
                if is_match:
                    if name_lower not in PRESSABLE_BUTTONS and target_lower not in PRESSABLE_BUTTONS:
                        continue
                    matched.append((priority_idx, btn, target))

        # Press highest priority button (lowest index in button_titles)
        matched.sort(key=lambda x: x[0])
        for _, btn, target in matched:
            try:
                pattern = btn.GetCurrentPattern(UIA.UIA_InvokePatternId)
                if pattern:
                    invoke = pattern.QueryInterface(UIA.IUIAutomationInvokePattern)
                    invoke.Invoke()
                    return True, target
            except Exception:
                pass

        return False, None
    except ImportError:
        log.warning("comtypes not installed — UI Automation unavailable")
        log.warning("   pip install comtypes")
        return False, None
    except Exception as e:
        log.warning(f"UI Automation error: {e}")
        return False, None

def _find_chrome_widget(hwnd):
    """Find the Chrome_RenderWidgetHostHWND child window inside an Electron app."""
    result = []
    def enum_child(child_hwnd, _):
        try:
            class_name = win32gui.GetClassName(child_hwnd)
            if "Chrome" in class_name and "Widget" in class_name:
                result.append(child_hwnd)
        except Exception:
            pass
        return True
    try:
        win32gui.EnumChildWindows(hwnd, enum_child, None)
    except Exception:
        pass
    return result[0] if result else None

def click_at_position(x, y, win=None, skip_postmessage=False):
    """Click at screen coordinates. Tries PostMessage first (no cursor steal),
    then falls back to mouse_event with save/restore of cursor + foreground window."""
    if not win:
        return False

    hwnd = win["hwnd"]
    client_x = x - win["x"]
    client_y = y - win["y"]

    if client_x < 0 or client_y < 0 or client_x > win["w"] or client_y > win["h"]:
        log.warning(f"Click guard: ({x},{y}) outside window bounds")
        return False

    WM_LBUTTONDOWN = 0x0201
    WM_LBUTTONUP = 0x0202
    MK_LBUTTON = 0x0001
    lparam = (client_y << 16) | (client_x & 0xFFFF)

    # Strategy 1: PostMessage to Chrome render widget (no cursor steal)
    if not skip_postmessage:
        target_hwnd = _find_chrome_widget(hwnd) or hwnd
        try:
            win32gui.PostMessage(target_hwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam)
            time.sleep(0.08)
            win32gui.PostMessage(target_hwnd, WM_LBUTTONUP, 0, lparam)
            widget_info = "Chrome widget" if target_hwnd != hwnd else "top-level"
            log.info(f"   PostMessage click at ({client_x},{client_y}) -> {widget_info}")
            return True
        except Exception as e:
            log.warning(f"PostMessage click failed: {e}, trying mouse_event...")

    # Strategy 2: mouse_event — actually works for Electron/Chromium
    # Uses SendInput for a tighter atomic click with minimal cursor flicker.
    # Cursor + foreground window are saved and restored immediately.
    try:
        old_foreground = win32gui.GetForegroundWindow()

        old_cursor = win32gui.GetCursorPos()

        # Bring Kiro to front briefly
        try:
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.03)
        except Exception:
            pass

        sm_xvs = ctypes.windll.user32.GetSystemMetrics(76)
        sm_yvs = ctypes.windll.user32.GetSystemMetrics(77)
        sm_cxvs = ctypes.windll.user32.GetSystemMetrics(78)
        sm_cyvs = ctypes.windll.user32.GetSystemMetrics(79)

        abs_x = int((x - sm_xvs) * 65535.0 / sm_cxvs)
        abs_y = int((y - sm_yvs) * 65535.0 / sm_cyvs)

        # Use SendInput for tight atomic move+click (less cursor flicker than mouse_event)
        class MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                        ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                        ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]

        class INPUT(ctypes.Structure):
            class _U(ctypes.Union):
                _fields_ = [("mi", MOUSEINPUT)]
            _fields_ = [("type", ctypes.c_ulong), ("u", _U)]

        MOUSEEVENTF_MOVE = 0x0001
        MOUSEEVENTF_LEFTDOWN = 0x0002
        MOUSEEVENTF_LEFTUP = 0x0004
        MOUSEEVENTF_ABSOLUTE = 0x8000
        MOUSEEVENTF_VIRTUALDESK = 0x4000
        INPUT_MOUSE = 0

        flags_base = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK

        # Build 3 inputs: move, leftdown, leftup — sent atomically
        inputs = (INPUT * 3)()
        for i, extra_flag in enumerate([MOUSEEVENTF_MOVE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP]):
            inputs[i].type = INPUT_MOUSE
            inputs[i].u.mi.dx = abs_x
            inputs[i].u.mi.dy = abs_y
            inputs[i].u.mi.dwFlags = flags_base | extra_flag

        ctypes.windll.user32.SendInput(3, ctypes.byref(inputs), ctypes.sizeof(INPUT))

        # Restore cursor + foreground immediately (no sleep between)
        try:
            win32api.SetCursorPos(old_cursor)
        except Exception:
            pass
        try:
            if old_foreground and old_foreground != hwnd:
                win32gui.SetForegroundWindow(old_foreground)
        except Exception:
            pass

        log.info(f"   SendInput click at ({x},{y}), restored cursor+foreground")
        return True
    except Exception as e:
        log.warning(f"SendInput click error: {e}")
        return False

# ─── Notification (Windows Toast) ────────────────────────────────────

def send_notification(msg, play_sound=False):
    if NOTIFICATION_SOUND and play_sound:
        try:
            import winsound
            winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
        except Exception:
            pass
    if not SHOW_NOTIFICATION:
        return
    try:
        from ctypes import windll
        # Simple balloon notification via PowerShell
        safe_msg = msg.replace("'", "").replace('"', '')[:200]
        subprocess.run(
            ["powershell", "-Command",
             f"[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; "
             f"$n = New-Object System.Windows.Forms.NotifyIcon; "
             f"$n.Icon = [System.Drawing.SystemIcons]::Information; "
             f"$n.Visible = $true; "
             f"$n.ShowBalloonTip(3000, 'Kiro AutoRun', '{safe_msg}', 'Info'); "
             f"Start-Sleep -Seconds 3; $n.Dispose()"],
            timeout=5, capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
    except Exception:
        pass

# ─── Command Safety Analysis (shared with macOS) ────────────────────

NEVER_LEARN = {
    "rm", "rmdir", "chmod", "chown", "chgrp",
    "curl", "wget", "git", "kill", "pkill",
    "dd", "mkfs", "fdisk", "sudo",
    "ssh", "scp", "rsync",
    "docker", "kubectl",
    "pip", "pip3", "npm", "npx",
    "eval", "exec", "source", ".",
    # Windows-specific
    "del", "rd", "rmdir", "reg", "schtasks",
    "format", "diskpart", "net",
}

def extract_command_text(ocr_results):
    """Extract the actual command text from OCR results."""
    cmd_headers = []
    for r in ocr_results:
        text = r["text"].strip().lower()
        if text == "command" or text.startswith("command"):
            cmd_headers.append(r)

    if not cmd_headers:
        return None

    last_header = max(cmd_headers, key=lambda r: r["y"])
    cmd_header_y = last_header["y"]

    candidates = []
    for r in ocr_results:
        text = r["text"].strip()
        if len(text) < 3:
            continue
        if text.lower() in ("command", "reject", "trust", "run", "accept", "accept all",
                            "reject all", "waiting on your input", "cancel", "continue",
                            "checkpoint", "restore", "kiro"):
            continue
        y_diff = r["y"] - cmd_header_y
        if -0.01 <= y_diff < 0.05:
            candidates.append((y_diff, r["x"], text))

    if candidates:
        candidates.sort(key=lambda c: (c[0], c[1]))
        return candidates[0][2]

    # Fallback: look for shell-like commands
    for r in ocr_results:
        text = r["text"].strip()
        if len(text) > 5:
            lower = text.lower()
            if any(lower.startswith(p) for p in [
                "npm ", "node ", "python", "git ", "cp ", "mv ", "rm ", "mkdir ",
                "diff ", "cat ", "ls ", "cd ", "echo ", "curl ", "wget ", "pip ",
                "cargo ", "go ", "make ", "docker ", "tar ", "find ",
                "grep ", "sed ", "awk ", "sort ", "touch ", "head ", "tail ",
                "dir ", "type ", "copy ", "move ", "del ", "cls ",
                "powershell ", "cmd ", "dotnet ", "msbuild ",
            ]):
                return text
    return None

def analyze_command_safety(cmd_text, all_text_lower):
    """Analyze if a command is safe to auto-approve."""
    if not cmd_text:
        return True, "No command text detected"

    cmd_normalized = unicodedata.normalize("NFKD", cmd_text)
    cmd_normalized = ''.join(c for c in cmd_normalized if unicodedata.category(c) != 'Cf')
    cmd_lower = cmd_normalized.lower().strip()

    # Command chaining detection
    cmd_unquoted = re.sub(r'"[^"]*"|\x27[^\x27]*\x27', '""', cmd_lower)
    for op in ['&&', '||']:
        if op in cmd_lower:
            return False, f"Command chaining detected: '{op}'"
    for op in [';', '`', '$(']:
        if op in cmd_unquoted:
            return False, f"Command chaining detected: '{op}'"

    # Pipe to shell
    DANGEROUS_PIPE_TARGETS = {'sh', 'bash', 'zsh', 'python', 'python3', 'perl',
                               'ruby', 'node', 'eval', 'powershell', 'cmd'}
    pipe_matches = re.findall(r'\|\s*(\S+)', cmd_lower)
    for target in pipe_matches:
        target_base = target.split('/')[-1].split('\\')[-1]
        if target_base in DANGEROUS_PIPE_TARGETS:
            return False, f"Pipe to shell: | {target_base}"

    parts = cmd_lower.split()
    base_cmd = parts[0].split("/")[-1].split("\\")[-1] if parts else ""
    # Strip .exe/.cmd/.bat extension on Windows
    for ext in (".exe", ".cmd", ".bat", ".ps1"):
        if base_cmd.endswith(ext):
            base_cmd = base_cmd[:-len(ext)]

    # Sudo / runas detection
    sudo_variants = {'sudo', 'runas', 'gsudo'}
    for i, part in enumerate(parts):
        part_base = part.split('/')[-1].split('\\')[-1]
        for ext in (".exe", ".cmd"):
            if part_base.endswith(ext):
                part_base = part_base[:-len(ext)]
        if part_base in sudo_variants:
            actual_cmd = None
            for j in range(i + 1, len(parts)):
                if not parts[j].startswith('-') and not parts[j].startswith('/'):
                    actual_cmd = parts[j].split('/')[-1].split('\\')[-1]
                    break
            if actual_cmd and actual_cmd in INHERENTLY_DANGEROUS:
                return False, f"Dangerous: {part_base} {actual_cmd}"

    actual_base = base_cmd
    if base_cmd == 'env':
        for part in parts[1:]:
            if '=' not in part and not part.startswith('-'):
                actual_base = part.split('/')[-1].split('\\')[-1]
                break

    if actual_base in INHERENTLY_DANGEROUS:
        return False, f"Inherently dangerous command: {actual_base}"

    for pattern in DANGEROUS_PATTERNS:
        if pattern.lower() in cmd_lower:
            return False, f"Dangerous pattern: {pattern}"

    for keyword in BANNED_KEYWORDS:
        if keyword.lower() in cmd_lower:
            return False, f"Banned keyword: {keyword}"

    return True, f"Safe command: {base_cmd}"

# ─── OCR Button Finding ─────────────────────────────────────────────

def ocr_find_dialog_button(ocr_results, win, ocr_confirmed_dialog=False, bg_process_y=None, use_position_fallback=False):
    """Find a pressable dialog button via OCR position."""
    reject_y = None
    import re
    def normalize_text(t):
        return re.sub(r'[^a-z0-9\s]', '', t).strip()

    for r in ocr_results:
        text = r["text"].strip().lower()
        if ("reject" in text or "reject all" in text) and r["w"] >= 0.015:
            reject_y = r["y"]
            break

    Y_TOLERANCE = 0.08  # Increased from 0.03. 'Reject' has a descender 'j', dropping its Y center relative to 'Accept'

    def is_btn_match(btn, t):
        if t == btn: return True
        if normalize_text(t) == btn: return True
        if "reject" in t and "accept" in t and btn in ["accept", "accept all"]: return True
        return False

    def _coords_for_text(r, btn_text):
        win_x, win_y = win["x"], win["y"]
        win_w, win_h = win["w"], win["h"]
        t = r["text"].strip().lower()

        # Handle merged boxes (e.g., "Reject Accept")
        if "reject" in t and "accept" in t:
            if btn_text.startswith("accept"):
                rel_x = r["x"] + r["w"] * 0.75  # right side
            else:
                rel_x = r["x"] + r["w"] * 0.25  # left side
        else:
            rel_x = r["x"] + r["w"] / 2

        px = win_x + int(rel_x * win_w)
        py = win_y + int((r["y"] + r["h"] / 2) * win_h)
        return px, py

    def _coords(r):
        return _coords_for_text(r, "")

    # Strategy 1: Match button text on same line as "reject"
    if reject_y is not None:
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if is_btn_match(btn_text, text) and abs(r["y"] - reject_y) < Y_TOLERANCE:
                    px, py = _coords_for_text(r, btn_text)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - same line as Reject")
                    return btn_text, px, py

        # Strategy 1b: Position-based - Run button is at right side of dialog, same Y as Reject
        if use_position_fallback:
            win_x, win_y = win["x"], win["y"]
            win_w, win_h = win["w"], win["h"]
            px = win_x + int(0.90 * win_w)  # Run button area, avoid right edge
            py = win_y + int((reject_y + 0.008) * win_h)
            # Bounds check: ensure click is within window
            px = max(win_x + 10, min(px, win_x + win_w - 30))
            py = max(win_y + 10, min(py, win_y + win_h - 30))
            log.info(f"   Strategy 1b: Run near Reject at ({px}, {py})")
            return "run", px, py

    # Strategy 2: Dialog confirmed but no "reject" visible
    if ocr_confirmed_dialog and reject_y is None:
        BOTTOM_THRESHOLD = 0.60
        MIN_BTN_WIDTH = 0.015
        for btn_text in DIALOG_BUTTON_TEXTS:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if is_btn_match(btn_text, text) and r["y"] > BOTTOM_THRESHOLD and r["w"] >= MIN_BTN_WIDTH:
                    px, py = _coords_for_text(r, btn_text)
                    log.info(f"   OCR found '{btn_text}' at ({px}, {py}) - bottom area")
                    return btn_text, px, py

    # Strategy 3: Background process Run button
    if bg_process_y is not None:
        BG_Y_TOLERANCE = 0.06
        bg_btn_texts = ["▶", "►", "▷", "⏵", "run", "play"]
        for btn_text in bg_btn_texts:
            for r in ocr_results:
                text = r["text"].strip().lower()
                if text == btn_text and abs(r["y"] - bg_process_y) < BG_Y_TOLERANCE:
                    px, py = _coords(r)
                    return btn_text, px, py

        # Strategy 3c: Position-based click near detected "background process" text
        if use_position_fallback:
            win_x, win_y = win["x"], win["y"]
            win_w, win_h = win["w"], win["h"]
            px = win_x + int(0.90 * win_w)  # Run button area, avoid right edge
            py = win_y + int((bg_process_y + 0.008) * win_h)
            # Bounds check
            px = max(win_x + 10, min(px, win_x + win_w - 30))
            py = max(win_y + 10, min(py, win_y + win_h - 30))
            log.info(f"   Strategy 3c: Run near BG-process at ({px}, {py})")
            return "run", px, py

    return None

# ─── Pure CV Fallback ────────────────────────────────────────────────

def cv_find_bg_process_run_button(img):
    """
    Scans the bottom 60% of the screenshot for the specific Kiro 'Background process'
    action bar signature: a small red 'x' icon followed by a green '▶' or '✓' icon 
    ~15-45 pixels to its right.
    Returns (gx, gy) of the green Run button center, or None.
    """
    if not img: return None
    
    width, height = img.size
    pixels = img.load()
    start_y = int(height * 0.4)
    end_y = int(height * 0.95)  # avoid the AutoRun ON green text at the very bottom
    
    # Fast scan for green candidates representing the generic Play button
    green_candidates = []
    # Scan every 3 pixels to find solid blocks
    for y in range(start_y, end_y, 3):
        for x in range(int(width * 0.4), width, 3):
            r, g, b = pixels[x, y]
            # Strict green constraint for the specific Kiro play icon
            if g > r + 30 and g > b + 30 and g > 100:
                green_candidates.append((x, y))

    if not green_candidates:
        return None

    # Group into clusters
    clusters = []
    for x, y in green_candidates:
        added = False
        for c in clusters:
            cx, cy, count, minx, maxx, miny, maxy = c
            if abs(x - cx) < 25 and abs(y - cy) < 25:
                nc = count + 1
                c[0] = (cx * count + x) / nc
                c[1] = (cy * count + y) / nc
                c[2] = nc
                c[3] = min(minx, x)
                c[4] = max(maxx, x)
                c[5] = min(miny, y)
                c[6] = max(maxy, y)
                added = True
                break
        if not added:
            clusters.append([float(x), float(y), 1, x, x, y, y])

    # Filter out massive blocks or noise (Must be a compact block > 3 pixels)
    valid_greens = [c for c in clusters if 3 < c[2] < 300]
    
    for c in valid_greens:
        gx = int(c[0])
        gy = int(c[1])
        
        # Look to the left for the red Cancel 'x' icon (approx 20-50 px away)
        found_red = False
        scan_left_start = max(0, gx - 50)
        scan_left_end = max(0, gx - 15)
        
        for y in range(gy - 8, gy + 8):
            if y < 0 or y >= height: continue
            for x in range(scan_left_start, scan_left_end):
                r, g, b = pixels[x, y]
                # Red constraint: heavily biased towards Red channel
                if r > g + 20 and r > b + 20 and r > 100:
                    found_red = True
                    break
            if found_red:
                break
                
        if found_red:
            return (gx, gy)
            
    return None

# ─── Cooldown ────────────────────────────────────────────────────────

def is_in_cooldown():
    return time.time() - last_click_time < COOLDOWN_SECONDS

def record_click(cmd_text):
    global last_click_cmd, last_click_time, click_count
    click_count += 1
    last_click_cmd = cmd_text
    last_click_time = time.time()
    return click_count

# ─── Main Monitor Cycle ─────────────────────────────────────────────

def write_heartbeat():
    """Write current timestamp to heartbeat file so extension can detect backend is alive."""
    try:
        with open(HEARTBEAT_FILE, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
    except OSError:
        pass

def monitor_cycle():
    global click_count

    load_config()

    windows = find_kiro_windows()
    if not windows:
        return

    # Try each Kiro window — the prompt may be on any of them
    for win in windows:
        result = _monitor_window(win)
        if result:  # Action was taken
            return

def _monitor_window(win):
    hwnd = win["hwnd"]
    img, ocr_results = ocr_window(win)
    if not ocr_results and not img:
        return False

    all_text_lower = " ".join(r["text"].lower() for r in ocr_results)
    matched_trigger = None
    trigger_y = None
    for trigger in TRIGGER_TEXTS:
        if trigger in all_text_lower:
            # Find Y position AND validate it's an actual prompt banner
            # Real Kiro prompts appear at the bottom of the window (Y > 0.70)
            # Chat history messages with the same text appear in the middle
            first_word = trigger.split()[0]
            best_y = None
            for r in ocr_results:
                if first_word in r["text"].lower():
                    candidate_y = r["y"]
                    # Accept if in bottom 30% of window (real prompt area)
                    if candidate_y > 0.70:
                        best_y = candidate_y
                        break
                    # Also accept if co-located with Reject/Accept buttons
                    y_tolerance = 0.06
                    for r2 in ocr_results:
                        t2 = r2["text"].strip().lower()
                        if t2 in ("reject all", "accept all", "reject", "trust", "run"):
                            if abs(r2["y"] - candidate_y) < y_tolerance:
                                best_y = candidate_y
                                break
                    if best_y is not None:
                        break
            if best_y is not None:
                matched_trigger = trigger
                trigger_y = best_y
            break

    has_accept_all = False
    if "accept" in all_text_lower and "reject" in all_text_lower:
        # Validate that these appear at the bottom of the screen (Y > 0.70)
        # to prevent triggering on chat history containing these words.
        # Check for 'accept' and 'reject' in case OCR splits 'accept all' into two boxes
        accept_valid = False
        reject_valid = False
        log.info(f"[DEBUG] Found 'accept' and 'reject' in text. Checking Y-coords...")
        for r in ocr_results:
            t = r["text"].strip().lower()
            if "accept" in t:
                log.info(f"[DEBUG] 'accept' found at Y={r['y']:.3f} (text: '{t}')")
                if r["y"] > 0.60:
                    accept_valid = True
            if "reject" in t:
                log.info(f"[DEBUG] 'reject' found at Y={r['y']:.3f} (text: '{t}')")
                if r["y"] > 0.60:
                    reject_valid = True
        has_accept_all = accept_valid and reject_valid
        if has_accept_all:
            log.info("[DEBUG] has_accept_all evaluated to TRUE!")
        else:
            log.info("[DEBUG] has_accept_all evaluated to FALSE!")

    bg_process_y = None
    has_bg_process = False
    for r in ocr_results:
        text = r["text"].strip().lower()
        # Only match short standalone text entries (actual Kiro prompt bar, not chat/code)
        if ("background process" in text and len(text) < 30) or \
           (text == "background" and r["w"] > 0.02 and r["w"] < 0.15):
            # VALIDATION: Must have nearby approval buttons (Run/Trust/Reject) within
            # a similar Y-band to confirm this is an actual approval banner,
            # not just a status label in the agent panel.
            candidate_y = r["y"]
            y_tolerance = 0.06  # ~6% of screen height
            has_nearby_buttons = False
            for r2 in ocr_results:
                t2 = r2["text"].strip().lower()
                if t2 in ("run", "trust", "reject", "accept all", "reject all", "▶", "►", "play"):
                    if abs(r2["y"] - candidate_y) < y_tolerance:
                        has_nearby_buttons = True
                        break
            if has_nearby_buttons:
                bg_process_y = candidate_y
                has_bg_process = True
                break

    ocr_sees_dialog_buttons = False
    for r in ocr_results:
        text = r["text"].strip().lower()
        if text in ("reject", "reject all", "trust") and len(text) <= 12:
            ocr_sees_dialog_buttons = True
            break

    ocr_confirmed_dialog = bool(matched_trigger) and ocr_sees_dialog_buttons

    # CV Fallback: If OCR completely missed the text "Background process", 
    # but the red-green icon signature is clearly visible on screen.
    cv_btn_coords = None
    if img and not matched_trigger and not has_accept_all and not has_bg_process:
        cv_btn_coords = cv_find_bg_process_run_button(img)
        if cv_btn_coords:
            has_bg_process = True  # Force trigger
            matched_trigger = "Background process"
            ocr_confirmed_dialog = True
            log.info("[DEBUG] Pure CV Fallback identified Kiro Action Bar via Red/Green signature!")

    if not matched_trigger and not has_accept_all and not has_bg_process:
        _stuck_cycles[hwnd] = 0
        return False

    if matched_trigger and not ocr_sees_dialog_buttons and not has_accept_all and not has_bg_process:
        _stuck_cycles[hwnd] = 0
        return False

    # Obfuscate trigger names in logs to prevent OCR from reading our own output and looping
    if matched_trigger and "waiting on your input" in matched_trigger:
        trigger_label = "Wait-For-Input"
    elif has_bg_process:
        trigger_label = "BG-Process"
    elif has_accept_all:
        trigger_label = "Acc-All"
    else:
        trigger_label = matched_trigger or "Unknown"

    log.info(f"Detected: '{trigger_label}'")

    cmd_text = extract_command_text(ocr_results)
    if cmd_text:
        log.info(f"   Command: {cmd_text[:120]}")

    if is_in_cooldown():
        return True  # Found trigger but in cooldown, don't scan other windows

    # Safety analysis
    safe, safety_reason = analyze_command_safety(cmd_text, all_text_lower)
    if not safe:
        log.info(f"BLOCKED - {safety_reason}")
        send_notification(f"Blocked: {safety_reason}", play_sound=True)
        log_action("denied", cmd_text or trigger_label, safety_reason)
        record_click(cmd_text)
        _stuck_cycles[hwnd] = 0
        return True  # Trigger found, blocked — don't scan other windows

    # Learn pattern
    learn_pattern = None
    auto_trust_signal = False
    if cmd_text:
        base_cmd = cmd_text.strip().split()[0] if cmd_text.strip() else None
        if base_cmd:
            base_cmd = base_cmd.split("/")[-1].split("\\")[-1]
            for ext in (".exe", ".cmd", ".bat"):
                if base_cmd.lower().endswith(ext):
                    base_cmd = base_cmd[:-len(ext)]
            if base_cmd.lower() in NEVER_LEARN:
                log.info(f"   '{base_cmd}' is in NEVER_LEARN")
            else:
                cmd_parts = cmd_text.strip().split()
                has_path_arg = any(("/" in p or "\\" in p) and not p.startswith("-") for p in cmd_parts[1:])
                is_short = len(cmd_parts) <= 3
                if is_short and not has_path_arg:
                    learn_pattern = cmd_text.strip()
                else:
                    learn_pattern = f"{base_cmd} *"

                _approval_freq[learn_pattern] = _approval_freq.get(learn_pattern, 0) + 1
                count_seen = _approval_freq[learn_pattern]
                if count_seen >= AUTO_TRUST_THRESHOLD:
                    auto_trust_signal = True
                    save_learned()
                elif count_seen % 2 == 0:
                    save_learned()

    win_hwnd = win.get("hwnd")

    # PRIMARY: UI Automation API (no cursor steal, accurate button targeting)
    if win_hwnd:
        pressed, btn_title = uia_press_button(win_hwnd, CLICKABLE_BUTTONS)
        if pressed:
            count = record_click(cmd_text)
            log.info(f"UIA pressed '{btn_title}' (#{count})")
            send_notification(f"Auto-approved '{btn_title}' (#{count})")
            log_action("auto-approved", cmd_text or btn_title,
                      f"Trigger: {trigger_label} [UIA]", learn_pattern, auto_trust_signal)
            _stuck_cycles[hwnd] = 0
            time.sleep(2)
            return True

    # SECONDARY: OCR-confirmed click (SendInput — only after UIA has failed several cycles)
    # For "Background process" prompts, UIA never finds the Run button (it's not exposed
    # as a UIA Button), so we skip the delay and use OCR immediately.
    # For "waiting on input" prompts, UIA works on the 2nd cycle, so we wait.
    sc = _stuck_cycles.get(hwnd, 0)
    should_try_ocr = has_bg_process or has_accept_all or sc >= MIN_STUCK_FOR_MOUSE_FALLBACK
    if should_try_ocr:
        if cv_btn_coords:
            gx, gy = cv_btn_coords
            dialog_btn = ("run", win["x"] + gx, win["y"] + gy)
        else:
            dialog_btn = ocr_find_dialog_button(ocr_results, win,
                                                 ocr_confirmed_dialog=ocr_confirmed_dialog,
                                                 bg_process_y=bg_process_y,
                                                 use_position_fallback=True)
        if dialog_btn:
            btn_text, px, py = dialog_btn
            if click_at_position(px, py, win=win, skip_postmessage=True):
                count = record_click(cmd_text)
                source = "BG-process" if has_bg_process else "OCR-click"
                log.info(f"{source} pressed '{btn_text}' at ({px},{py}) (#{count})")
                send_notification(f"Auto-approved '{btn_text}' (#{count})")
                log_action("auto-approved", cmd_text or btn_text,
                          f"Trigger: {trigger_label} [{source}]", learn_pattern, auto_trust_signal)
                _stuck_cycles[hwnd] = 0
                time.sleep(2)
                return True

    # UIA could not find a clickable button — wait and retry next cycle
    if matched_trigger or has_accept_all or has_bg_process:
        sc = _stuck_cycles.get(hwnd, 0) + 1
        _stuck_cycles[hwnd] = sc
        if sc <= 3 or sc % 10 == 0:
            log.info(f"Trigger found but no button (stuck: {sc}/{STUCK_THRESHOLD}) [hwnd={hwnd}]")

        if sc >= STUCK_THRESHOLD and STUCK_RECOVERY_ENABLED:
            log.warning(f"Stuck for {sc} cycles — UIA cannot find button [hwnd={hwnd}]")
            send_notification("Stuck: trigger found but UIA can't press button", play_sound=True)
            log_action("stuck", "no_button", f"Stuck {sc} cycles — UIA only")
            _stuck_cycles[hwnd] = 0
        return True  # Trigger was found (even if no button), don't scan other windows

    return False  # No trigger found on this window

# ─── Main ────────────────────────────────────────────────────────────

def main():
    load_config()

    # Kill any existing instances
    my_pid = os.getpid()
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*kiro-autorun-win*' } | Select-Object -ExpandProperty ProcessId"],
            capture_output=True, text=True, timeout=5,
            creationflags=subprocess.CREATE_NO_WINDOW
        )
        for line in result.stdout.strip().split('\n'):
            line = line.strip()
            if line.isdigit():
                pid = int(line)
                if pid != my_pid:
                    try:
                        os.kill(pid, signal.SIGTERM)
                        log.info(f"Killed old instance PID {pid}")
                    except (ProcessLookupError, PermissionError, OSError):
                        # Fallback: taskkill
                        try:
                            subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                         capture_output=True, timeout=3,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
                        except Exception:
                            pass
    except Exception:
        pass

    log.info(f"Kiro AutoRun Windows v{VERSION}")
    log.info(f"   Target: {TARGET_APP}")
    log.info(f"   Triggers: {TRIGGER_TEXTS}")
    log.info(f"   Poll: adaptive {POLL_SLOW}s/{POLL_NORMAL}s/{POLL_FAST}s")
    log.info(f"   Banned: {len(BANNED_KEYWORDS)} keywords")
    log.info(f"   Config: {CONFIG_FILE}")
    log.info(f"   Action log: {ACTION_LOG_FILE}")
    log.info("")

    _init_ocr()

    windows = find_kiro_windows()
    if not windows:
        log.warning("No Kiro window found!")
    else:
        for i, w in enumerate(windows):
            log.info(f"Kiro[{i}]: {w['w']}x{w['h']} (PID: {w['pid']}, HWND: {w['hwnd']}) - {w['title']}")
    log.info("")
    log.info("Monitoring... (Ctrl+C to stop)")
    log.info("")

    # Write PID file for coordination with TypeScript extension
    def _write_pid_file():
        try:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            with open(PID_FILE, "w") as f:
                f.write(str(os.getpid()))
        except OSError:
            pass

    def _remove_pid_file():
        try:
            if os.path.exists(PID_FILE):
                os.unlink(PID_FILE)
        except OSError:
            pass

    _write_pid_file()
    atexit.register(_remove_pid_file)

    global _consecutive_errors
    while running:
        try:
            write_heartbeat()

            kiro_present = bool(find_kiro_windows())
            # Check any window had trigger
            had_trigger_before = any(_last_img_had_trigger.values())

            monitor_cycle()

            # Reset error counter on successful cycle
            _consecutive_errors = 0

            if not kiro_present:
                sleep_dur = POLL_SLOW
            elif had_trigger_before or any(_last_img_had_trigger.values()):
                sleep_dur = POLL_FAST
            else:
                sleep_dur = POLL_NORMAL
        except KeyboardInterrupt:
            break
        except Exception as e:
            import traceback
            _consecutive_errors += 1

            if _consecutive_errors <= 3 or _consecutive_errors % 10 == 0:
                log.error(f"Cycle error (#{_consecutive_errors}): {e}")
            if _consecutive_errors >= ERROR_BACKOFF_THRESHOLD:
                log.error(f"Full traceback (error #{_consecutive_errors}):\n{traceback.format_exc()}")
                sleep_dur = 30.0  # Back off significantly
            else:
                sleep_dur = POLL_NORMAL

            if _consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
                log.error(f"FATAL: {_consecutive_errors} consecutive errors — exiting for auto-restart")
                break

        time.sleep(sleep_dur)

    log.info("Stopped")

if __name__ == "__main__":
    main()
