"""Soul 循环匹配打招呼 — ScriptRunner 入口"""

import json
import os
import sys
import traceback


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _parse_loop(raw):
    """解析循环次数：兼容 number / 数字字符串；拒绝空、NaN、非整数。"""
    if raw is None:
        return None, "循环次数(loop)为必填参数"
    if isinstance(raw, bool):
        return None, f"循环次数无效: {raw!r}"
    if isinstance(raw, float):
        if raw != raw:  # NaN
            return None, "循环次数无效: NaN"
        if raw != int(raw):
            return None, f"循环次数必须是整数: {raw!r}"
        raw = int(raw)
    if isinstance(raw, int):
        if raw < 1:
            return None, "循环次数必须 >= 1"
        return raw, None

    s = str(raw).strip()
    if not s or s.lower() in ("nan", "null", "undefined"):
        return None, "循环次数(loop)为必填参数"
    try:
        # 允许 "5" / "5.0"
        n = float(s)
        if n != int(n):
            return None, f"循环次数必须是整数: {raw!r}"
        n = int(n)
    except Exception:
        return None, f"循环次数无效: {raw!r}"
    if n < 1:
        return None, "循环次数必须 >= 1"
    return n, None


def main():
    # Windows 下强制 UTF-8，避免中文步骤日志乱码
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    params = {}
    if len(sys.argv) > 1:
        try:
            params = json.loads(sys.argv[1])
        except Exception as e:
            emit({"type": "error", "msg": f"params parse error: {e}"})
            return 2

    device = params.get("device")
    if device:
        os.environ["device"] = str(device)

    emit({"type": "log", "step": "params", "msg": f"收到参数: {json.dumps(params, ensure_ascii=False)}"})

    loop, err = _parse_loop(params.get("loop", None))
    if err:
        emit({"type": "error", "msg": err, "raw_loop": params.get("loop")})
        return 2

    content = params.get("content")
    if content is None or str(content).strip() == "":
        content = params.get("emoji") or ""
    content = str(content).strip() if content is not None else ""

    # 可选间隔；不传则用业务默认
    interval = params.get("interval", None)
    try:
        interval = float(interval) if interval is not None and str(interval).strip() != "" else None
    except Exception:
        interval = None

    emit({
        "type": "log",
        "step": "start",
        "msg": f"start soul_match_greet loop={loop} content={content or '(默认吃瓜表情)'}",
        "device": device,
        "loop": loop,
        "content": content or "(默认吃瓜表情)",
    })

    try:
        import uiautomator2  # noqa: F401
    except Exception as e:
        emit({
            "type": "error",
            "msg": f"uiautomator2 import failed: {e}",
            "trace": traceback.format_exc(),
        })
        return 1

    try:
        sys.path.insert(0, os.path.dirname(__file__))
        import match_greet  # noqa: E402

        kwargs = {"loop": loop, "content": content}
        if interval is not None:
            kwargs["interval"] = interval
        match_greet.run(**kwargs)
        emit({"type": "done", "ok": True, "msg": f"finished loop={loop}", "device": device})
        return 0
    except Exception as e:
        emit({
            "type": "error",
            "msg": str(e),
            "device": device,
            "trace": traceback.format_exc(),
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
