"""Sub 获客脚本入口（HCA ScriptRunner）"""

from __future__ import annotations

import json
import os
import random
import sys
import time
import traceback
from typing import Any, Dict, List, Set

# 保证同目录模块可 import（打包/cwd 场景）
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def log(msg: str, step: str = "", **extra) -> None:
    payload: Dict[str, Any] = {"type": "log", "msg": msg}
    if step:
        payload["step"] = step
    payload.update(extra)
    emit(payload)


def parse_params() -> dict:
    if len(sys.argv) <= 1:
        return {}
    try:
        return json.loads(sys.argv[1])
    except Exception as e:
        emit({"type": "error", "msg": f"params parse error: {e}"})
        return {}


def connect_device(serial: str | None):
    import ui_sub

    return ui_sub.connect_device(serial)


def pick_candidate(candidates: List[Dict[str, Any]], selected: Set[str]) -> Dict[str, Any] | None:
    pool = [c for c in candidates if c.get("userId") and c["userId"] not in selected]
    if not pool:
        return None
    # 优先有未读的会话（waiting 用户更可能已回复）
    unread_pool = [c for c in pool if int(c.get("unread") or 0) > 0]
    if unread_pool:
        return random.choice(unread_pool)
    return random.choice(pool)


def clamp_delay(v, fallback: float, lo: float = 0.1, hi: float = 10.0) -> float:
    try:
        n = float(v)
    except Exception:
        n = fallback
    if not (n == n):  # NaN
        n = fallback
    return max(lo, min(hi, n))


def process_one(
    d,
    api,
    device: str,
    candidate: Dict[str, Any],
    wait_reply: bool,
    max_retry: int,
    dry_run: bool,
    package: str,
    delay_min: float = 0.8,
    delay_max: float = 1.5,
    back_delay_min: float = 0.3,
    back_delay_max: float = 0.8,
) -> str:
    """返回 success|fail|skipped"""
    import ui_sub

    user_id = candidate.get("userId") or ""
    display_name = candidate.get("displayName") or ""
    list_unread = int(candidate.get("unread") or 0)

    assign = api.assign(user_id, display_name)
    user = assign.get("user") or {}
    log(
        f"状态 scriptId={user.get('scriptId')} nextStep={user.get('nextStep')} "
        f"status={user.get('status')} unread={list_unread}",
        step="state_read",
        userId=user_id,
    )

    blocked_statuses = {"done", "blocked"}
    if user.get("status") in blocked_statuses:
        log(f"跳过 status={user.get('status')}", step="skip", userId=user_id)
        return "skipped"

    claim = api.claim(user_id, device)
    if not claim.get("ok"):
        log(f"领取失败 reason={claim.get('reason')}", step="claim", userId=user_id)
        return "skipped"
    user = claim.get("user") or user

    try:
        # waiting：进聊天读最新气泡；末条是对方 → 继续发下一句本
        if user.get("waitingReply") or user.get("status") == "waiting":
            if dry_run:
                log("dry_run：模拟检测到回复", step="reply_check", userId=user_id)
                api.reply(user_id, last_reply_message_id="dry_reply", device=device)
                user = api.get_user(user_id).get("user") or user
            else:
                if not ui_sub.open_session_by_name(d, display_name):
                    api.release(user_id, device)
                    log("打不开会话(未进入聊天页)", step="skip", userId=user_id)
                    return "skipped"
                if not ui_sub.is_chat_page(d):
                    api.release(user_id, device)
                    log("打开后不在聊天页", step="skip", userId=user_id)
                    return "skipped"

                # 进入聊天 = 可见区即最新消息：先读气泡再判定
                time.sleep(0.4)
                ui_sub.scroll_chat_to_bottom(d)
                bubbles = ui_sub.read_chat_bubbles_retry(d, attempts=3)
                summary = ui_sub.bubbles_summary(bubbles)
                ok, reply_id = ui_sub.detect_new_reply(bubbles)
                log(
                    f"reply_check ok={ok} replyId={reply_id or 'unknown'} {summary}",
                    step="reply_check",
                    userId=user_id,
                )
                if not ok:
                    ui_sub.go_back(d, settle=random.uniform(0.3, 0.8))
                    api.release(user_id, device)
                    return "skipped"
                api.reply(user_id, last_reply_message_id=reply_id, device=device)
                user = api.get_user(user_id).get("user") or user

        pack = api.list_scripts()
        scripts = pack.get("scripts") or []
        script = next((s for s in scripts if s.get("id") == user.get("scriptId")), None)
        if not script:
            api.send_fail(user_id, "script_missing", max_retry=max_retry, device=device)
            api.release(user_id, device)
            return "fail"

        steps = sorted(script.get("steps") or [], key=lambda x: int(x.get("order") or 0))
        next_step = int(user.get("nextStep") or 1)
        if next_step > len(steps):
            # 已完成
            api.release(user_id, device)
            log("已 done", step="skip", userId=user_id)
            return "success"

        step_def = next((s for s in steps if int(s.get("order") or 0) == next_step), None)
        if not step_def:
            step_def = steps[next_step - 1] if 0 < next_step <= len(steps) else None
        if not step_def:
            api.send_fail(user_id, "step_missing", max_retry=max_retry, device=device)
            api.release(user_id, device)
            return "fail"

        messages = step_def.get("messages") or []
        rendered = api.render(messages, {"name": display_name}).get("messages") or messages
        # 间隔以脚本面板参数为准（可调 0.1–10）
        dmin = clamp_delay(delay_min, 0.8)
        dmax = clamp_delay(delay_max, 1.5)
        if dmax < dmin:
            dmax = dmin

        log(
            f"准备发送 nextStep={next_step} content={rendered} delay={dmin:.2f}-{dmax:.2f}s",
            step="before_send",
            userId=user_id,
        )

        if not dry_run:
            # 若还在列表页，打开会话
            if not d(resourceId=f"{package}:id/edit_btn").exists(timeout=0.5):
                if not ui_sub.open_session_by_name(d, display_name):
                    api.send_fail(user_id, "session_not_found", max_retry=max_retry, device=device)
                    api.release(user_id, device)
                    return "fail"

        sent_ok = True
        for i, text in enumerate(rendered):
            if dry_run:
                log(f"dry_send_{i}", step="send", userId=user_id, content=[text])
            else:
                ok = ui_sub.send_text(d, text)
                if not ok:
                    sent_ok = False
                    break
            if i < len(rendered) - 1:
                time.sleep(random.uniform(dmin, dmax))

        if not sent_ok:
            api.send_fail(user_id, "send_failed", max_retry=max_retry, device=device)
            if not dry_run:
                ui_sub.go_back(d)
            api.release(user_id, device)
            return "fail"

        last_id = None
        if dry_run:
            last_id = f"dry_send_{next_step}_{int(time.time())}"
        else:
            time.sleep(0.45)
            bubbles = ui_sub.read_chat_bubbles(d)
            last_id = ui_sub.last_me_message_id(bubbles)
            if not last_id and rendered:
                from api import make_message_key as _mk

                last_id = _mk("me", (rendered[-1] or "").strip())

        api.send_ok(
            user_id,
            content=list(rendered),
            last_send_message_id=last_id,
            max_steps=len(steps),
            wait_reply=wait_reply,
            device=device,
        )
        log("发送成功", step="send", userId=user_id, content=list(rendered), result="success")

        if not dry_run:
            bmin = clamp_delay(back_delay_min, 0.3)
            bmax = clamp_delay(back_delay_max, 0.8)
            if bmax < bmin:
                bmax = bmin
            time.sleep(random.uniform(bmin, bmax))
            ui_sub.go_back(d, settle=random.uniform(0.25, 0.45))
            ui_sub.ensure_message_list(d, timeout=3.0)
        api.release(user_id, device)
        return "success"
    except Exception as e:
        try:
            api.send_fail(user_id, str(e), max_retry=max_retry, device=device)
            api.release(user_id, device)
        except Exception:
            pass
        emit({"type": "error", "msg": str(e), "trace": traceback.format_exc(), "userId": user_id})
        return "fail"


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    import api as api_mod
    import ui_sub

    params = parse_params()
    device = str(
        params.get("device")
        or os.environ.get("HCA_DEVICE_SERIAL")
        or os.environ.get("ANDROID_SERIAL")
        or os.environ.get("device")
        or ""
    )
    limit = int(params.get("limit") or 10)
    wait_reply = bool(int(params.get("wait_reply") if params.get("wait_reply") is not None else 1))
    max_retry = int(params.get("max_retry") or 3)
    package = str(params.get("package") or ui_sub.PKG)
    dry_run = bool(int(params.get("dry_run") or 0))
    delay_min = clamp_delay(params.get("delay_min"), 0.8)
    delay_max = clamp_delay(params.get("delay_max"), 1.5)
    if delay_max < delay_min:
        delay_max = delay_min
    back_delay_min = clamp_delay(params.get("back_delay_min"), 0.3)
    back_delay_max = clamp_delay(params.get("back_delay_max"), 0.8)
    if back_delay_max < back_delay_min:
        back_delay_max = back_delay_min

    base = os.environ.get("HCA_SUB_GUEST_API") or params.get("api_base") or ""
    crm = api_mod.SubGuestApi(base)

    try:
        h = crm.health()
        log(
            f"CRM API ok root={h.get('rootDir')} delay={delay_min}-{delay_max}s back={back_delay_min}-{back_delay_max}s",
            step="start",
            device=device,
        )
    except Exception as e:
        emit({"type": "error", "msg": f"CRM API 不可用: {e}. 请确认 Electron 主进程已启动 subGuest HTTP。"})
        return 1

    log(f"连接设备 {device or '(usb)'}", step="connect")
    d = None if dry_run else connect_device(device or None)

    if not dry_run:
        ui_sub.ensure_app(d, package=package)
        try:
            cur = d.app_current() or {}
            log(
                f"当前界面 package={cur.get('package')} activity={cur.get('activity')}",
                step="app",
                device=device,
            )
        except Exception as e:
            log(f"读取当前界面失败: {e}", step="app", device=device)

        opened = ui_sub.open_message_tab(d)
        if not opened:
            # 再启一次 App 后重试
            try:
                d.app_start(package)
                time.sleep(2.0)
            except Exception:
                pass
            opened = ui_sub.open_message_tab(d)
        if not opened:
            emit(
                {
                    "type": "error",
                    "msg": (
                        "未进入消息列表：请在该设备上手动打开 Sub App 到「消息」页后重试；"
                        "若持续报 INJECT_EVENTS，请在开发者选项关闭「禁止权限监控/指针位置」相关限制，"
                        "或重新安装/初始化 uiautomator2(atx-agent)。"
                    ),
                    "device": device,
                }
            )
            return 1
        log("已进入消息列表", step="enter_msg", device=device)

    selected: Set[str] = set()
    success_n = fail_n = skip_n = 0

    while len(selected) < limit:
        if dry_run:
            candidates = [
                {
                    "userId": f"dry_{i}",
                    "displayName": f"测试用户{i}",
                    "raw": f"测试用户{i}",
                }
                for i in range(1, limit + 1)
            ]
        else:
            candidates = ui_sub.collect_session_candidates(d)
            if not candidates:
                try:
                    ui_sub.scroll_message_list(d)
                except Exception as e:
                    log(f"滑动列表失败(已忽略): {e}", step="scroll")
                candidates = ui_sub.collect_session_candidates(d)

        if not candidates:
            log("消息列表为空", step="list")
            break

        cand = pick_candidate(candidates, selected)
        if not cand:
            # 下滑再采
            if not dry_run:
                try:
                    ui_sub.scroll_message_list(d)
                except Exception as e:
                    log(f"滑动列表失败(已忽略): {e}", step="scroll")
                candidates = ui_sub.collect_session_candidates(d)
                cand = pick_candidate(candidates, selected)
            if not cand:
                log("没有可处理的新会话", step="list")
                break

        selected.add(cand["userId"])
        log(
            f"选中 {cand.get('displayName')} ({cand.get('userId')})",
            step="pick",
            userId=cand.get("userId"),
        )

        result = process_one(
            d,
            crm,
            device or "dry",
            cand,
            wait_reply=wait_reply,
            max_retry=max_retry,
            dry_run=dry_run,
            package=package,
            delay_min=delay_min,
            delay_max=delay_max,
            back_delay_min=back_delay_min,
            back_delay_max=back_delay_max,
        )
        if result == "success":
            success_n += 1
        elif result == "fail":
            fail_n += 1
        else:
            skip_n += 1

        log(
            f"进度 selected={len(selected)}/{limit} success={success_n} fail={fail_n} skip={skip_n}",
            step="next",
        )

    emit(
        {
            "type": "done",
            "ok": True,
            "msg": "finished",
            "selected": len(selected),
            "success": success_n,
            "fail": fail_n,
            "skip": skip_n,
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        emit({"type": "error", "msg": str(e), "trace": traceback.format_exc()})
        raise SystemExit(1)
