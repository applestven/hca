"""Sub 获客脚本入口（HCA ScriptRunner）"""

from __future__ import annotations

import json
import os
import random
import signal
import sys
import time
import traceback
from typing import Any, Dict, List, Set

# 保证同目录模块可 import（打包/cwd 场景）
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

_STOP_REQUESTED = False


class StopRequested(Exception):
    """用户点击停止 / 收到终止信号。"""


def request_stop(signum=None, frame=None) -> None:
    global _STOP_REQUESTED
    _STOP_REQUESTED = True
    try:
        log(f"收到停止信号 signum={signum}", step="stop")
    except Exception:
        pass


def check_stop() -> None:
    if _STOP_REQUESTED:
        raise StopRequested("stopped by user")


def install_stop_handlers() -> None:
    for sig_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, request_stop)
        except Exception:
            continue


def emit(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def log(msg: str, step: str = "", **extra) -> None:
    payload: Dict[str, Any] = {"type": "log", "msg": msg}
    if step:
        payload["step"] = step
    payload.update(extra)
    emit(payload)


def wait(tag: str, seconds: float, **extra) -> None:
    """带唯一标识的等待；可被停止信号打断。"""
    sec = max(0.0, float(seconds))
    log(
        f"[WAIT:{tag}] sleep {sec:.3f}s",
        step="wait",
        waitTag=tag,
        waitSec=round(sec, 3),
        **extra,
    )
    end = time.time() + sec
    while True:
        check_stop()
        left = end - time.time()
        if left <= 0:
            break
        time.sleep(min(0.2, left))


def cost(tag: str, t0: float, **extra) -> float:
    """记录非 sleep 耗时；搜 costTag / [COST:xxx]。"""
    elapsed = max(0.0, time.time() - float(t0))
    log(
        f"[COST:{tag}] {elapsed:.3f}s",
        step="cost",
        costTag=tag,
        costSec=round(elapsed, 3),
        **extra,
    )
    return elapsed


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
    """只选有未读气泡的会话；没有未读的一律不点。"""
    pool = [
        c
        for c in candidates
        if c.get("userId")
        and c["userId"] not in selected
        and int(c.get("unread") or 0) > 0
    ]
    if not pool:
        return None
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
    if list_unread <= 0 and not dry_run:
        log(
            f"跳过：列表无未读气泡 unread={list_unread} name={display_name}",
            step="skip_no_unread",
            userId=user_id,
        )
        return "skipped"

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
        reason = user.get("status")
        if reason == "done":
            log(
                f"跳过：CRM 话术已完成(status=done) nextStep={user.get('nextStep')} "
                f"name={display_name}；列表仍显示未读 unread={list_unread}，"
                f"不占用「对话次数」，继续找下一人",
                step="skip_done",
                userId=user_id,
                name=display_name,
                unread=list_unread,
                nextStep=user.get("nextStep"),
            )
        else:
            log(
                f"跳过：CRM 已拉黑/阻断(status=blocked) name={display_name} unread={list_unread}",
                step="skip_blocked",
                userId=user_id,
                name=display_name,
                unread=list_unread,
            )
        return "skipped"

    claim = api.claim(user_id, device)
    if not claim.get("ok"):
        log(
            f"跳过：领取失败 reason={claim.get('reason')} name={display_name}",
            step="skip_claim",
            userId=user_id,
            name=display_name,
        )
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
                t_open = time.time()
                if not ui_sub.open_session_by_name(d, display_name):
                    cost("MAIN_OPEN_SESSION_FOR_REPLY", t_open, userId=user_id, ok=False)
                    api.release(user_id, device)
                    log(
                        f"跳过：打不开会话(未进入聊天页) name={display_name}",
                        step="skip_open",
                        userId=user_id,
                        name=display_name,
                    )
                    return "skipped"
                cost("MAIN_OPEN_SESSION_FOR_REPLY", t_open, userId=user_id, ok=True)
                if not ui_sub.is_chat_page(d):
                    api.release(user_id, device)
                    log(
                        f"跳过：打开后不在聊天页 name={display_name}",
                        step="skip_not_chat",
                        userId=user_id,
                        name=display_name,
                    )
                    return "skipped"

                # 进入聊天 = 可见区即最新消息：先读气泡再判定
                wait("MAIN_REPLY_CHAT_SETTLE", 0.12, userId=user_id)
                t_bubbles = time.time()
                ui_sub.scroll_chat_to_bottom(d)
                bubbles = ui_sub.read_chat_bubbles_retry(d, attempts=2)
                cost("MAIN_READ_BUBBLES_FOR_REPLY", t_bubbles, userId=user_id, n=len(bubbles))
                summary = ui_sub.bubbles_summary(bubbles)
                ok, reply_id = ui_sub.detect_new_reply(bubbles)
                log(
                    f"reply_check ok={ok} replyId={reply_id or 'unknown'} {summary}",
                    step="reply_check",
                    userId=user_id,
                )
                if not ok:
                    ui_sub.go_back(
                        d,
                        settle=random.uniform(0.15, 0.35),
                        wait_tag="MAIN_NO_REPLY_GO_BACK",
                    )
                    api.release(user_id, device)
                    log(
                        f"跳过：等待回复中，末条不是对方消息(无需续发) "
                        f"name={display_name} nextStep={user.get('nextStep')} {summary}",
                        step="skip_no_reply",
                        userId=user_id,
                        name=display_name,
                        nextStep=user.get("nextStep"),
                    )
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
            log(
                f"跳过：nextStep={next_step} 已超过话术步数={len(steps)}，视为已完成 "
                f"name={display_name}（不占对话次数）",
                step="skip_past_steps",
                userId=user_id,
                name=display_name,
                nextStep=next_step,
                steps=len(steps),
            )
            return "skipped"

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
            t_edit = time.time()
            in_chat = bool(d(resourceId=f"{package}:id/edit_btn").exists(timeout=0.15))
            cost("MAIN_CHECK_EDIT_BTN", t_edit, userId=user_id, inChat=in_chat)
            if not in_chat:
                t_open = time.time()
                if not ui_sub.open_session_by_name(d, display_name):
                    cost("MAIN_OPEN_SESSION_FOR_SEND", t_open, userId=user_id, ok=False)
                    api.send_fail(user_id, "session_not_found", max_retry=max_retry, device=device)
                    api.release(user_id, device)
                    return "fail"
                cost("MAIN_OPEN_SESSION_FOR_SEND", t_open, userId=user_id, ok=True)

        sent_ok = True
        for i, text in enumerate(rendered):
            if dry_run:
                log(f"dry_send_{i}", step="send", userId=user_id, content=[text])
            else:
                t_send = time.time()
                ok = ui_sub.send_text(d, text)
                cost(
                    "MAIN_SEND_ONE_MSG",
                    t_send,
                    userId=user_id,
                    msgIndex=i,
                    ok=ok,
                    textPreview=(text or "")[:40],
                )
                if not ok:
                    sent_ok = False
                    break
            if i < len(rendered) - 1:
                gap = random.uniform(dmin, dmax)
                wait(
                    "MAIN_MSG_GAP_BETWEEN",
                    gap,
                    userId=user_id,
                    msgIndex=i,
                    msgTotal=len(rendered),
                )

        if not sent_ok:
            api.send_fail(user_id, "send_failed", max_retry=max_retry, device=device)
            if not dry_run:
                ui_sub.go_back(d, wait_tag="MAIN_SEND_FAIL_GO_BACK")
            api.release(user_id, device)
            return "fail"

        last_id = None
        if dry_run:
            last_id = f"dry_send_{next_step}_{int(time.time())}"
        else:
            wait("MAIN_AFTER_SEND_BEFORE_READ", 0.15, userId=user_id)
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
            wait(
                "MAIN_BEFORE_GO_BACK",
                random.uniform(bmin, bmax),
                userId=user_id,
                backDelayMin=bmin,
                backDelayMax=bmax,
            )
            ui_sub.go_back(
                d,
                settle=random.uniform(0.12, 0.25),
                wait_tag="MAIN_SUCCESS_GO_BACK",
            )
            ui_sub.ensure_message_list(d, timeout=2.0)
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
    install_stop_handlers()
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    import api as api_mod
    import ui_sub

    ui_sub.set_stop_checker(check_stop)

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
    t_connect = time.time()
    d = None if dry_run else connect_device(device or None)
    if not dry_run:
        cost("MAIN_CONNECT_DEVICE", t_connect, device=device)

    if not dry_run:
        t_app = time.time()
        app_info = ui_sub.ensure_app(d, package=package)
        cost("MAIN_ENSURE_APP", t_app, device=device, targetPackage=package, **app_info)
        log(
            f"当前界面 appPackage={app_info.get('appPackage')} foreground={app_info.get('foreground')}",
            step="app",
            device=device,
        )
        if not app_info.get("foreground"):
            # 启动后仍不在前台：再推一次，并等广告结束
            t_retry = time.time()
            ui_sub._fast_app_start(d, package)
            wait("MAIN_ENSURE_APP_RETRY", 0.4, package=package)
            foreground = ui_sub.wait_home_ready(d, timeout=10.0)
            app_info = {
                "appPackage": package if foreground else "",
                "started": True,
                "foreground": foreground,
            }
            cost("MAIN_ENSURE_APP_RETRY", t_retry, device=device, targetPackage=package, **app_info)

        t_tab = time.time()
        opened = ui_sub.open_message_tab(d)
        cost("MAIN_OPEN_MESSAGE_TAB", t_tab, device=device, ok=opened, attempt=1)
        if not opened:
            try:
                ui_sub.recover_if_publish_page(d)
                ui_sub._fast_app_start(d, package)
                wait("MAIN_APP_RESTART_BEFORE_MSG_TAB", 0.4, package=package)
                ui_sub.wait_home_ready(d, timeout=10.0)
                ui_sub.dismiss_blocking_dialogs(d)
                ui_sub.recover_if_publish_page(d)
            except Exception:
                pass
            t_tab2 = time.time()
            opened = ui_sub.open_message_tab(d)
            cost("MAIN_OPEN_MESSAGE_TAB", t_tab2, device=device, ok=opened, attempt=2)
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
    # 对话次数 = 成功发送数；CRM 已 done/blocked 等跳过不占额度
    max_picks = max(limit * 10, limit + 20)

    log(
        f"本轮目标：成功发送 {limit} 次（已完成/拉黑的未读会话会跳过且不占次数）",
        step="start_quota",
        limit=limit,
    )

    while success_n < limit and len(selected) < max_picks:
        check_stop()
        if dry_run:
            candidates = [
                {
                    "userId": f"dry_{i}",
                    "displayName": f"测试用户{i}",
                    "raw": f"测试用户{i}",
                    "unread": 1,
                }
                for i in range(1, limit + 1)
            ]
        else:
            t_list = time.time()
            candidates = ui_sub.collect_session_candidates(d, unread_only=True)
            cost(
                "MAIN_COLLECT_CANDIDATES",
                t_list,
                count=len(candidates),
                unreadOnly=True,
                attempt=1,
            )
            if not candidates:
                try:
                    ui_sub.scroll_message_list(d)
                except Exception as e:
                    log(f"滑动列表失败(已忽略): {e}", step="scroll")
                t_list2 = time.time()
                candidates = ui_sub.collect_session_candidates(d, unread_only=True)
                cost(
                    "MAIN_COLLECT_CANDIDATES",
                    t_list2,
                    count=len(candidates),
                    unreadOnly=True,
                    attempt=2,
                )

        if not candidates:
            log("消息列表无未读会话", step="list")
            break

        cand = pick_candidate(candidates, selected)
        if not cand:
            # 下滑再采未读
            if not dry_run:
                try:
                    ui_sub.scroll_message_list(d)
                except Exception as e:
                    log(f"滑动列表失败(已忽略): {e}", step="scroll")
                t_list3 = time.time()
                candidates = ui_sub.collect_session_candidates(d, unread_only=True)
                cost(
                    "MAIN_COLLECT_CANDIDATES",
                    t_list3,
                    count=len(candidates),
                    unreadOnly=True,
                    attempt=3,
                )
                cand = pick_candidate(candidates, selected)
            if not cand:
                log("没有带未读气泡的可处理会话", step="list")
                break

        selected.add(cand["userId"])
        log(
            f"选中 {cand.get('displayName')} ({cand.get('userId')}) unread={cand.get('unread')}",
            step="pick",
            userId=cand.get("userId"),
            unread=int(cand.get("unread") or 0),
            candidateCount=len(candidates),
        )

        t_one = time.time()
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
        cost(
            "MAIN_PROCESS_ONE",
            t_one,
            userId=cand.get("userId"),
            result=result,
            name=cand.get("displayName") or "",
        )
        if result == "success":
            success_n += 1
        elif result == "fail":
            fail_n += 1
        else:
            skip_n += 1

        log(
            f"进度 success={success_n}/{limit} picked={len(selected)} fail={fail_n} skip={skip_n} "
            f"本轮={cand.get('displayName')} result={result}",
            step="next",
            name=cand.get("displayName") or "",
            result=result,
        )

    if success_n < limit and len(selected) >= max_picks:
        log(
            f"已达安全上限 picked={len(selected)}，成功仅 {success_n}/{limit}（多为已完成跳过）",
            step="quota_cap",
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
    except StopRequested as e:
        emit({"type": "done", "ok": False, "msg": f"stopped: {e}", "stopped": True})
        raise SystemExit(0)
    except Exception as e:
        emit({"type": "error", "msg": str(e), "trace": traceback.format_exc()})
        raise SystemExit(1)
