"""Soul 脚本入口（适配 HCA ScriptRunner）

为什么要加这个文件：
- HCA 脚本系统通过 manifest.json 的 entry 启动脚本。
- 你原来的 soul.py 更像“业务模块”，但参数入口/解析不统一；
  这里用 main.py 做统一入口：解析 sys.argv[1] 的 JSON 参数，随后调用 soul.run(...)。

约定：
- Electron/ScriptRunner 会以 `python main.py <json>` 启动，并在 json 内注入 device（可选）。
- 多设备批量执行时，runner 会为每台设备启动一个子进程，并写入不同的 device。

"""

import json
import os
import sys


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

    try:
        import soul  # noqa: E402

        soul.run(loop=loop, interval=interval)
        emit({"type": "done", "ok": True, "msg": "finished", "device": device})
        return 0

    except Exception as e:
        emit({"type": "error", "msg": str(e), "device": device})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
