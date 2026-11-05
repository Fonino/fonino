// agentphone-macos: tiny native helper that drives the macOS "iPhone Mirroring" app.
//
// Every command prints exactly one JSON object on stdout. On failure it prints
// {"ok":false,"error":"...","code":"..."} and exits non-zero.
//
// Coordinates are in window points, relative to the top-left of the
// iPhone Mirroring window. Screenshots are rendered at `--scale` pixels per point
// (default 1), so with scale 1 a screenshot pixel == a tap coordinate.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import UniformTypeIdentifiers

let mirroringBundleId = "com.apple.ScreenContinuity"
let mirroringOwnerName = "iPhone Mirroring"

// MARK: - Output helpers

func emit(_ obj: [String: Any]) {
    var o = obj
    if o["ok"] == nil { o["ok"] = true }
    let data = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "error": message])
    exit(1)
}

// MARK: - Window discovery

struct MirrorWindow {
    let windowId: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let onScreen: Bool
}

func findMirrorWindow() -> MirrorWindow? {
    guard let list = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    // Pick the largest normal-layer window owned by iPhone Mirroring.
    var best: MirrorWindow?
    for w in list {
        guard (w[kCGWindowOwnerName as String] as? String) == mirroringOwnerName,
              (w[kCGWindowLayer as String] as? Int) == 0,
              let bd = w[kCGWindowBounds as String] as? [String: Double],
              let num = w[kCGWindowNumber as String] as? Int,
              let pid = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
        let rect = CGRect(x: bd["X"] ?? 0, y: bd["Y"] ?? 0, width: bd["Width"] ?? 0, height: bd["Height"] ?? 0)
        if rect.width < 100 || rect.height < 100 { continue }
        let cand = MirrorWindow(windowId: CGWindowID(num), pid: pid, bounds: rect,
                                onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) ?? false)
        // Prefer on-screen windows (the app also owns hidden helper windows), then the largest.
        if let b = best {
            if b.onScreen && !cand.onScreen { continue }
            if cand.onScreen == b.onScreen && rect.width * rect.height <= b.bounds.width * b.bounds.height { continue }
        }
        best = cand
    }
    return best
}

func requireWindow() -> MirrorWindow {
    guard let w = findMirrorWindow() else {
        fail("no_window", "iPhone Mirroring window not found. Run `agentphone-macos launch` or open the iPhone Mirroring app.")
    }
    return w
}

func mirroringApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: mirroringBundleId).first
}

var previousFrontApp: NSRunningApplication?

func activateMirroring(_ w: MirrorWindow) {
    let front = NSWorkspace.shared.frontmostApplication
    if front?.processIdentifier == w.pid { return }
    previousFrontApp = front
    NSRunningApplication(processIdentifier: w.pid)?.activate()
    // Wait until it is actually frontmost (up to ~1s); events go to the key window.
    // frontmostApplication only refreshes when the run loop turns, so spin it while polling.
    for _ in 0..<50 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    }
    usleep(80_000)
}

func restoreFocusIfRequested() {
    if flags["restore-focus"] != nil, let prev = previousFrontApp {
        prev.activate()
    }
}

// MARK: - Argument parsing

var positional: [String] = []
var flags: [String: String] = [:]
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        if a.hasPrefix("--") {
            let key = String(a.dropFirst(2))
            if ["restore-focus", "no-activate"].contains(key) { flags[key] = "1" }
            else { flags[key] = it.next() ?? "" }
        } else {
            positional.append(a)
        }
    }
}

func num(_ i: Int, _ name: String) -> Double {
    guard i < positional.count, let v = Double(positional[i]) else { fail("bad_args", "missing or invalid <\(name)>") }
    return v
}

func toGlobal(_ w: MirrorWindow, _ x: Double, _ y: Double) -> CGPoint {
    guard x >= 0, y >= 0, x <= w.bounds.width, y <= w.bounds.height else {
        fail("out_of_bounds", "point (\(x), \(y)) outside window \(Int(w.bounds.width))x\(Int(w.bounds.height))")
    }
    return CGPoint(x: w.bounds.minX + x, y: w.bounds.minY + y)
}

// MARK: - Input

let eventSource = CGEventSource(stateID: .hidSystemState)

/// All input is posted at the HID level. Tested: iPhone Mirroring ignores events
/// posted to its process (CGEvent.postToPid), even when frontmost, so input
/// necessarily moves the real cursor and needs the window frontmost.
func deliver(_ e: CGEvent) {
    e.post(tap: .cghidEventTap)
}

func postMouse(_ type: CGEventType, _ p: CGPoint) {
    if let e = CGEvent(mouseEventSource: eventSource, mouseType: type, mouseCursorPosition: p, mouseButton: .left) { deliver(e) }
}

func tap(_ p: CGPoint, holdMs: Int = 60) {
    postMouse(.mouseMoved, p)
    usleep(40_000)
    postMouse(.leftMouseDown, p)
    usleep(useconds_t(holdMs * 1000))
    postMouse(.leftMouseUp, p)
}

func swipe(_ s: CGPoint, _ e: CGPoint, durationMs: Int) {
    postMouse(.mouseMoved, s)
    usleep(40_000)
    postMouse(.leftMouseDown, s)
    usleep(30_000)
    let steps = max(8, durationMs / 12)
    let stepSleep = useconds_t(max(1, durationMs * 1000 / steps))
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        postMouse(.leftMouseDragged, CGPoint(x: s.x + (e.x - s.x) * t, y: s.y + (e.y - s.y) * t))
        usleep(stepSleep)
    }
    usleep(30_000)
    postMouse(.leftMouseUp, e)
}

/// Vertical gestures: iPhone Mirroring ignores vertical mouse drags (tested) but maps
/// scroll-wheel/trackpad scrolling to finger scrolling. A finger moving by dy is sent as
/// pixel scroll deltas of the same sign (positive = content moves down).
func scroll(at p: CGPoint, dx: Double, dy: Double, durationMs: Int) {
    postMouse(.mouseMoved, p)
    usleep(40_000)
    let steps = max(6, durationMs / 16)
    var sentX = 0.0, sentY = 0.0
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let wantX = dx * t, wantY = dy * t
        let stepX = Int32((wantX - sentX).rounded()), stepY = Int32((wantY - sentY).rounded())
        sentX += Double(stepX); sentY += Double(stepY)
        if let e = CGEvent(scrollWheelEvent2Source: eventSource, units: .pixel, wheelCount: 2, wheel1: stepY, wheel2: stepX, wheel3: 0) {
            e.location = p
            deliver(e)
        }
        usleep(16_000)
    }
}

func key(_ code: CGKeyCode, flags f: CGEventFlags = []) {
    let d = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: true)!
    d.flags = f
    deliver(d)
    usleep(30_000)
    let u = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: false)!
    u.flags = f
    deliver(u)
    usleep(30_000)
}

func typeText(_ text: String, delayMs: Int) {
    for ch in text {
        if ch == "\n" || ch == "\r" { key(36); continue }
        if ch == "\t" { key(48); continue }
        var units = Array(String(ch).utf16)
        let d = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: true)!
        d.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        deliver(d)
        let u = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: false)!
        u.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        deliver(u)
        usleep(useconds_t(delayMs * 1000))
    }
}

let namedKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
]

// MARK: - Menu actions (View menu of iPhone Mirroring)

/// Press a menu item by title via Accessibility. Returns false if not found.
func pressMenuItem(pid: pid_t, title: String) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    var menuBarRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &menuBarRef) == .success else { return false }
    let menuBar = menuBarRef as! AXUIElement
    func children(_ el: AXUIElement) -> [AXUIElement] {
        var ref: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ref)
        return (ref as? [AXUIElement]) ?? []
    }
    func titleOf(_ el: AXUIElement) -> String? {
        var ref: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &ref)
        return ref as? String
    }
    for top in children(menuBar) {
        for menu in children(top) {
            for item in children(menu) where titleOf(item) == title {
                return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
            }
        }
    }
    return false
}

func menuOrShortcut(_ w: MirrorWindow, title: String, keyCode: CGKeyCode) -> String {
    activateMirroring(w)
    if pressMenuItem(pid: w.pid, title: title) { return "menu" }
    key(keyCode, flags: .maskCommand)
    return "shortcut"
}

// MARK: - Session state via Accessibility
//
// Tested: while the phone is being mirrored, the main window's AX tree is a bare
// AXGroup. When mirroring is interrupted ("Timed Out", "iPhone in Use", locked
// out, ...) the window shows AXStaticText messages and AXButtons (Connect / Try Again).

struct SessionState {
    /// "active" | "auth_required" | "interrupted"
    var state = "active"
    var texts: [String] = []
    var buttons: [(String, AXUIElement)] = []
    var active: Bool { state == "active" }
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var ref: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success else { return nil }
    return ref as? String
}

/// The hover toolbar exposes these buttons even while mirroring normally.
let toolbarButtons: Set<String> = ["Home Screen", "App Switcher"]

func sessionState(pid: pid_t) -> SessionState {
    let app = AXUIElementCreateApplication(pid)
    var st = SessionState()
    var sawSheet = false
    func walk(_ el: AXUIElement, depth: Int) {
        if depth > 12 { return }
        let role = axString(el, kAXRoleAttribute) ?? ""
        if role == "AXSheet" { sawSheet = true }
        if role == "AXStaticText", let v = axString(el, kAXValueAttribute), !v.isEmpty { st.texts.append(v) }
        if role == "AXButton" {
            let label = axString(el, kAXDescriptionAttribute) ?? axString(el, kAXTitleAttribute) ?? ""
            if !label.isEmpty && !toolbarButtons.contains(label) { st.buttons.append((label, el)) }
        }
        var ch: CFTypeRef?
        AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &ch)
        for c in (ch as? [AXUIElement]) ?? [] { walk(c, depth: depth + 1) }
    }
    var winsRef: CFTypeRef?
    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &winsRef)
    for w in (winsRef as? [AXUIElement]) ?? [] { walk(w, depth: 0) }
    // Tested: a locked iOS app (e.g. Messages with Require Face ID) makes iPhone Mirroring
    // show an AXSheet asking for Mac Touch ID / login password ("Use Password…", "Cancel").
    let authWords = st.texts.joined(separator: " ").lowercased()
    if sawSheet && (authWords.contains("touch id") || authWords.contains("authenticate") || authWords.contains("password")) {
        st.state = "auth_required"
    } else if !st.texts.isEmpty || !st.buttons.isEmpty {
        st.state = "interrupted"
    }
    return st
}

// MARK: - Screenshot

func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "agentphone", code: 1, userInfo: [NSLocalizedDescriptionKey: "cannot create \(path)"])
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        throw NSError(domain: "agentphone", code: 2, userInfo: [NSLocalizedDescriptionKey: "cannot write \(path)"])
    }
}

func captureWindow(_ w: MirrorWindow, scale: Double) async throws -> CGImage {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let scWin = content.windows.first(where: { $0.windowID == w.windowId }) else {
        throw NSError(domain: "agentphone", code: 3, userInfo: [NSLocalizedDescriptionKey: "window \(w.windowId) not shareable"])
    }
    let filter = SCContentFilter(desktopIndependentWindow: scWin)
    let cfg = SCStreamConfiguration()
    cfg.width = Int((w.bounds.width * scale).rounded())
    cfg.height = Int((w.bounds.height * scale).rounded())
    cfg.showsCursor = false
    cfg.ignoreShadowsSingleWindow = true
    return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
}

/// Coarse 48x104 grayscale grid of the image (base64). Lets callers measure how much
/// of the screen changed, ignoring tiny animations like the Clock icon's second hand.
func signature(_ image: CGImage) -> String {
    let w = 48, h = 104
    // Let CoreGraphics own the buffer: `&array` would only be valid during the init call.
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return Data(bytes: ctx.data!, count: w * h).base64EncodedString()
}

// MARK: - Commands

let cmd = positional.first ?? "help"
positional = Array(positional.dropFirst())

switch cmd {
case "status":
    let w = findMirrorWindow()
    var o: [String: Any] = [
        "running": mirroringApp() != nil,
        "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
        "accessibilityAccess": AXIsProcessTrusted(),
        "windowFound": w != nil,
    ]
    if let w = w {
        o["windowId"] = Int(w.windowId)
        o["pid"] = Int(w.pid)
        o["onScreen"] = w.onScreen
        o["bounds"] = ["x": w.bounds.minX, "y": w.bounds.minY, "width": w.bounds.width, "height": w.bounds.height]
        o["frontmost"] = NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid
        if AXIsProcessTrusted() {
            let st = sessionState(pid: w.pid)
            o["sessionActive"] = st.active
            o["sessionState"] = st.state
            if !st.active {
                o["message"] = st.texts.joined(separator: " ")
                o["buttons"] = st.buttons.map { $0.0 }
            }
        }
    }
    emit(o)

case "launch":
    if mirroringApp() == nil {
        let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: mirroringBundleId)
        guard let url = url else { fail("not_installed", "iPhone Mirroring app not found (requires macOS 15+).") }
        _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }
    for _ in 0..<50 {
        if findMirrorWindow() != nil { break }
        usleep(100_000)
    }
    guard let w = findMirrorWindow() else { fail("no_window", "iPhone Mirroring launched but no window appeared") }
    emit(["windowId": Int(w.windowId), "width": w.bounds.width, "height": w.bounds.height])

case "connect":
    // Press Connect / Try Again on an interrupted session and wait for mirroring to resume.
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    let w = requireWindow()
    var st = sessionState(pid: w.pid)
    if st.active { emit(["sessionActive": true, "pressed": NSNull()]); break }
    if st.state == "auth_required" {
        fail("auth_required", "iPhone Mirroring is asking for Mac authentication: \(st.texts.joined(separator: " ")). AgentPhone never authenticates on the owner's behalf.")
    }
    guard let btn = st.buttons.first(where: { ["Connect", "Try Again", "Continue", "Reconnect"].contains($0.0) }) else {
        fail("cannot_reconnect", "Mirroring interrupted: \(st.texts.joined(separator: " ")) (no Connect button)")
    }
    AXUIElementPerformAction(btn.1, kAXPressAction as CFString)
    let deadline = Date().addingTimeInterval(Double(flags["timeout"] ?? "20") ?? 20)
    while Date() < deadline {
        usleep(500_000)
        st = sessionState(pid: w.pid)
        if st.active { break }
    }
    if !st.active { fail("reconnect_failed", "Still interrupted: \(st.texts.joined(separator: " "))") }
    emit(["sessionActive": true, "pressed": btn.0])

case "cancel-auth":
    // Decline a Touch ID / password sheet (never answers it).
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    let w = requireWindow()
    let st = sessionState(pid: w.pid)
    guard st.state == "auth_required", let cancel = st.buttons.first(where: { $0.0 == "Cancel" }) else {
        emit(["cancelled": false, "sessionState": st.state]); break
    }
    AXUIElementPerformAction(cancel.1, kAXPressAction as CFString)
    emit(["cancelled": true])

case "screenshot":
    guard CGPreflightScreenCaptureAccess() else {
        fail("no_screen_capture_permission", "Grant Screen Recording permission to the terminal/app running agentphone (System Settings → Privacy & Security → Screen Recording).")
    }
    let w = requireWindow()
    let scale = Double(flags["scale"] ?? "1") ?? 1
    let out = flags["out"] ?? NSTemporaryDirectory() + "agentphone-\(Int(Date().timeIntervalSince1970 * 1000)).png"
    do {
        let img = try await captureWindow(w, scale: scale)
        try writePNG(img, to: out)
        emit(["path": out, "width": w.bounds.width, "height": w.bounds.height,
              "pixelWidth": img.width, "pixelHeight": img.height, "scale": scale, "signature": signature(img)])
    } catch {
        fail("capture_failed", error.localizedDescription)
    }

case "tap":
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission (System Settings → Privacy & Security → Accessibility).") }
    let w = requireWindow()
    let p = toGlobal(w, num(0, "x"), num(1, "y"))
    activateMirroring(w)
    tap(p, holdMs: Int(flags["hold"] ?? "60") ?? 60)
    restoreFocusIfRequested()
    emit(["action": "tap", "x": num(0, "x"), "y": num(1, "y")])

case "swipe":
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    let w = requireWindow()
    let s = toGlobal(w, num(0, "x1"), num(1, "y1"))
    let e = toGlobal(w, num(2, "x2"), num(3, "y2"))
    activateMirroring(w)
    let dur = Int(flags["duration"] ?? "300") ?? 300
    // --method drag|scroll|auto (default auto: vertical-dominant → scroll, else drag)
    let method = flags["method"] ?? "auto"
    let vertical = abs(e.y - s.y) > abs(e.x - s.x)
    let useScroll = method == "scroll" || (method == "auto" && vertical)
    if useScroll {
        scroll(at: s, dx: e.x - s.x, dy: e.y - s.y, durationMs: dur)
    } else {
        swipe(s, e, durationMs: dur)
    }
    restoreFocusIfRequested()
    emit(["action": "swipe", "method": useScroll ? "scroll" : "drag"])

case "type":
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    guard let text = positional.first else { fail("bad_args", "missing <text>") }
    let w = requireWindow()
    activateMirroring(w)
    typeText(text, delayMs: Int(flags["delay"] ?? "25") ?? 25)
    restoreFocusIfRequested()
    emit(["action": "type", "length": text.count])

case "key":
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    guard let name = positional.first?.lowercased(), let code = namedKeys[name] else {
        fail("bad_args", "key must be one of: \(namedKeys.keys.sorted().joined(separator: ", "))")
    }
    let w = requireWindow()
    activateMirroring(w)
    key(code)
    restoreFocusIfRequested()
    emit(["action": "key", "key": name])

case "home", "app-switcher", "spotlight":
    guard AXIsProcessTrusted() else { fail("no_accessibility_permission", "Grant Accessibility permission.") }
    let w = requireWindow()
    let (title, code): (String, CGKeyCode) = cmd == "home" ? ("Home Screen", 18) : cmd == "app-switcher" ? ("App Switcher", 19) : ("Spotlight", 20)
    let via = menuOrShortcut(w, title: title, keyCode: code)
    restoreFocusIfRequested()
    emit(["action": cmd, "via": via])

default:
    let usage = """
    agentphone-macos <command> [args] [--restore-focus]
      status                         window, session + permission status (JSON)
      connect                        press Connect/Try Again on an interrupted session
      cancel-auth                    press Cancel on a Touch ID/password sheet
      launch                         open iPhone Mirroring and wait for its window
      screenshot [--out p] [--scale s]
      tap <x> <y> [--hold ms]
      swipe <x1> <y1> <x2> <y2> [--duration ms] [--method auto|drag|scroll]
      type <text> [--delay ms]
      key <return|delete|escape|tab|space|up|down|left|right>
      home | app-switcher | spotlight
    Coordinates are window points relative to the iPhone Mirroring window.
    """
    FileHandle.standardError.write(usage.data(using: .utf8)!)
    exit(cmd == "help" ? 0 : 2)
}
exit(0)
