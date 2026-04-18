import sys
import time

import uiautomator2 as u2

import chatSoul as chatSoul
import common.getSoulMsg as getSoulMsg
import common.utils as utils

sys.stdout.reconfigure(encoding="utf-8")

PACKAGE_NAME = "cn.soulapp.android"


def connect_device():
    return u2.connect_usb()


def ensure_app_foreground(d) -> bool:
    """确保 Soul 在前台。返回值表示是否原本就在前台。"""
    is_foreground = d.app_current().get("package") == PACKAGE_NAME
    if not is_foreground:
        d.app_start(PACKAGE_NAME)
        time.sleep(2)
    return is_foreground


def handle_first_launch_popups(d) -> None:
    """只在“非前台启动”（疑似冷启动）时处理弹窗/打卡。"""
    utils.click_element(d, "我知道了")
    utils.click_skip_coordinate(d)


def goto_chat_from_home_if_needed(d) -> None:
    """从主页进入灵魂匹配并等待跳到聊天页。"""
    utils.click_element(d, "星球")
    utils.click_element(d, "灵魂匹配")
    while not utils.is_chat_page2(d):
        time.sleep(1)


def open_unread_message_if_any(d) -> bool:
    """如果存在未读消息则进入第一条未读对话。"""
    msg_count = getSoulMsg.get_message_count(d)
    if msg_count > 0:
        print("有未读消息", msg_count)
        utils.click_element(d, "消息")
        utils.scroll_to_top(d)
        getSoulMsg.click_first_unread_on_screen(d)
        return True

    print("没有未读消息")
    return False


def main(d) -> None:
    print("设备连接成功:", d)

    was_foreground = ensure_app_foreground(d)
    print("等待加载完成")

    if not was_foreground:
        handle_first_launch_popups(d)

    # 优先处理“立即私聊”
    in_chat = utils.click_element(d, "立即私聊")
    if in_chat:
        print("立即匹配聊天界面")

    # 未读消息优先级高于主页匹配
    if open_unread_message_if_any(d):
        in_chat = True

    if not in_chat:
        goto_chat_from_home_if_needed(d)

    chatSoul.chat(d)


if __name__ == "__main__":
    d = connect_device()

    for i in range(3):
        print(f"第{i+1}次执行main函数")
        main(d)
        time.sleep(5)
