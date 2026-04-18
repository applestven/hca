import uiautomator2 as u2
import time
import common.utils as utils
import sys
sys.stdout.reconfigure(encoding='utf-8')
import json
import common.getSoulMsg as getSoulMsg

import common.sendMsgSoul as sendMsgSoul

d = u2.connect_usb()

print("设备连接成功:", d)

# 如果不在前台才启动 # 等待加载
if d.app_current()['package'] != "cn.soulapp.android":
    d.app_start("cn.soulapp.android")
    time.sleep(1)

print("等待加载完成")

# print(utils.read_chat_content(d))

# print("当前页面结构:", utils.get_current_page(d))
# 将当前页面复制到剪切板

# print("先调试看看结构:")
# getSoulMsg.debug_unread_elements(d)

# print("\n=== 获取未读列表 ===")
# unread_list = getSoulMsg.get_unread_list_accurate(d)
# print(json.dumps(unread_list, ensure_ascii=False, indent=2))

# 滑动点击第一条未读消息
# getSoulMsg.click_first_unread_on_screen(d)

# 滑动到页面最顶部
# utils.scroll_to_top(d)

# print("\n=== 点击第一个未读消息 ===")
# click_first_unread = getSoulMsg.click_first_unread(d)

# print(f"\n共找到 {len(unread_list)} 条未读消息")

# print("\n=== 点击第一个未读 ===")
# getSoulMsg.click_first_unread(d)


# 获取未读消息数量
# message_count = getSoulMsg.get_message_count(d)
# print("当前未读消息数量:", message_count)

# 获取消息列表
# chat_list = getSoulMsg.get_unread_list(d)
# print("消息列表:", chat_list)

# 方法1: 完整信息提取
# chat_info = read_chat_content(d)
# print(json.dumps(chat_info, ensure_ascii=False, indent=2))

# 方法2: 简单文本提取
# texts = utils.read_all_text_messages(d)
# print(texts)
    
# 方法3: 精确提取
# callback = sendMsgSoul.send_message(d, "在干嘛")

# latest_other_messages = getSoulMsg.get_chat_messages_stable(d,5)
# print("用户最新消息:", latest_other_messages)

# 处理消息
# result = utils.process_messages([{"top": 1038, "type": "text", "content": "[吃瓜]", "sender": "me", "timestamp": "3月17日 20:46"}, {"top": 439, "type": "text", "content": "哈喽 你在什么地方呢", "sender": "other"}, {"top": 518, "type": "text", "content": "龙岗五和", "sender": "me"}, {"top": 719, "type": "text", "content": "你呢", "sender": "me"}, {"top": 920, "type": "text", "content": "龙华民治", "sender": "other"}, {"top": 1121, "type": "text", "content": "那很近", "sender": "me"}, {"top": 1322, "type": "text", "content": "但这个地图显示 11km  🤔", "sender": "me"}, {"top": 1716, "type": "text", "content": "我找对象的，你是真心找对象的吗", "sender": "other"}])
# result = utils.process_messages([])


# print(json.dumps(result, ensure_ascii=False))

ai_response = utils.ai_chat([])