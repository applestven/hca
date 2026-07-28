"""Sub App UI 自动化（uiautomator2）。

说明：
- 选择器按 dump 的 resource-id 编写（com.MinorityCulture.MinorityCulture）。
- dry_run 模式不点真实 UI，仅走状态机。
- WiFi ADB 下每次 RPC 很贵：优先一次 dump_hierarchy 本地解析，减少 exists/xpath。
"""

from __future__ import annotations

import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional, Tuple

import uiautomator2 as u2

try:
    from api import make_message_key
except ImportError:
    from .api import make_message_key  # type: ignore

PKG = "com.MinorityCulture.MinorityCulture"
RID = lambda x: f"{PKG}:id/{x}"  # noqa: E731

_DIALOG_TEXTS = (
    "允许",
    "始终允许",
    "仅在使用中允许",
    "确定",
    "同意",
    "我知道了",
    "关闭",
    "跳过",
    "跳过广告",
    "关闭广告",
    "暂不",
    "以后再说",
    "我知道啦",
)
# 误进「发布图文」等页时的特征文案（用于 back 恢复）
_PUBLISH_PAGE_HINTS = (
    "发布图文",
    "发布动态",
    "选择图片",
    "添加图片",
    "写点什么",
    "说点什么",
    "发布作品",
)
_BOUNDS_RE = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")

_stop_checker = None
# 缓存最近一次 dump，短窗口内复用（列表采集→开会话）
_dump_cache: Dict[str, Any] = {"xml": "", "t": 0.0, "serial": ""}


def set_stop_checker(fn) -> None:
    """由 main 注入：等待期间检查是否请求停止。"""
    global _stop_checker
    _stop_checker = fn


def _emit_log(msg: str, step: str = "", **extra) -> None:
    payload: Dict[str, Any] = {"type": "log", "msg": msg}
    if step:
        payload["step"] = step
    if extra:
        payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def dbg_wait(tag: str, seconds: float, **extra) -> None:
    """带唯一标识的等待；日志里搜 waitTag / [WAIT:xxx] 即可定位。可被停止打断。"""
    sec = max(0.0, float(seconds))
    _emit_log(
        f"[WAIT:{tag}] sleep {sec:.3f}s",
        step="wait",
        waitTag=tag,
        waitSec=round(sec, 3),
        **extra,
    )
    end = time.time() + sec
    while True:
        if _stop_checker:
            _stop_checker()
        left = end - time.time()
        if left <= 0:
            break
        time.sleep(min(0.15, left))


def dbg_cost(tag: str, t0: float, **extra) -> float:
    """记录某段 UI/逻辑耗时（秒）；搜 costTag / [COST:xxx]。"""
    elapsed = max(0.0, time.time() - float(t0))
    _emit_log(
        f"[COST:{tag}] {elapsed:.3f}s",
        step="cost",
        costTag=tag,
        costSec=round(elapsed, 3),
        **extra,
    )
    return elapsed


def _device_key(d) -> str:
    try:
        return str(getattr(d, "serial", None) or getattr(d, "_serial", "") or id(d))
    except Exception:
        return str(id(d))


def dump_ui(d, max_age: float = 0.0) -> str:
    """一次 hierarchy dump；max_age>0 时短时复用缓存。"""
    global _dump_cache
    key = _device_key(d)
    now = time.time()
    if (
        max_age > 0
        and _dump_cache.get("serial") == key
        and _dump_cache.get("xml")
        and now - float(_dump_cache.get("t") or 0) <= max_age
    ):
        return str(_dump_cache["xml"])
    t0 = time.time()
    try:
        xml = d.dump_hierarchy(compressed=True)
    except TypeError:
        xml = d.dump_hierarchy()
    except Exception:
        xml = d.dump_hierarchy()
    xml = xml or ""
    _dump_cache = {"xml": xml, "t": time.time(), "serial": key}
    dbg_cost("UI_DUMP_HIERARCHY", t0, xmlLen=len(xml))
    return xml


def invalidate_dump_cache() -> None:
    _dump_cache["t"] = 0.0
    _dump_cache["xml"] = ""


def _parse_bounds(raw: str) -> Tuple[int, int, int, int]:
    m = _BOUNDS_RE.search(raw or "")
    if not m:
        return 0, 0, 0, 0
    return int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))


def _iter_nodes(xml: str):
    if not xml:
        return
    try:
        root = ET.fromstring(xml)
    except Exception:
        return
    for node in root.iter("node"):
        yield node


def connect_device(serial: Optional[str] = None):
    t0 = time.time()
    try:
        if serial:
            d = u2.connect(serial)
        else:
            d = u2.connect_usb()
        return d
    finally:
        dbg_cost("UI_CONNECT_DEVICE", t0, serial=serial or "")


def safe_tap(d, x: int, y: int) -> bool:
    """优先 u2 点击；无 INJECT_EVENTS 时回退 adb shell input tap。"""
    try:
        d.click(int(x), int(y))
        invalidate_dump_cache()
        return True
    except Exception:
        pass
    try:
        d.shell(f"input tap {int(x)} {int(y)}")
        invalidate_dump_cache()
        return True
    except Exception:
        return False


def safe_swipe(d, x1: int, y1: int, x2: int, y2: int, duration: float = 0.25) -> bool:
    """优先 u2 swipe；Permission/INJECT_EVENTS 失败时用 shell input swipe。"""
    try:
        d.swipe(int(x1), int(y1), int(x2), int(y2), duration)
        invalidate_dump_cache()
        return True
    except Exception:
        pass
    try:
        ms = max(50, int(float(duration) * 1000))
        d.shell(f"input swipe {int(x1)} {int(y1)} {int(x2)} {int(y2)} {ms}")
        invalidate_dump_cache()
        return True
    except Exception:
        return False


def safe_click_widget(d, widget) -> bool:
    """点击控件；失败则按 bounds 中心 shell tap。"""
    try:
        widget.click()
        invalidate_dump_cache()
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
    """一次 dump 扫弹窗/广告跳过文案；无命中时避免多次 exists RPC。"""
    t0 = time.time()
    clicked = 0
    try:
        xml = dump_ui(d, max_age=0)
        hits = [t for t in _DIALOG_TEXTS if f'text="{t}"' in xml]
        if not hits:
            dbg_cost("UI_DISMISS_DIALOGS", t0, clicked=0, skipped=True)
            return
        for t in hits:
            try:
                n = d(text=t)
                if n.exists(timeout=0):
                    safe_click_widget(d, n)
                    clicked += 1
                    dbg_wait("UI_DISMISS_DIALOG", 0.12, dialogText=t)
            except Exception:
                continue
    except Exception:
        for t in _DIALOG_TEXTS:
            try:
                n = d(text=t)
                if n.exists(timeout=0):
                    safe_click_widget(d, n)
                    clicked += 1
                    dbg_wait("UI_DISMISS_DIALOG", 0.12, dialogText=t)
            except Exception:
                continue
    dbg_cost("UI_DISMISS_DIALOGS", t0, clicked=clicked, skipped=False)


def _xml_has_main_chrome(xml: str) -> bool:
    """主壳是否已出（底部消息 Tab / 会话列表），广告页通常没有这些 id。"""
    if not xml:
        return False
    markers = (
        f'resource-id="{RID("rc_conversation_title")}"',
        f'resource-id="{RID("tab_message")}"',
        f'resource-id="{RID("flMessage")}"',
        'text="消息"',
    )
    return any(m in xml for m in markers)


def _xml_looks_like_publish(xml: str) -> bool:
    if not xml:
        return False
    return any(f'text="{t}"' in xml for t in _PUBLISH_PAGE_HINTS)


def is_publish_page(d) -> bool:
    try:
        return _xml_looks_like_publish(dump_ui(d, max_age=0.3))
    except Exception:
        return False


def recover_if_publish_page(d) -> bool:
    """若误进发布图文等页，按返回直到离开。返回是否曾恢复。"""
    recovered = False
    for i in range(3):
        if not is_publish_page(d):
            break
        recovered = True
        _emit_log(f"检测到发布页，返回({i + 1}/3)", step="recover_publish")
        go_back(d, settle=0.35, wait_tag="UI_RECOVER_PUBLISH")
        invalidate_dump_cache()
    return recovered


def wait_home_ready(d, timeout: float = 12.0) -> bool:
    """冷启动后等广告/闪屏结束，直到主壳或消息列表出现。

    Sub 冷启动常见 ~5s 广告；期间点坐标极易误进「发布」。
    """
    t0 = time.time()
    deadline = time.time() + max(1.0, float(timeout))
    poll_n = 0
    ready = False
    while time.time() < deadline:
        poll_n += 1
        try:
            dismiss_blocking_dialogs(d)
        except Exception:
            pass
        if _looks_like_sub_app(d):
            ready = True
            break
        try:
            xml = dump_ui(d, max_age=0)
            if _xml_has_main_chrome(xml):
                ready = True
                break
            if _xml_looks_like_publish(xml):
                recover_if_publish_page(d)
        except Exception:
            pass
        dbg_wait("UI_WAIT_HOME_READY", 0.45, poll=poll_n)
    dbg_cost("UI_WAIT_HOME_READY", t0, ready=ready, polls=poll_n, timeout=timeout)
    return ready


def _find_message_tab_point(xml: str, screen_h: int) -> Optional[Tuple[int, int]]:
    """从 dump 找底部「消息」Tab 中心点；忽略页面中部同名文案。"""
    if not xml or screen_h <= 0:
        return None
    y_min = int(screen_h * 0.82)
    best = None  # (y, x, cy)
    for node in _iter_nodes(xml) or []:
        text = (node.attrib.get("text") or "").strip()
        desc = (node.attrib.get("content-desc") or "").strip()
        rid = node.attrib.get("resource-id") or ""
        is_msg_tab = text == "消息" or desc == "消息" or rid.endswith(":id/tab_message") or rid.endswith(
            ":id/flMessage"
        )
        if not is_msg_tab:
            continue
        left, top, right, bottom = _parse_bounds(node.attrib.get("bounds") or "")
        if right <= left or bottom <= top:
            continue
        cy = (top + bottom) // 2
        cx = (left + right) // 2
        # 底部 Tab 优先；非底部仅当 resource-id 明确是 tab
        if cy < y_min and not (rid.endswith(":id/tab_message") or rid.endswith(":id/flMessage")):
            continue
        if best is None or cy > best[0]:
            best = (cy, cx, cy)
    if not best:
        return None
    return best[1], best[2]


def _current_package(d) -> Optional[str]:
    try:
        return (d.app_current() or {}).get("package")
    except Exception:
        return None


def _looks_like_sub_app(d) -> bool:
    """用短 exists 判断是否已在 Sub（比 app_current 在 WiFi 下快很多）。"""
    for rid in (
        RID("rc_conversation_title"),
        RID("tab_message"),
        RID("flMessage"),
        RID("edit_btn"),
    ):
        try:
            if d(resourceId=rid).exists(timeout=0.08):
                return True
        except Exception:
            continue
    return False


def _fast_app_start(d, package: str) -> str:
    """尽快把 App 拉到前台。避免 u2 app_start(wait=True) 在 WiFi 下卡很久。"""
    t0 = time.time()
    method = "none"
    try:
        d.shell(
            f"monkey -p {package} -c android.intent.category.LAUNCHER 1",
            timeout=5,
        )
        method = "monkey"
    except Exception:
        try:
            d.shell(
                f"am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p {package}",
                timeout=5,
            )
            method = "am_start"
        except Exception:
            try:
                d.app_start(package, wait=False, stop=False)
                method = "u2_nowait"
            except TypeError:
                try:
                    d.app_start(package, stop=False)
                    method = "u2_stop_false"
                except Exception:
                    d.app_start(package)
                    method = "u2_default"
            except Exception:
                try:
                    d.app_start(package)
                    method = "u2_default"
                except Exception:
                    method = "fail"
    dbg_cost("UI_FAST_APP_START", t0, package=package, method=method)
    invalidate_dump_cache()
    return method


def ensure_app(d, package: str = PKG) -> Dict[str, Any]:
    """确保目标 App 在前台。已在前台则几乎零耗时。"""
    t0 = time.time()
    # 不走 app_current（WiFi 下单次可 >2s，轮询会到 15s）
    if _looks_like_sub_app(d):
        dbg_cost(
            "UI_ENSURE_APP",
            t0,
            targetPackage=package,
            started=False,
            foreground=True,
            via="ui_exists",
        )
        return {"appPackage": package, "started": False, "foreground": True}

    started = True
    _fast_app_start(d, package)
    # 冷启动常有广告：短 settle 不够，交给 wait_home_ready
    dbg_wait("UI_ENSURE_APP_SETTLE", 0.5, package=package)
    foreground = wait_home_ready(d, timeout=10.0)
    if not foreground:
        _fast_app_start(d, package)
        dbg_wait("UI_ENSURE_APP_RETRY_SETTLE", 0.4, package=package)
        foreground = wait_home_ready(d, timeout=8.0)

    dbg_cost(
        "UI_ENSURE_APP",
        t0,
        targetPackage=package,
        started=started,
        foreground=foreground,
        via="fast_start_wait_home",
    )
    return {
        "appPackage": package if foreground else "",
        "started": started,
        "foreground": foreground,
    }


def open_message_tab(d) -> bool:
    """打开消息 Tab。禁止盲点屏幕中下部中心（易进「发布图文」）。"""
    t0 = time.time()
    path = "unknown"
    ok = False
    try:
        recover_if_publish_page(d)

        # 最快路径：已在消息列表
        if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.15):
            path = "already_on_list"
            ok = True
            return True

        for rid in (RID("tab_message"), RID("flMessage")):
            tab = d(resourceId=rid)
            if tab.exists(timeout=0.25):
                if safe_click_widget(d, tab):
                    dbg_wait("UI_MSG_TAB_RID_CLICK", 0.4, resourceId=rid)
                    if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.8):
                        path = f"rid:{rid}"
                        ok = True
                        return True

        # dump 定位底部「消息」——比 text exists + 盲坐标更稳
        try:
            w, h = d.window_size()
        except Exception:
            w, h = 0, 0
        xml = dump_ui(d, max_age=0)
        if _xml_looks_like_publish(xml):
            recover_if_publish_page(d)
            xml = dump_ui(d, max_age=0)

        pt = _find_message_tab_point(xml, h or 1920)
        if pt:
            safe_tap(d, pt[0], pt[1])
            dbg_wait("UI_MSG_TAB_DUMP_CLICK", 0.45, x=pt[0], y=pt[1])
            if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.9):
                path = f"dump_point:{pt[0]},{pt[1]}"
                ok = True
                return True

        # text=消息（可能匹配到非底部；仍试一次）
        if d(text="消息").exists(timeout=0.25):
            if safe_click_widget(d, d(text="消息")):
                dbg_wait("UI_MSG_TAB_TEXT_CLICK", 0.4)
                if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.8):
                    path = "text:消息"
                    ok = True
                    return True
                # 若点错进了发布页，立刻退回
                if recover_if_publish_page(d):
                    path = "text:消息->publish_recovered"

        # 最后兜底：五 Tab 布局里「消息」通常在倒数第二（约 0.7），绝不点 0.5 中心（发布）
        if w and h:
            for idx, x_ratio in enumerate((0.70, 0.78, 0.62)):
                safe_tap(d, int(w * x_ratio), int(h * 0.945))
                dbg_wait("UI_MSG_TAB_COORD_FALLBACK", 0.35, attempt=idx, xRatio=x_ratio)
                if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.55):
                    path = f"coord:{x_ratio}"
                    ok = True
                    return True
                if recover_if_publish_page(d):
                    path = f"coord:{x_ratio}->publish_recovered"
                    continue

        ok = bool(d(resourceId=RID("rc_conversation_title")).exists(timeout=0.2))
        path = "final_exists" if ok else "fail"
        return ok
    finally:
        dbg_cost("UI_OPEN_MESSAGE_TAB", t0, path=path, ok=ok)


def _parse_unread_count(text: str) -> int:
    """解析未读数字；红点无文字 / 99+ 等也算有未读。"""
    t = (text or "").strip()
    if not t:
        return 1
    if t.isdigit():
        return max(1, int(t))
    # 99+、10+ 等
    digits = "".join(ch for ch in t if ch.isdigit())
    if digits:
        return max(1, int(digits))
    return 1


def collect_session_candidates(
    d, max_items: int = 30, unread_only: bool = False
) -> List[Dict[str, Any]]:
    """从当前消息列表采集候选会话。

    unread_only=True 时只返回带未读气泡的会话（红点/数字）。
    """
    t0 = time.time()
    out: List[Dict[str, Any]] = []
    seen = set()
    path = "empty"

    try:
        t_dump = time.time()
        xml = dump_ui(d, max_age=0)
        # 先按会话 item 子树配对标题+未读（最准）
        try:
            root = ET.fromstring(xml) if xml else None
        except Exception:
            root = None

        if root is not None:
            item_rid = RID("rc_conversation_item")
            title_rid = RID("rc_conversation_title")
            unread_rid = RID("rc_conversation_unread_count")
            for item in root.iter("node"):
                if (item.attrib.get("resource-id") or "") != item_rid:
                    continue
                name = ""
                unread = 0
                title_top = 0
                for child in item.iter("node"):
                    rid = child.attrib.get("resource-id") or ""
                    text = (child.attrib.get("text") or "").strip()
                    if rid == title_rid and text:
                        name = text
                        _l, title_top, _r, _b = _parse_bounds(child.attrib.get("bounds") or "")
                    elif rid == unread_rid:
                        left, top, right, bottom = _parse_bounds(child.attrib.get("bounds") or "")
                        # 可见红点（有面积）即算未读；不必有数字
                        if right > left and bottom > top:
                            unread = max(unread, _parse_unread_count(text))
                        elif text:
                            unread = max(unread, _parse_unread_count(text))
                if not name or name in ("消息", "请输入内容", "开启呼唤"):
                    continue
                if name in seen:
                    continue
                if unread_only and unread <= 0:
                    continue
                seen.add(name)
                uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
                out.append(
                    {
                        "userId": uid,
                        "displayName": name,
                        "raw": name,
                        "unread": unread,
                        "preview": "",
                    }
                )
                if len(out) >= max_items:
                    break
            if out:
                path = "dump_items"
                dbg_cost(
                    "UI_COLLECT_FROM_DUMP",
                    t_dump,
                    outCount=len(out),
                    unreadOnly=unread_only,
                    path=path,
                )
                return out

        # 回退：扁平标题 + 未读按 Y 对齐
        titles: List[Tuple[str, int, int]] = []
        unreads: List[Tuple[int, int, int]] = []  # top, left, count
        for node in _iter_nodes(xml) or []:
            rid = node.attrib.get("resource-id") or ""
            text = (node.attrib.get("text") or "").strip()
            left, top, right, bottom = _parse_bounds(node.attrib.get("bounds") or "")
            if rid == RID("rc_conversation_title") and text:
                if text in ("消息", "请输入内容", "开启呼唤"):
                    continue
                titles.append((text, top, left))
            elif rid == RID("rc_conversation_unread_count"):
                if right > left and bottom > top:
                    unreads.append((top, left, _parse_unread_count(text)))
                elif text:
                    unreads.append((top, left, _parse_unread_count(text)))

        for name, top, left in titles:
            if name in seen:
                continue
            unread = 0
            best = None
            for ut, ul, uc in unreads:
                # 同一行：未读角标通常在标题右侧附近
                if abs(ut - top) <= 80:
                    dist = abs(ut - top) * 3 + abs(ul - left)
                    if best is None or dist < best[0]:
                        best = (dist, uc)
            if best:
                unread = best[1]
            if unread_only and unread <= 0:
                continue
            seen.add(name)
            uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
            out.append(
                {
                    "userId": uid,
                    "displayName": name,
                    "raw": name,
                    "unread": unread,
                    "preview": "",
                }
            )
            if len(out) >= max_items:
                break

        dbg_cost(
            "UI_COLLECT_FROM_DUMP",
            t_dump,
            titleCount=len(titles),
            unreadBadgeCount=len(unreads),
            outCount=len(out),
            unreadOnly=unread_only,
        )
        if out:
            path = "dump_titles"
            return out

        # 最后兜底：用 selector 扫未读节点再找同行标题（仅 unread_only）
        if unread_only:
            t_fb = time.time()
            try:
                badges = d(resourceId=RID("rc_conversation_unread_count"))
                bcount = int(badges.count or 0)
            except Exception:
                bcount = 0
            for i in range(min(bcount, max_items)):
                try:
                    b = badges[i]
                    info = b.info or {}
                    bounds = info.get("bounds") or {}
                    btop = int(bounds.get("top", 0))
                    bleft = int(bounds.get("left", 0))
                    raw = (b.get_text() or "").strip()
                    unread = _parse_unread_count(raw)
                    # 找同 Y 的标题
                    name = ""
                    titles_nodes = d(resourceId=RID("rc_conversation_title"))
                    tcount = int(titles_nodes.count or 0)
                    best_name = None
                    best_dist = None
                    for j in range(min(tcount, 40)):
                        tn = titles_nodes[j]
                        tinfo = tn.info or {}
                        tb = tinfo.get("bounds") or {}
                        ttop = int(tb.get("top", 0))
                        tleft = int(tb.get("left", 0))
                        if abs(ttop - btop) > 80:
                            continue
                        dist = abs(ttop - btop) * 3 + abs(tleft - bleft)
                        n = (tn.get_text() or "").strip()
                        if not n or n in ("消息", "请输入内容", "开启呼唤"):
                            continue
                        if best_dist is None or dist < best_dist:
                            best_dist = dist
                            best_name = n
                    name = best_name or ""
                    if not name or name in seen:
                        continue
                    seen.add(name)
                    uid = "sub_" + hashlib.md5(name.encode("utf-8")).hexdigest()[:16]
                    out.append(
                        {
                            "userId": uid,
                            "displayName": name,
                            "raw": name,
                            "unread": unread,
                            "preview": "",
                        }
                    )
                    if len(out) >= max_items:
                        break
                except Exception:
                    continue
            path = "unread_badge_fallback" if out else "empty"
            dbg_cost("UI_COLLECT_UNREAD_FALLBACK", t_fb, outCount=len(out), badgeCount=bcount)
            return out

        path = "empty"
        return out
    finally:
        dbg_cost(
            "UI_COLLECT_SESSION_CANDIDATES",
            t0,
            outCount=len(out),
            path=path,
            unreadOnly=unread_only,
        )


def scroll_message_list(d) -> None:
    w, h = d.window_size()
    safe_swipe(d, int(w * 0.5), int(h * 0.75), int(w * 0.5), int(h * 0.35), 0.2)
    dbg_wait("UI_SCROLL_MSG_LIST", 0.25)


def is_chat_page(d) -> bool:
    """是否已在聊天输入页（有编辑框）。"""
    return bool(d(resourceId=RID("edit_btn")).exists(timeout=0.12))


def wait_chat_ready(d, expected_name: Optional[str] = None, timeout: float = 2.0) -> bool:
    """等待进入聊天页；可选校验标题。"""
    t0 = time.time()
    deadline = time.time() + timeout
    poll_n = 0
    ok = False
    try:
        while time.time() < deadline:
            poll_n += 1
            if is_chat_page(d):
                if expected_name:
                    title = d(resourceId=RID("tv_toolbar_title"))
                    if title.exists(timeout=0.08):
                        t = (title.get_text() or "").strip()
                        if t == expected_name.strip():
                            ok = True
                            return True
                        dbg_wait(
                            "UI_WAIT_CHAT_TITLE_MISMATCH",
                            0.08,
                            poll=poll_n,
                            expected=expected_name,
                            actual=t,
                        )
                        continue
                ok = True
                return True
            dbg_wait("UI_WAIT_CHAT_PAGE_POLL", 0.1, poll=poll_n, expected=expected_name or "")
        ok = is_chat_page(d)
        return ok
    finally:
        dbg_cost(
            "UI_WAIT_CHAT_READY",
            t0,
            poll=poll_n,
            ok=ok,
            expected=expected_name or "",
            timeout=timeout,
        )


def open_session_by_name(d, display_name: str) -> bool:
    """打开会话。优先 dump 取 bounds 点击；避免昂贵 xpath.all。"""
    t0 = time.time()
    name = (display_name or "").strip()
    path = "not_found"
    ok = False
    if not name:
        dbg_cost("UI_OPEN_SESSION_BY_NAME", t0, path="empty_name", ok=False, name="")
        return False

    try:
        if is_chat_page(d):
            title = d(resourceId=RID("tv_toolbar_title"))
            if title.exists(timeout=0.12):
                t = (title.get_text() or "").strip()
                if t == name:
                    path = "already_in_chat"
                    ok = True
                    return True
                go_back(d, settle=0.25, wait_tag="UI_OPEN_LEAVE_WRONG_CHAT")
                dbg_wait("UI_OPEN_AFTER_LEAVE_WRONG_CHAT", 0.15, expected=name, was=t)

        xml = dump_ui(d, max_age=1.2)
        for node in _iter_nodes(xml) or []:
            rid = node.attrib.get("resource-id") or ""
            text = (node.attrib.get("text") or "").strip()
            if rid == RID("rc_conversation_title") and text == name:
                left, top, right, bottom = _parse_bounds(node.attrib.get("bounds") or "")
                if right > left and bottom > top:
                    cx = (left + right) // 2
                    cy = (top + bottom) // 2
                    safe_tap(d, cx, cy)
                    if wait_chat_ready(d, expected_name=name, timeout=2.2):
                        path = "dump_tap_title"
                        ok = True
                        return True
                    path = "dump_tap_not_ready"
                    break

        node = d(resourceId=RID("rc_conversation_title"), text=name)
        if node.exists(timeout=0.5):
            safe_click_widget(d, node)
            if wait_chat_ready(d, expected_name=name, timeout=2.0):
                path = "click_title"
                ok = True
                return True
            path = "click_title_not_ready"

        if d(text=name).exists(timeout=0.35):
            safe_click_widget(d, d(text=name))
            if wait_chat_ready(d, expected_name=name, timeout=2.0):
                path = "click_text"
                ok = True
                return True
            path = "click_text_not_ready"
        return False
    finally:
        dbg_cost("UI_OPEN_SESSION_BY_NAME", t0, path=path, ok=ok, name=name)


def _bubble_from_bounds(text: str, left: int, right: int, top: int, index: int, mid: float) -> Dict[str, Any]:
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
    """读取聊天页可见气泡。优先一次 dump 解析 my_text。"""
    t0 = time.time()
    bubbles: List[Dict[str, Any]] = []
    path = "empty"
    try:
        try:
            w, _h = d.window_size()
        except Exception:
            w = 1080
        mid = w * 0.5

        xml = dump_ui(d, max_age=0)
        idx = 0
        for node in _iter_nodes(xml) or []:
            rid = node.attrib.get("resource-id") or ""
            if rid != RID("my_text"):
                continue
            text = (node.attrib.get("text") or "").strip()
            if not text:
                continue
            left, top, right, _bottom = _parse_bounds(node.attrib.get("bounds") or "")
            bubbles.append(_bubble_from_bounds(text, left, right, top, idx, mid))
            idx += 1

        if bubbles:
            bubbles.sort(key=lambda b: (b.get("top", 0), b.get("index", 0)))
            path = "dump_my_text"
            return bubbles

        texts = d(resourceId=RID("my_text"))
        try:
            n = min(int(texts.count or 0), 12)
        except Exception:
            n = 0
        for i in range(n):
            try:
                t = (texts[i].get_text() or "").strip()
                if not t:
                    continue
                info = texts[i].info or {}
                bounds = info.get("bounds") or {}
                bubbles.append(
                    _bubble_from_bounds(
                        t,
                        int(bounds.get("left", 0)),
                        int(bounds.get("right", 0)),
                        int(bounds.get("top", i)),
                        i,
                        mid,
                    )
                )
            except Exception:
                continue
        if bubbles:
            bubbles.sort(key=lambda b: (b.get("top", 0), b.get("index", 0)))
            path = "my_text_rpc"
        return bubbles
    finally:
        dbg_cost("UI_READ_CHAT_BUBBLES", t0, bubbleCount=len(bubbles), path=path)


def scroll_chat_to_bottom(d) -> None:
    """聊天列表滑到底，确保最新消息可见。"""
    w, h = d.window_size()
    safe_swipe(d, int(w * 0.5), int(h * 0.55), int(w * 0.5), int(h * 0.28), 0.15)
    dbg_wait("UI_SCROLL_CHAT_BOTTOM", 0.12)


def read_chat_bubbles_retry(d, attempts: int = 2) -> List[Dict[str, Any]]:
    """进入聊天后多次读取；空则下滑再读。"""
    bubbles: List[Dict[str, Any]] = []
    for i in range(max(1, attempts)):
        if i > 0:
            scroll_chat_to_bottom(d)
            dbg_wait("UI_BUBBLE_RETRY_AFTER_SCROLL", 0.12, attempt=i)
        bubbles = read_chat_bubbles(d)
        if bubbles:
            return bubbles
        dbg_wait("UI_BUBBLE_RETRY_EMPTY", 0.2, attempt=i)
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
    t0 = time.time()
    path = "fail"
    ok = False
    try:
        t_edit = time.time()
        edit = d(resourceId=RID("edit_btn"))
        if not edit.exists(timeout=1.0):
            path = "no_edit"
            return False
        dbg_cost("UI_SEND_FIND_EDIT", t_edit)
        if not safe_click_widget(d, edit):
            path = "focus_fail"
            return False
        dbg_wait("UI_SEND_AFTER_FOCUS_EDIT", 0.08)
        t_set = time.time()
        try:
            edit.set_text(text)
        except Exception:
            path = "set_text_fail"
            return False
        dbg_cost("UI_SEND_SET_TEXT", t_set, textPreview=(text or "")[:40])
        dbg_wait("UI_SEND_AFTER_SET_TEXT", 0.1, textPreview=(text or "")[:40])
        send_btn = d(resourceId=RID("input_panel_send_btn"))
        if send_btn.exists(timeout=0.8):
            if safe_click_widget(d, send_btn):
                dbg_wait("UI_SEND_AFTER_SEND_BTN", 0.2)
                path = "send_btn"
                ok = True
                return True
        if d(text="发送").exists(timeout=0.35):
            if safe_click_widget(d, d(text="发送")):
                dbg_wait("UI_SEND_AFTER_SEND_TEXT", 0.2)
                path = "send_text"
                ok = True
                return True
        try:
            d.press("enter")
        except Exception:
            d.shell("input keyevent 66")
        dbg_wait("UI_SEND_AFTER_ENTER_KEY", 0.2)
        path = "enter_key"
        ok = True
        return True
    finally:
        dbg_cost("UI_SEND_TEXT", t0, path=path, ok=ok, textPreview=(text or "")[:40])


def go_back(d, settle: float = 0.2, wait_tag: str = "UI_GO_BACK") -> None:
    back = d(resourceId=RID("rl_left_view"))
    if back.exists(timeout=0.35):
        if safe_click_widget(d, back):
            dbg_wait(f"{wait_tag}_BTN", settle)
            return
    try:
        d.press("back")
    except Exception:
        d.shell("input keyevent 4")
    dbg_wait(f"{wait_tag}_PRESS", settle)


def ensure_message_list(d, timeout: float = 2.0) -> bool:
    """确保回到消息列表页。"""
    deadline = time.time() + timeout
    poll_n = 0
    while time.time() < deadline:
        poll_n += 1
        if d(resourceId=RID("rc_conversation_title")).exists(timeout=0.12):
            return True
        if is_chat_page(d):
            go_back(d, settle=0.2, wait_tag="UI_ENSURE_LIST_FROM_CHAT")
        dbg_wait("UI_ENSURE_MSG_LIST_POLL", 0.1, poll=poll_n)
    return bool(d(resourceId=RID("rc_conversation_title")).exists(timeout=0.15))


def last_me_message_id(bubbles: List[Dict[str, Any]]) -> Optional[str]:
    for b in reversed(bubbles):
        if b.get("side") == "me":
            return b.get("id")
    return None
