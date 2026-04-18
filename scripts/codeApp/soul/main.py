"""Soul 脚本入口（适配 HCA ScriptRunner）

# 为什么调整：
# - 你在 VSCode 直接跑正常，但在中控里“没反应”，通常是：
#   1) 卡在 uiautomator2 连接/初始化阶段（没有任何 stdout 输出，UI 看起来像没执行）
#   2) import 失败（依赖缺失），但异常信息没被结构化输出
# - 这里不改业务流程，只增强“可观测性”：关键阶段 emit JSON 行，异常带 traceback。

"""

import json
import os
import sys
import traceback


def emit(obj):
    # 统一输出 JSON 行，便于 Electron 解析并展示到“中控日志”
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def main():
    params = {}
    if len(sys.argv) > 1:
        try:
            params = json.loads(sys.argv[1])
        except Exception as e:
            emit({"type": "error", "msg": f"params parse error: {e}"})
            return 2

    # ====== debug: import path visibility (always) ======
    try:
        script_dir = os.path.dirname(__file__)
        emit({
            "type": "log",
            "msg": "debug paths",
            "cwd": os.getcwd(),
            "__file__": __file__,
            "script_dir": script_dir,
            "has_soul_py": os.path.exists(os.path.join(script_dir, "soul.py")),
            "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
            "HCA_SCRIPT_DIR": os.environ.get("HCA_SCRIPT_DIR", "")
        })
        emit({"type": "log", "msg": "sys.path", "data": sys.path})
    except Exception:
        pass

    # runner 会注入 device（serial 或 ip:port）
    device = params.get("device")
    if device:
        # 兼容我们在 soul.py 里读取的环境变量
        os.environ["device"] = str(device)

    loop = int(params.get("loop", 3))
    interval = float(params.get("interval", 5))

    # 可选：把模型配置写入环境变量（如果你后续要在 utils.ai_chat 里读取）
    model_url = params.get("model_url")
    model_name = params.get("model_name")
    if model_url:
        os.environ["SOUL_MODEL_URL"] = str(model_url)
    if model_name:
        os.environ["SOUL_MODEL_NAME"] = str(model_name)

    emit({"type": "log", "msg": "start soul", "device": device, "loop": loop, "interval": interval})

    # 强依赖检查（必须依赖 uiautomator2）
    try:
        import uiautomator2  # noqa: F401
        emit({"type": "log", "msg": "uiautomator2 import ok"})
    except Exception as e:
        emit({"type": "error", "msg": f"uiautomator2 import failed: {e}", "trace": traceback.format_exc()})
        return 1

    try:
        emit({"type": "log", "msg": "import soul module"})

        # 保证优先导入脚本目录下的 soul.py
        # （runner 已把 script.path 加入 PYTHONPATH，但这里再兜底一次，避免同名包/路径污染）
        sys.path.insert(0, os.path.dirname(__file__))
        import soul  # noqa: E402

        emit({"type": "log", "msg": "call soul.main"})
        if hasattr(soul, 'main'):
            soul.main(soul.connect_device())
        elif hasattr(soul, 'run'):
            soul.run(loop=loop, interval=interval)
        else:
            raise RuntimeError('soul module has no main/run')

        emit({"type": "done", "ok": True, "msg": "finished", "device": device})
        return 0

    except Exception as e:
        # import 失败也带上路径信息，便于定位 packaged 环境
        emit({
            "type": "error",
            "msg": str(e),
            "device": device,
            "trace": traceback.format_exc(),
            "debug": {
                "cwd": os.getcwd(),
                "script_dir": os.path.dirname(__file__),
                "has_soul_py": os.path.exists(os.path.join(os.path.dirname(__file__), "soul.py")),
                "PYTHONPATH": os.environ.get("PYTHONPATH", ""),
                "sys_path": sys.path,
            },
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
