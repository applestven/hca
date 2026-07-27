"""Sub App UI 自动化（uiautomator2）。

说明：
- 选择器按 dump 的 resource-id 编写（com.MinorityCulture.MinorityCulture）。
- dry_run 模式不点真实 UI，仅走状态机。
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, List, Optional, Tuple

import uiautomator2 as u2

try:
    from api import make_message_key
except ImportError:
    from .api import make_message_key  # type: ignore

PKG = "com.MinorityCulture.MinorityCulture"
RID = lambda x: f"{PKG}:id/{x}"  # noqa: E731


def connect_device(serial: Optional[str] = None):
    if serial:
        return u2.connect(serial)
    return u2.connect_usb()


def safe_tap(d, x: int, y: int) -> bool:
    """优先 u2 点击；无 INJECT_EVENTS 时回退 adb shell input tap。"""
    try:
        d.click(int(x), int(y))
        return True
    except Exception:
        pass
    try:
        d.shell(f"input tap {int(x)} {int(y)}")
        return True
    except Exception:
        return False


def safe_swipe(d, x1: int, y1: int, x2: int, y2: int, duration: float = 0.25) -> bool:
    """优先 u2 swipe；Permission/INJECT_EVENTS 失败时用 shell input swipe。"""
    try:
        d.swipe(int(x1), int(y1), int(x2), int(y2), duration)
        return True
    except Exception:
        pass
    try:
        ms = max(50, int(float(duration) * 1000))
        d.shell(f"input swipe {int(x1)} {int(y1)} {int(x2)} {int(y2)} {ms}")
        return True
    except Exception:
        return False


def safe_click_widget(d, widget) -> bool:
    """点击控件；失败则按 bounds 中心 shell tap。"""
    try:
        widget.click()
        return True
    except Exception:
        pass
    try:
        info = widget.info or {}
        bounds = info.get("bounds") or {}
        left = int(bounds.get("left", 0))
        right = int(bounds.get("right", 0))
        top = int(bounds.get("top", 0))
        bottom = int(bounds.get("bottom", 0))
        if right > left and bottom > top:
            return safe_tap(d, (left + right) // 2, (top + bottom) // 2)
    except Exception:
        return False
    return False


def dismiss_blocking_dialogs(d) -> None:
    for t in ("允许", "始终允许", "仅在使用中允许", "确定", "同意", "我知道了", "关闭"):
        try:
            n = d(text=t)
            if n.exists(timeout=0.25):
                safe_click_widget(d, n)
                time.sleep(0.3)
        except Exception:
            continue


def ensure_app(d, package: str = PKG) -> None:
    try:
        cur = (d.app_current() or {}).get("package")
    except Exception:
        cur = None
    if cur != package:
        d.app_start(package)
        time.sleep(2.2)
    dismiss_blocking_dialogs(d)


def open_message_tab(d) -> bool:
    """打开消息 Tab；点击失败时坐标/shell 兜底。"""
    dismiss_blocking_dialogs(d)

    # 已在消息列表
    if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.6):
        return True

    for rid in (RID("tab_message"), RID("flMessage")):
        tab = d(resourceId=rid)
        if tab.exists(timeout=1.0):
            if safe_click_widget(d, tab):
                time.sleep(1.0)
                if d(resourceId=RID("rc_conversation_title")).exists(timeout=1.0):
                    return True

    if d(text="消息").exists(timeout=0.6):
        if safe_click_widget(d, d(text="消息")):
            time.sleep(1.0)
            if d(resourceId=RID("rc_conversation_title")).exists(timeout=1.0):
                return True

    # 底部导航坐标兜底（不同机型消息 Tab 位置略有差异）
    try:
        w, h = d.window_size()
    except Exception:
        return False
    for x_ratio in (0.375, 0.25, 0.5, 0.62):
        safe_tap(d, int(w * x_ratio), int(h * 0.94))
        time.sleep(0.85)
        dismiss_blocking_dialogs(d)
        if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.6):
            return True
    return bool(d(resourceId=RID("rc_conversation_title")).exists(timeout=0.4))


def collect_session_candidates(d, max_items: int = 30) -> List[Dict[str, Any]]:
    """从当前消息列表采集候选会话。返回 [{userId, displayName, raw, unread}]"""
    out: List[Dict[str, Any]] = []
    seen = set()

    items = d.xpath('//*[@resource-id="%s"]' % RID("rc_conversation_item")).all()
    if items:
        for item in items:
            if len(out) >= max_items:
                break
            try:
                el = item.get()
                title_node = el.xpath('.//*[@resource-id="%s"]' % RID("rc_conversation_title"))
                if not title_node.exists:
                    continue
                name = (title_node.get_text() or "").strip()
                if not name or name in seen:
                    continue
                if name in ("消息", "请输入内容", "开启呼唤"):
                    continue
                seen.add(name)
                unread = 0
                count_node = el.xpath(
                    './/*[@resource-id="%s"]' % RID("rc_conversation_unread_count")
                )
                if count_node.exists:
                    raw = (count_node.get_text() or "").strip()
                    if raw.isdigit():
                        unread = int(raw)
                preview = ""
                content_node = el.xpath(
                    './/*[@resource-id="%s"]' % RID("rc_conversation_content")
                )
                if content_node.exists:
                    preview = (content_node.get_text() or "").strip()
                uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
                out.append(
                    {
                        "userId": uid,
                        "displayName": name,
                        "raw": name,
                        "unread": unread,
                        "preview": preview,
                    }
                )
            except Exception:
                continue
        if out:
            return out

    # 兜底：仅标题
    nodes = d(resourceId=RID("rc_conversation_title"))
    try:
        count = nodes.count
    except Exception:
        count = 0
    for i in range(min(count, max_items * 2)):
        try:
            n = nodes[i]
            name = (n.get_text() or "").strip()
            if not name or name in seen:
                continue
            if name in ("消息", "请输入内容", "开启呼唤"):
                continue
            seen.add(name)
            uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
            out.append({"userId": uid, "displayName": name, "raw": name, "unread": 0})
            if len(out) >= max_items:
                break
        except Exception:
            continue
    return out


def scroll_message_list(d) -> None:
    w, h = d.window_size()
    safe_swipe(d, int(w * 0.5), int(h * 0.75), int(w * 0.5), int(h * 0.35), 0.25)
    time.sleep(0.6)


def is_chat_page(d) -> bool:
    """是否已在聊天输入页（有编辑框）。"""
    return bool(d(resourceId=RID("edit_btn")).exists(timeout=0.35))


def wait_chat_ready(d, expected_name: Optional[str] = None, timeout: float = 4.0) -> bool:
    """等待进入聊天页；可选校验标题。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_chat_page(d):
            if expected_name:
                title = d(resourceId=RID("tv_toolbar_title"))
                if title.exists(timeout=0.2):
                    t = (title.get_text() or "").strip()
                    if t == expected_name.strip():
                        return True
                    # 标题尚未刷新时继续等
                    time.sleep(0.15)
                    continue
            return True
        time.sleep(0.2)
    return is_chat_page(d)


def open_session_by_name(d, display_name: str) -> bool:
    """打开会话。注意：标题 TextView 多为 clickable=false，必须点整行 item。"""
    name = (display_name or "").strip()
    if not name:
        return False

    # 已在目标聊天页
    if is_chat_page(d):
        title = d(resourceId=RID("tv_toolbar_title"))
        if title.exists(timeout=0.3):
            t = (title.get_text() or "").strip()
            if t == name:
                return True
            # 在别人的聊天页：先返回列表
            go_back(d, settle=0.5)
            time.sleep(0.4)

    # 优先点 rc_conversation_item 整行
    items = d.xpath('//*[@resource-id="%s"]' % RID("rc_conversation_item")).all()
    for item in items:
        try:
            el = item.get()
            title_node = el.xpath('.//*[@resource-id="%s"]' % RID("rc_conversation_title"))
            if not title_node.exists:
                continue
            if (title_node.get_text() or "").strip() != name:
                continue
            # 点整行（item 可点）
            try:
                item.click()
            except Exception:
                try:
                    el.click()
                except Exception:
                    try:
                        info = el.info or {}
                        bounds = info.get("bounds") or {}
                        safe_tap(
                            d,
                            (bounds.get("left", 0) + bounds.get("right", 0)) // 2,
                            (bounds.get("top", 0) + bounds.get("bottom", 0)) // 2,
                        )
                    except Exception:
                        continue
            if wait_chat_ready(d, expected_name=name, timeout=4.0):
                return True
            break
        except Exception:
            continue

    # 兜底：点标题（部分机型会点穿到父级）
    node = d(resourceId=RID("rc_conversation_title"), text=name)
    if node.exists(timeout=1.2):
        safe_click_widget(d, node)
        if wait_chat_ready(d, expected_name=name, timeout=3.5):
            return True

    if d(text=name).exists(timeout=0.8):
        safe_click_widget(d, d(text=name))
        if wait_chat_ready(d, expected_name=name, timeout=3.5):
            return True

    return False


def _bubble_from_text_node(el_info, text: str, index: int, mid: float) -> Dict[str, Any]:
    bounds = (el_info or {}).get("bounds") or {}
    left = bounds.get("left", 0)
    right = bounds.get("right", 0)
    top = bounds.get("top", index)
    center = (left + right) / 2
    side = "me" if center >= mid else "other"
    return {
        "id": make_message_key(side, text),
        "side": side,
        "text": text,
        "index": index,
        "top": top,
    }


def read_chat_bubbles(d) -> List[Dict[str, Any]]:
    """读取聊天页可见气泡。side: me|other（右头像=me，左头像=other）。按 Y 坐标排序。"""
    bubbles: List[Dict[str, Any]] = []
    w, _h = d.window_size()
    mid = w * 0.5

    # 1) 优先用 my_text（比 xpath 子树更稳）
    texts = d(resourceId=RID("my_text"))
    try:
        n = texts.count
    except Exception:
        n = 0
    for i in range(n):
        try:
            t = (texts[i].get_text() or "").strip()
            if not t:
                continue
            bubbles.append(_bubble_from_text_node(texts[i].info, t, i, mid))
        except Exception:
            continue

    if bubbles:
        bubbles.sort(key=lambda b: (b.get("top", 0), b.get("index", 0)))
        return bubbles

    # 2) 兜底：rc_cl_content + 左右头像
    items = d.xpath('//*[@resource-id="%s"]' % RID("rc_cl_content")).all()
    for i, item in enumerate(items):
        try:
            el = item.get()
            has_right = el.xpath('.//*[@resource-id="%s"]' % RID("rc_right_portrait")).exists
            has_left = el.xpath('.//*[@resource-id="%s"]' % RID("rc_left_portrait")).exists
            text_node = el.xpath('.//*[@resource-id="%s"]' % RID("my_text"))
            text = ""
            if text_node.exists:
                text = (text_node.get_text() or "").strip()
            if not text:
                continue

            top = i
            try:
                info = el.info or {}
                bounds = info.get("bounds") or {}
                top = bounds.get("top", i)
            except Exception:
                bounds = {}

            if has_right:
                side = "me"
            elif has_left:
                side = "other"
            else:
                left = bounds.get("left", 0)
                right = bounds.get("right", 0)
                center = (left + right) / 2
                side = "me" if center >= mid else "other"

            bubbles.append(
                {
                    "id": make_message_key(side, text),
                    "side": side,
                    "text": text,
                    "index": i,
                    "top": top,
                }
            )
        except Exception:
            continue
    bubbles.sort(key=lambda b: (b.get("top", 0), b.get("index", 0)))
    return bubbles


def scroll_chat_to_bottom(d) -> None:
    """聊天列表滑到底，确保最新消息可见。"""
    w, h = d.window_size()
    safe_swipe(d, int(w * 0.5), int(h * 0.55), int(w * 0.5), int(h * 0.28), 0.2)
    time.sleep(0.35)


def read_chat_bubbles_retry(d, attempts: int = 3) -> List[Dict[str, Any]]:
    """进入聊天后多次读取；空则下滑再读。"""
    bubbles: List[Dict[str, Any]] = []
    for i in range(max(1, attempts)):
        if i > 0:
            scroll_chat_to_bottom(d)
            time.sleep(0.35)
        bubbles = read_chat_bubbles(d)
        if bubbles:
            return bubbles
        time.sleep(0.45)
    return bubbles


def detect_new_reply(
    bubbles: List[Dict[str, Any]],
    last_send_message_id: Optional[str] = None,
    last_send_texts: Optional[List[str]] = None,
) -> Tuple[bool, Optional[str]]:
    """进入聊天后读到的就是当前可见最新消息。

    规则：末条气泡是对方 → 已回复；末条是我 → 仍在等。
    """
    if not bubbles:
        return False, None
    last_b = bubbles[-1]
    if last_b.get("side") == "other":
        return True, last_b.get("id")
    return False, None


def bubbles_summary(bubbles: List[Dict[str, Any]], limit: int = 6) -> str:
    """日志用：末尾若干条 side:text。"""
    if not bubbles:
        return "empty"
    tail = bubbles[-limit:]
    parts = [f"{b.get('side')}:{(b.get('text') or '')[:20]}" for b in tail]
    return f"n={len(bubbles)} last=[{' | '.join(parts)}]"


def send_text(d, text: str) -> bool:
    edit = d(resourceId=RID("edit_btn"))
    if not edit.exists(timeout=2.0):
        return False
    if not safe_click_widget(d, edit):
        return False
    time.sleep(0.2)
    try:
        edit.set_text(text)
    except Exception:
        # 部分机型 set_text 失败：清空后 shell input 不可靠，直接失败重试
        return False
    time.sleep(0.3)
    send_btn = d(resourceId=RID("input_panel_send_btn"))
    if send_btn.exists(timeout=1.5):
        if safe_click_widget(d, send_btn):
            time.sleep(0.5)
            return True
    if d(text="发送").exists(timeout=0.8):
        if safe_click_widget(d, d(text="发送")):
            time.sleep(0.5)
            return True
    try:
        d.press("enter")
    except Exception:
        d.shell("input keyevent 66")
    time.sleep(0.5)
    return True


def go_back(d, settle: float = 0.35) -> None:
    back = d(resourceId=RID("rl_left_view"))
    if back.exists(timeout=0.8):
        if safe_click_widget(d, back):
            time.sleep(settle)
            return
    try:
        d.press("back")
    except Exception:
        d.shell("input keyevent 4")
    time.sleep(settle)


def ensure_message_list(d, timeout: float = 3.0) -> bool:
    """确保回到消息列表页。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.25):
            return True
        if is_chat_page(d):
            go_back(d, settle=0.4)
        time.sleep(0.2)
    return bool(d(resourceId=RID("rc_conversation_title")).exists(timeout=0.3))


def last_me_message_id(bubbles: List[Dict[str, Any]]) -> Optional[str]:
    for b in reversed(bubbles):
        if b.get("side") == "me":
            return b.get("id")
    return None
