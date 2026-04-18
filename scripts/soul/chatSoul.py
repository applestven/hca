import common.getSoulMsg as getSoulMsg
import common.sendMsgSoul as sendMsgSoul
import common.utils as utils


def chat(d) -> bool:
    """进入聊天流程：抓取消息 -> 组装 messages -> 调用 AI -> 发送 -> 返回上一页。"""

    latest_messages = getSoulMsg.get_chat_messages_stable(d, 10)
    print("用户最新10条消息:", latest_messages)

    messages = utils.process_messages(latest_messages)
    print("处理后的消息:", messages)

    ai_response = utils.ai_chat(messages)

    ok = sendMsgSoul.send_message(d, ai_response)

    if ok:
        print("发送成功")
    else:
        print("发送失败")

    sendMsgSoul.go_back(d)
    return ok
