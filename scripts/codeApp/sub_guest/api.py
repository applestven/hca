"""Sub 获客：与 Electron 主进程 CRM HTTP 通信。"""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

import requests


class SubGuestApi:
    def __init__(self, base_url: Optional[str] = None, timeout: float = 15.0):
        self.base_url = (base_url or "").rstrip("/")
        self.timeout = timeout

    def _url(self, path: str) -> str:
        if not self.base_url:
            raise RuntimeError("HCA_SUB_GUEST_API 未设置：主进程 CRM HTTP 未启动")
        if not path.startswith("/"):
            path = "/" + path
        return self.base_url + path

    def get(self, path: str) -> Any:
        r = requests.get(self._url(path), timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, body: Optional[dict] = None) -> Any:
        r = requests.post(self._url(path), json=body or {}, timeout=self.timeout)
        r.raise_for_status()
        return r.json()

    def health(self) -> dict:
        return self.get("/health")

    def list_scripts(self) -> dict:
        return self.get("/scripts")

    def get_user(self, user_id: str) -> dict:
        return self.get(f"/users/{quote(str(user_id), safe='')}")

    def assign(self, user_id: str, display_name: str = "") -> dict:
        return self.post("/users/assign", {"userId": user_id, "displayName": display_name})

    def claim(self, user_id: str, device: str, ttl_ms: int = 120000) -> dict:
        return self.post("/users/claim", {"userId": user_id, "device": device, "ttlMs": ttl_ms})

    def release(self, user_id: str, device: str) -> dict:
        return self.post("/users/release", {"userId": user_id, "device": device})

    def send_ok(
        self,
        user_id: str,
        *,
        content: list | None = None,
        last_send_message_id: str | None = None,
        max_steps: int | None = None,
        wait_reply: bool = True,
        device: str = "",
    ) -> dict:
        return self.post(
            "/users/send-ok",
            {
                "userId": user_id,
                "content": content or [],
                "lastSendMessageId": last_send_message_id,
                "maxSteps": max_steps,
                "waitReply": wait_reply,
                "device": device,
            },
        )

    def send_fail(
        self,
        user_id: str,
        reason: str,
        *,
        max_retry: int = 3,
        device: str = "",
    ) -> dict:
        return self.post(
            "/users/send-fail",
            {
                "userId": user_id,
                "reason": reason,
                "maxRetry": max_retry,
                "device": device,
            },
        )

    def reply(self, user_id: str, last_reply_message_id: str | None = None, device: str = "") -> dict:
        return self.post(
            "/users/reply",
            {
                "userId": user_id,
                "lastReplyMessageId": last_reply_message_id,
                "device": device,
            },
        )

    def log(self, entry: dict) -> None:
        self.post("/logs", entry)

    def render(self, messages: list, vars: dict | None = None) -> dict:
        return self.post("/render", {"messages": messages, "vars": vars or {}})


def make_message_key(sender: str, text: str, index: int = 0) -> str:
    """无稳定 messageId 时的指纹（跨进程稳定；不含 index，避免滚动后错位）。"""
    import hashlib

    raw = f"{sender}|{(text or '').strip()}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
    return f"mk_{sender}_{digest}"
