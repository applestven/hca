"""Soul 循环匹配打招呼

流程（每轮）：
1. 确保 Soul 在前台
2. 优先点「立即私聊」，否则 星球 → 灵魂匹配，进入聊天页
3. 发送打招呼内容（空则默认「吃瓜」表情）
4. 返回，进入下一轮
"""

from __future__ import annotations

import os
import sys
import time
from typing import Optional

import uiautomator2 as u2

# 优先复用 scripts/soul，否则回退到 codeApp/soul
_CANDIDATES = [
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "soul")),
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "soul")),
]
_SOUL_DIR = next((p for p in _CANDIDATES if os.path.isdir(os.path.join(p, "common"))), None)
if not _SOUL_DIR:
    raise RuntimeError("找不到 soul/common，请确认 scripts/soul 或 scripts/codeApp/soul 存在")
if _SOUL_DIR not in sys.path:
    sys.path.insert(0, _SOUL_DIR)

import common.sendMsgSoul as sendMsgSoul  # noqa: E402
import common.utils as utils  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PACKAGE_NAME = "cn.soulapp.android"
EMOJI_BTN_ID = "cn.soulapp.android:id/menu_tab_emoji"
DEFAULT_EMOJI = "吃瓜"
DEFAULT_INTERVAL = 3


def connect_device():
    serial = (
        os.environ.get("device")
        or os.environ.get("HCA_DEVICE_SERIAL")
        or os.environ.get("ANDROID_SERIAL")
    )
    if serial:
        return u2.connect(serial)
    return u2.connect_usb()


def ensure_app_foreground(d) -> bool:
    is_foreground = d.app_current().get("package") == PACKAGE_NAME
    if not is_foreground:
        d.app_start(PACKAGE_NAME)
        time.sleep(2)
    return is_foreground


def handle_first_launch_popups(d) -> None:
    utils.click_element(d, "我知道了")
    utils.click_skip_coordinate(d)


def goto_match_chat(d, timeout: float = 60) -> bool:
    """进入灵魂匹配聊天页。成功返回 True。"""
    if utils.click_element(d, "立即私聊", timeout=2):
        print("点击「立即私聊」")
    else:
        utils.click_element(d, "星球")
        if not utils.click_element(d, "灵魂匹配"):
            print("未找到「灵魂匹配」")
            return False

    deadline = time.time() + timeout
    while time.time() < deadline:
        if utils.is_chat_page2(d) or utils.is_chat_page(d):
            print("已进入聊天页")
            return True
        utils.click_element(d, "立即私聊", timeout=0.5)
        time.sleep(1)

    print("等待进入聊天页超时")
    return False


def _open_emoji_panel(d) -> bool:
    btn = d(resourceId=EMOJI_BTN_ID)
    if not btn.exists:
        btn = d(description="表情")
    if not btn.exists:
        print("未找到表情按钮")
        return False
    btn.click()
    time.sleep(0.6)
    return True


def _click_emoji(d, name: str) -> bool:
    """在表情面板中点击指定表情（按 description / text / contentDescription）。"""
    candidates = [
        d(description=name),
        d(text=name),
        d(descriptionContains=name),
        d(textContains=name),
    ]
    for el in candidates:
        if el.exists:
            el.click()
            time.sleep(0.4)
            print(f"已点击表情: {name}")
            return True
    return False


def send_emoji(d, name: str = DEFAULT_EMOJI) -> bool:
    """发送表情包：优先点表情面板，失败则发送 [名称] 文本兜底。"""
    name = (name or DEFAULT_EMOJI).strip() or DEFAULT_EMOJI

    if _open_emoji_panel(d) and _click_emoji(d, name):
        # 部分表情点选后已直接发出；若输入框仍有内容则点发送
        input_box = d(resourceId="cn.soulapp.android:id/et_sendmessage")
        if input_box.exists:
            current = (input_box.get_text() or "").strip()
            if current and (name in current or f"[{name}]" in current):
                if d(text="发送").exists:
                    utils.click_element(d, "发送")
                else:
                    d.press("enter")
                time.sleep(0.5)
        print(f"表情包发送成功: {name}")
        return True

    # 兜底：Soul 常用 [吃瓜] 文本码发送表情
    code = f"[{name}]"
    print(f"面板未找到「{name}」，改用文本发送: {code}")
    ok = sendMsgSoul.send_message(d, code)
    print("表情文本发送成功" if ok else "表情发送失败")
    return ok


def send_greet(d, content: Optional[str] = None) -> bool:
    """发送打招呼内容。空内容 → 默认「吃瓜」表情；有内容 → 按文本发送。"""
    text = (content or "").strip()
    if not text:
        print("打招呼内容为空，使用默认吃瓜表情")
        return send_emoji(d, DEFAULT_EMOJI)

    # 支持直接填 [吃瓜] 这类表情码
    if text.startswith("[") and text.endswith("]") and len(text) > 2:
        name = text[1:-1].strip() or DEFAULT_EMOJI
        return send_emoji(d, name)

    print(f"发送打招呼文本: {text}")
    ok = sendMsgSoul.send_message(d, text)
    print("打招呼发送成功" if ok else "打招呼发送失败")
    return ok


def one_round(d, *, content: Optional[str] = None) -> bool:
    """完成一轮：匹配 → 打招呼 → 返回。"""
    was_foreground = ensure_app_foreground(d)
    if not was_foreground:
        handle_first_launch_popups(d)

    if not goto_match_chat(d):
        return False

    ok = send_greet(d, content)
    sendMsgSoul.go_back(d)
    time.sleep(0.8)
    return ok


def run(loop: int, interval: float = DEFAULT_INTERVAL, *, content: Optional[str] = None) -> None:
    if loop is None or int(loop) < 1:
        raise ValueError("循环次数(loop)为必填，且必须 >= 1")

    loop = int(loop)
    d = connect_device()
    greet_desc = (content or "").strip() or f"默认表情[{DEFAULT_EMOJI}]"
    print(f"设备连接成功: {d}，共循环 {loop} 次，内容={greet_desc!r}")

    for i in range(loop):
        print(f"===== 第 {i + 1}/{loop} 轮：匹配打招呼 =====")
        ok = one_round(d, content=content)
        print(f"第 {i + 1} 轮结果: {'成功' if ok else '失败'}")
        if i < loop - 1:
            time.sleep(interval)


if __name__ == "__main__":
    run(loop=5)
