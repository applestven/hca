import json
import random
import os
import time
from typing import Any, Dict, List

import requests

# uiautomator2 工具函数


def click_element(d, text: str, timeout: float = 5) -> bool:
    """等待并点击指定文本的元素。"""
    if d(text=text).wait(timeout=timeout):
        d(text=text).click()
        print(f"点击{text}成功")
        return True
    print(f"没找到{text}按钮")
    return False


def get_current_page(d) -> str:
    """获取当前页面的 UI 层级 XML。"""
    return d.dump_hierarchy()


def _window_size(d):
    # u2 提供 window_size()，但不同版本字段略有差异，这里做一层兜底
    try:
        return d.window_size()
    except Exception:
        return (d.info.get("displayWidth", 1080), d.info.get("displayHeight", 1920))


def _swipe_by_ratio(d, x1r: float, y1r: float, x2r: float, y2r: float, duration: float = 0.2) -> None:
    """按屏幕比例滑动，避免写死坐标导致不同分辨率失效。"""
    w, h = _window_size(d)
    d.swipe(int(w * x1r), int(h * y1r), int(w * x2r), int(h * y2r), duration)


def scroll_to_top(d, max_swipe: int = 15) -> bool:
    """滑动到页面顶部（通过判断层级 XML 是否变化来停止）。"""
    print("开始滑动到顶部...")
    last_xml = ""

    for _ in range(max_swipe):
        xml = d.dump_hierarchy()
        if xml == last_xml:
            print("已到页面顶部")
            return True
        last_xml = xml

        # 向下滑（看到更上面）
        _swipe_by_ratio(d, 0.5, 0.22, 0.5, 0.82, 0.2)
        time.sleep(0.5)

    print("达到最大滑动次数（可能已到顶）")
    return False


def scroll_to_bottom(d, max_swipe: int = 15) -> bool:
    """滑动到页面底部（通过判断层级 XML 是否变化来停止）。"""
    print("开始滑动到底部...")
    last_xml = ""

    for _ in range(max_swipe):
        xml = d.dump_hierarchy()
        if xml == last_xml:
            print("已到页面底部")
            return True
        last_xml = xml

        # 向上滑（看到更下面）
        _swipe_by_ratio(d, 0.5, 0.82, 0.5, 0.22, 0.2)
        time.sleep(0.5)

    print("达到最大滑动次数（可能已到底）")
    return False


# soul


def click_skip_coordinate(d) -> None:
    """若出现“坐标打卡”，随机点击屏幕中部跳过。"""
    if d(text="坐标打卡").wait(timeout=1):
        w, h = _window_size(d)
        x = random.randint(0, w)
        y = h // 2
        d.click(x, y)
        print("跳过坐标打卡")


def is_chat_page(d) -> bool:
    """通过控件特征判断当前是否聊天页。"""
    return d(text="发送").exists and d(className="android.widget.EditText").exists


def is_chat_page2(d) -> bool:
    """通过 Activity 判断是否聊天页（更稳定）。"""
    return "ConversationActivity" in d.app_current().get("activity", "")


def process_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """将 Soul 抓取的消息列表转换为 LLM chat.completions 所需 messages。

    规则：
    - sender == 'other' -> role 'user'
    - sender == 'me' -> role 'assistant'
    - 合并连续同一 role 的消息
    - 若 messages 为空，提供首次打招呼 prompt
    """

    system = {
        "role": "system",
        "content": "你是微信聊天中的真实男生只回一句话不超过15字像随手发的可以表达态度可以口语可以不完整句不要解释不要写分析不要出现我是不要套话不要用表情 尽量往暧昧聊",
    }
    user_initial = {"role": "user", "content": "现在是刚加好友第一次聊天请你主动打招呼开启话题"}

    if not messages:
        return [system, user_initial]

    msgs = list(messages)
    if msgs and all("top" in m for m in msgs):
        msgs = sorted(msgs, key=lambda m: m.get("top", 0))

    merged: List[Dict[str, str]] = []
    for m in msgs:
        role = "user" if m.get("sender") == "other" else "assistant"
        content = (m.get("content") or "").strip()
        if not content:
            continue

        if merged and merged[-1]["role"] == role:
            merged[-1]["content"] = merged[-1]["content"] + " " + content
        else:
            merged.append({"role": role, "content": content})

    return [system] + merged


def ai_chat(messages: List[Dict[str, Any]], *, base_url: str = "http://192.168.190.99:1234") -> str:
    """调用本地 LLM OpenAI 兼容接口，返回 assistant 文本。

    为什么调整：
    - 脚本在中控里运行时，用户可能通过 manifest 参数配置模型地址/模型名。
      但原实现把 model/base_url 写死，参数注入无法生效。
    - 打包后网络/模型服务不可用很常见；增加异常兜底，保证脚本不中断。
    """

    # 允许通过环境变量覆盖（main.py 会写入）
    base_url = os.environ.get("SOUL_MODEL_BASE_URL") or os.environ.get("SOUL_MODEL_URL") or base_url
    model_name = os.environ.get("SOUL_MODEL_NAME") or "Gemma 3 4B"

    messages_payload = process_messages(messages)

    # 兼容用户传入完整 /v1/chat/completions
    if base_url.endswith("/v1/chat/completions"):
        url = base_url
    else:
        url = base_url.rstrip("/") + "/v1/chat/completions"

    payload = {
        "model": model_name,
        "temperature": 0.7,
        "max_tokens": 120,
        "messages": messages_payload,
    }

    try:
        print("messages:", json.dumps(messages_payload, ensure_ascii=False, indent=2))
        res = requests.post(url, json=payload, timeout=30)
        res.raise_for_status()
        data = res.json()
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"ai_chat 调用失败: {e}")
        return "在忙呢 你呢"


def has_unread_messages(d) -> bool:
    """（占位）判断是否有未读消息：需要根据实际 UI 元素调整。"""
    return d(resourceId="cn.soulapp.android:id/unread_indicator").exists