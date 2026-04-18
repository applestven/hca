import sys
import json
import time

def emit(obj):
    # 统一输出 JSON 行，便于 Electron 解析
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def main():
    params = {}
    if len(sys.argv) > 1:
        try:
            params = json.loads(sys.argv[1])
        except Exception as e:
            emit({"type": "error", "msg": f"params parse error: {e}"})
            return

    device = params.get("device")
    message = params.get("message", "你好")
    delay = params.get("delay", 2)

    emit({"type": "log", "msg": f"start demo_auto_chat", "device": device})
    emit({"type": "log", "msg": f"message={message}, delay={delay}", "device": device})

    for i in range(3):
        emit({"type": "progress", "current": i + 1, "total": 3, "msg": f"tick {i+1}/3", "device": device})
        time.sleep(float(delay))

    emit({"type": "done", "ok": True, "msg": "finished", "device": device})

if __name__ == "__main__":
    main()
