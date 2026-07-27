import json
import os
import sys
import time

import uiautomator2 as u2


def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def parse_params():
    if len(sys.argv) <= 1:
        return {}
    try:
        return json.loads(sys.argv[1])
    except Exception as e:
        emit({"type": "error", "msg": f"params parse error: {e}"})
        raise


def connect_device(params):
    serial = (
        params.get("device")
        or os.environ.get("HCA_DEVICE_SERIAL")
        or os.environ.get("ANDROID_SERIAL")
        or os.environ.get("device")
    )
    emit({"type": "log", "step": "connect", "msg": f"connecting device={serial or '(usb auto)'}"})
    if serial:
        return u2.connect(serial)
    return u2.connect_usb()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    params = parse_params()
    device = params.get("device")
    message = str(params.get("message", "你好"))
    delay = float(params.get("delay", 2) or 2)

    d = connect_device(params)
    emit({"type": "log", "step": "connect", "msg": "设备连接成功", "device": device})

    current = d.app_current().get("package")
    if current != "com.tencent.mm":
        emit({"type": "log", "step": "app", "msg": "微信不在前台，尝试拉起", "device": device})
        d.app_start("com.tencent.mm")
        time.sleep(1)

    emit({"type": "log", "step": "app", "msg": f"等待加载完成，message={message}", "device": device})
    time.sleep(delay)
    emit({"type": "done", "ok": True, "msg": "finished", "device": device})


if __name__ == "__main__":
    main()