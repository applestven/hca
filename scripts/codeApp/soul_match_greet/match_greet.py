"""Soul 循环匹配打招呼

流程（每轮）：
1. 确保 Soul 在前台
2. 优先点「立即私聊」，否则 星球 → 灵魂匹配，进入聊天页
3. 发送打招呼内容（空则默认「[吃瓜]」文本表情码）
4. 返回，进入下一轮

日志：全部走 JSON emit，供中控实时展示步骤。
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional

import uiautomator2 as u2

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

PACKAGE_NAME = "cn.soulapp.android"
DEFAULT_EMOJI = "吃瓜"
DEFAULT_INTERVAL = 1.2


def emit(obj: dict) -> None:
    """结构化日志，主进程按 JSON 行解析后推到 UI。"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def log(msg: str, *, step: str = "", **extra) -> None:
    payload = {"type": "log", "msg": msg}
    if step:
        payload["step"] = step
    if extra:
        payload.update(extra)
    emit(payload)


def warn(msg: str, *, step: str = "", **extra) -> None:
    payload = {"type": "log", "level": "warn", "msg": msg}
    if step:
        payload["step"] = step
    if extra:
        payload.update(extra)
    emit(payload)


def connect_device():
    serial = (
        os.environ.get("device")
        or os.environ.get("HCA_DEVICE_SERIAL")
        or os.environ.get("ANDROID_SERIAL")
    )
    log(f"连接设备 serial={serial or '(usb)'}", step="connect")
    if serial:
        return u2.connect(serial)
    return u2.connect_usb()


def ensure_app_foreground(d) -> bool:
    cur = d.app_current().get("package")
    is_foreground = cur == PACKAGE_NAME
    if not is_foreground:
        log(f"Soul 不在前台(当前={cur})，正在拉起", step="foreground")
        d.app_start(PACKAGE_NAME)
        time.sleep(1.2)
    else:
        log("Soul 已在前台", step="foreground")
    return is_foreground


def _click_text(d, text: str, timeout: float = 1.5) -> bool:
    if d(text=text).wait(timeout=timeout):
        d(text=text).click()
        return True
    return False


def handle_first_launch_popups(d) -> None:
    log("处理可能的启动弹窗", step="popup")
    # 短超时：没有弹窗时尽快继续
    if d(text="我知道了").wait(timeout=0.6):
        d(text="我知道了").click()
        log("已点「我知道了」", step="popup")
    if d(text="坐标打卡").wait(timeout=0.4):
        utils.click_skip_coordinate(d)
        log("已跳过坐标打卡", step="popup")


def goto_match_chat(d, timeout: float = 25) -> bool:
    """进入灵魂匹配聊天页。成功返回 True。"""
    log("开始匹配进聊天", step="match")

    if _click_text(d, "立即私聊", timeout=0.8):
        log("点击「立即私聊」", step="match")
    else:
        if not _click_text(d, "星球", timeout=1.2):
            warn("未找到「星球」", step="match")
            return False
        log("点击「星球」", step="match")
        if not _click_text(d, "灵魂匹配", timeout=1.5):
            warn("未找到「灵魂匹配」", step="match")
            return False
        log("点击「灵魂匹配」，等待进房", step="match")

    deadline = time.time() + timeout
    while time.time() < deadline:
        if utils.is_chat_page2(d) or utils.is_chat_page(d):
            log("已进入聊天页", step="match")
            return True
        # 匹配中可能弹出立即私聊
        if _click_text(d, "立即私聊", timeout=0.3):
            log("匹配中点到「立即私聊」", step="match")
        time.sleep(0.45)

    warn(f"等待进入聊天页超时({timeout}s)", step="match")
    return False


def send_greet(d, content: Optional[str] = None) -> bool:
    """发送打招呼。空内容 → 直接发 [吃瓜] 文本码（最快、最稳）。"""
    text = (content or "").strip()

    if not text:
        code = f"[{DEFAULT_EMOJI}]"
        log(f"内容为空，发送默认表情码 {code}", step="greet")
        ok = sendMsgSoul.send_message(d, code, wait_time=0.4)
        log("默认表情发送成功" if ok else "默认表情发送失败", step="greet")
        return ok

    if text.startswith("[") and text.endswith("]") and len(text) > 2:
        log(f"发送表情码 {text}", step="greet")
        ok = sendMsgSoul.send_message(d, text, wait_time=0.4)
        log("表情码发送成功" if ok else "表情码发送失败", step="greet")
        return ok

    log(f"发送文本: {text}", step="greet")
    ok = sendMsgSoul.send_message(d, text, wait_time=0.4)
    log("文本发送成功" if ok else "文本发送失败", step="greet")
    return ok


def one_round(d, *, round_no: int, total: int, content: Optional[str] = None) -> bool:
    log(f"===== 第 {round_no}/{total} 轮开始 =====", step="round", round=round_no, total=total)

    was_foreground = ensure_app_foreground(d)
    if not was_foreground:
        handle_first_launch_popups(d)

    if not goto_match_chat(d):
        warn(f"第 {round_no} 轮：匹配失败", step="round", round=round_no)
        return False

    ok = send_greet(d, content)
    log("返回上一页", step="back")
    sendMsgSoul.go_back(d)
    time.sleep(0.35)

    log(
        f"第 {round_no}/{total} 轮结束: {'成功' if ok else '失败'}",
        step="round",
        round=round_no,
        ok=ok,
    )
    return ok


def run(loop: int, interval: float = DEFAULT_INTERVAL, *, content: Optional[str] = None) -> None:
    if loop is None or int(loop) < 1:
        raise ValueError("循环次数(loop)为必填，且必须 >= 1")

    loop = int(loop)
    interval = float(interval) if interval is not None else DEFAULT_INTERVAL
    if interval < 0:
        interval = 0

    greet_desc = (content or "").strip() or f"默认表情[{DEFAULT_EMOJI}]"
    log(f"参数确认: loop={loop}, interval={interval}s, content={greet_desc!r}", step="init")

    d = connect_device()
    log(f"设备连接成功: {d}", step="connect")

    ok_count = 0
    for i in range(loop):
        ok = one_round(d, round_no=i + 1, total=loop, content=content)
        if ok:
            ok_count += 1
        if i < loop - 1 and interval > 0:
            log(f"轮次间隔 {interval}s", step="interval")
            time.sleep(interval)

    log(f"全部完成: 成功 {ok_count}/{loop}", step="done", ok=ok_count, total=loop)


if __name__ == "__main__":
    run(loop=5)
