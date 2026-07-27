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


def ensure_app(d, package: str = PKG) -> None:
    cur = d.app_current().get("package")
    if cur != package:
        d.app_start(package)
        time.sleep(2.0)


def open_message_tab(d) -> bool:
    # 底部消息 Tab（首页为图标，无「消息」文案）
    for rid in (RID("tab_message"), RID("flMessage")):
        tab = d(resourceId=rid)
        if tab.exists(timeout=1.2):
            tab.click()
            time.sleep(1.0)
            return True
    # 兜底：点文字「消息」（已在消息页标题时）
    if d(text="消息").exists(timeout=0.8):
        d(text="消息").click()
        time.sleep(1.0)
        return True
    return False


def collect_session_candidates(d, max_items: int = 30) -> List[Dict[str, Any]]:
    """从当前消息列表采集候选会话。返回 [{userId, displayName, raw}]"""
    out: List[Dict[str, Any]] = []
    seen = set()

    # 会话行标题
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
            # 过滤顶部非会话文案
            if name in ("消息", "请输入内容", "开启呼唤"):
                continue
            seen.add(name)
            uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
            out.append({"userId": uid, "displayName": name, "raw": name})
            if len(out) >= max_items:
                break
        except Exception:
            continue
    return out


def scroll_message_list(d) -> None:
    w, h = d.window_size()
    d.swipe(int(w * 0.5), int(h * 0.75), int(w * 0.5), int(h * 0.35), 0.25)
    time.sleep(0.6)


def open_session_by_name(d, display_name: str) -> bool:
    name = (display_name or "").strip()
    if not name:
        return False
    node = d(resourceId=RID("rc_conversation_title"), text=name)
    if node.exists(timeout=2.0):
        node.click()
        time.sleep(1.2)
        return True
    # 兜底 text
    if d(text=name).exists(timeout=1.0):
        d(text=name).click()
        time.sleep(1.2)
        return True
    return False


def read_chat_bubbles(d) -> List[Dict[str, Any]]:
    """读取聊天页可见气泡。side: me|other（右头像=me，左头像=other）。"""
    bubbles: List[Dict[str, Any]] = []
    w, _h = d.window_size()
    mid = w * 0.5

    # 遍历消息块：通过 portrait 左右判断
    items = d.xpath('//*[@resource-id="%s"]' % RID("rc_cl_content")).all()
    if not items:
        # 兜底：所有 my_text
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
                info = texts[i].info
                bounds = info.get("bounds") or {}
                left = bounds.get("left", 0)
                right = bounds.get("right", 0)
                center = (left + right) / 2
                side = "me" if center >= mid else "other"
                bubbles.append(
                    {
                        "id": make_message_key(side, t, i),
                        "side": side,
                        "text": t,
                        "index": i,
                    }
                )
            except Exception:
                continue
        return bubbles

    for i, item in enumerate(items):
        try:
            el = item.get()
            # left / right portrait
            has_right = el.xpath('.//*[@resource-id="%s"]' % RID("rc_right_portrait")).exists
            has_left = el.xpath('.//*[@resource-id="%s"]' % RID("rc_left_portrait")).exists
            text_node = el.xpath('.//*[@resource-id="%s"]' % RID("my_text"))
            text = ""
            if text_node.exists:
                text = (text_node.get_text() or "").strip()
            if not text:
                continue
            if has_right:
                side = "me"
            elif has_left:
                side = "other"
            else:
                side = "other"
            bubbles.append(
                {
                    "id": make_message_key(side, text, i),
                    "side": side,
                    "text": text,
                    "index": i,
                }
            )
        except Exception:
            continue
    return bubbles


def detect_new_reply(bubbles: List[Dict[str, Any]], last_send_message_id: Optional[str]) -> Tuple[bool, Optional[str]]:
    """是否存在对方新回复。"""
    last = last_send_message_id or ""
    # 找到 last send 在列表中的位置；其后若有 other 则视为新回复
    last_idx = -1
    for i, b in enumerate(bubbles):
        if b.get("id") == last or (last and str(b.get("id", "")).endswith(str(abs(hash(last))))):
            last_idx = i
    # 更稳妥：按顺序找「我方消息 id 匹配」之后的 other
    for i, b in enumerate(bubbles):
        if last and b.get("id") == last:
            last_idx = i
            break

    start = last_idx + 1 if last_idx >= 0 else 0
    # 若找不到 lastSend，则看末尾是否是对方消息（且有 lastSend 记录时才算）
    if last_idx < 0 and last:
        for b in reversed(bubbles):
            if b.get("side") == "other":
                # 对方消息存在，但无法与 lastSend 定位 → 用「对方最后一条」与 last 不同则算新
                rid = b.get("id")
                if rid and rid != last:
                    return True, rid
        return False, None

    for b in bubbles[start:]:
        if b.get("side") == "other":
            return True, b.get("id")
    # 无 lastSend（首轮 waiting 异常）时：末尾是对方也算
    if not last:
        for b in reversed(bubbles):
            if b.get("side") == "other":
                return True, b.get("id")
    return False, None


def send_text(d, text: str) -> bool:
    edit = d(resourceId=RID("edit_btn"))
    if not edit.exists(timeout=2.0):
        return False
    edit.click()
    time.sleep(0.2)
    edit.set_text(text)
    time.sleep(0.3)
    send_btn = d(resourceId=RID("input_panel_send_btn"))
    if send_btn.exists(timeout=1.5):
        send_btn.click()
        time.sleep(0.5)
        return True
    # 兜底
    if d(text="发送").exists(timeout=0.8):
        d(text="发送").click()
        time.sleep(0.5)
        return True
    d.press("enter")
    time.sleep(0.5)
    return True


def go_back(d) -> None:
    back = d(resourceId=RID("rl_left_view"))
    if back.exists(timeout=0.8):
        back.click()
        time.sleep(0.8)
        return
    d.press("back")
    time.sleep(0.8)


def last_me_message_id(bubbles: List[Dict[str, Any]]) -> Optional[str]:
    for b in reversed(bubbles):
        if b.get("side") == "me":
            return b.get("id")
    return None
