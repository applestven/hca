"""Soul 循环匹配打招呼 — ScriptRunner 入口"""

import json
import os
import sys
import traceback


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
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

    raw_loop = params.get("loop", None)
    if raw_loop is None or str(raw_loop).strip() == "":
        emit({"type": "error", "msg": "循环次数(loop)为必填参数"})
        return 2

    try:
        loop = int(raw_loop)
    except Exception:
        emit({"type": "error", "msg": f"循环次数无效: {raw_loop!r}"})
        return 2

    if loop < 1:
        emit({"type": "error", "msg": "循环次数必须 >= 1"})
        return 2

    # 兼容旧参数名 emoji；空内容 → 业务层默认吃瓜表情
    content = params.get("content")
    if content is None or str(content).strip() == "":
        content = params.get("emoji") or ""
    content = str(content).strip() if content is not None else ""

    emit({
        "type": "log",
        "msg": "start soul_match_greet",
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

        match_greet.run(loop=loop, content=content)
        emit({"type": "done", "ok": True, "msg": "finished", "device": device})
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
