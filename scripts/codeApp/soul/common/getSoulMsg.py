import time
import re
import time
import hashlib

# ----------------- 获取基础信息-----------------------------------

def get_nickname(d):
    """
    获取当前聊天对象的昵称
    
    Args:
        d: uiautomator2设备对象
        
    Returns:
        str: 对方昵称，如果获取失败返回None
    """
    try:
        # 方法1: 通过 resource-id 获取
        nickname_elem = d(resourceId="cn.soulapp.android:id/tv_title")
        if nickname_elem.exists:
            nickname = nickname_elem.get_text()
            if nickname and nickname.strip():
                return nickname.strip()
        
        # 方法2: 通过文本特征获取（如果resource-id失效）
        # 查找顶部的TextView，排除"返回"、"聊天设置"等按钮
        top_bar = d(className="android.widget.TextView", 
                    resourceId="android:id/text1")
        if top_bar.exists:
            text = top_bar.get_text()
            if text and text.strip() and len(text) < 20:  # 昵称通常较短
                return text.strip()
        
        # 方法3: 通过XPath定位
        nickname_elem = d.xpath('//android.widget.TextView[@resource-id="cn.soulapp.android:id/tv_title"]')
        if nickname_elem.exists:
            return nickname_elem.get_text().strip()
        
        return None
        
    except Exception as e:
        print(f"获取昵称失败: {e}")
        return None


def get_chat_info(d):
    """
    获取聊天界面的完整信息（昵称、在线状态等）
    
    Args:
        d: uiautomator2设备对象
        
    Returns:
        dict: 包含昵称、在线状态、亲密关系等信息
    """
    info = {
        "nickname": None,
        "online_status": None,
        "intimacy_action": None,
        "relation_status": None
    }
    
    try:
        # 获取昵称
        nickname = d(resourceId="cn.soulapp.android:id/tv_title")
        if nickname.exists:
            info["nickname"] = nickname.get_text()
        
        # 获取在线状态/最后活跃时间
        online_label = d(resourceId="cn.soulapp.android:id/tv_online_label")
        if online_label.exists:
            info["online_status"] = online_label.get_text()
        
        # 获取亲密关系操作按钮文本（如"加速"）
        intimacy_btn = d(resourceId="cn.soulapp.android:id/tv_soulmate_speed")
        if intimacy_btn.exists:
            info["intimacy_action"] = intimacy_btn.get_text()
        
        # 获取关注状态
        follow_btn = d(resourceId="cn.soulapp.android:id/chat_follow_btn")
        if follow_btn.exists:
            info["relation_status"] = follow_btn.get_text()
            
    except Exception as e:
        print(f"获取聊天信息失败: {e}")
    
    return info

def get_latest_other_messages(d, max_scan=20):
    """
    获取对方最新消息（如果最后一条是我发的则返回空）
    
    Returns:
        list: 对方连续发送的最新消息（按时间顺序）
    """

    # 1. 拿最近消息
    messages = get_chat_messages_stable(d, max_count=max_scan)

    if not messages:
        return []

    # 2. 从最后一条开始判断
    last_msg = messages[-1]

    # ❌ 如果最后一条是我发的 → 直接返回空
    if last_msg.get("sender") == "me":
        return []

    # 3. 向上收集“连续的对方消息”
    result = []

    for msg in reversed(messages):
        if msg.get("sender") == "other":
            result.insert(0, msg)  # 保持时间顺序
        else:
            break  # 遇到我发的就停止

    return result

# 使用示例
if __name__ == "__main__":
    # import uiautomator2 as u2
    # d = u2.connect()
    
    # 只获取昵称
    # nickname = get_nickname(d)
    # print(f"对方昵称: {nickname}")
    
    # 获取完整信息
    # info = get_chat_info(d)
    # print(f"昵称: {info['nickname']}")
    # print(f"状态: {info['online_status']}")
    # print(f"操作: {info['intimacy_action']}")
    # print(f"关系: {info['relation_status']}")
    
    pass
        



#  ------------------------------ 获取消息 -----------------------------
def _get_msg_fingerprint(messages):
    """
    生成消息指纹（用于判断是否加载了新内容）
    """
    raw = "|".join([m["content"] for m in messages])
    return hashlib.md5(raw.encode()).hexdigest()


def _safe_scroll_up(d):
    """
    稳定滑动（优先使用控件，其次坐标兜底）
    """
    try:
        chat_list = d(className="androidx.recyclerview.widget.RecyclerView")

        if chat_list.exists:
            # 优先用系统滚动（最稳定）
            chat_list.scroll.vert.backward()
        else:
            raise Exception("no recycler view")

    except Exception:
        # 兜底：使用坐标滑动
        w, h = d.window_size()

        d.swipe(
            int(w * 0.5),
            int(h * 0.75),
            int(w * 0.5),
            int(h * 0.25),
            duration=0.2
        )

    # 等待加载（必须）
    time.sleep(1)

# 稳定版聊天抓取（支持滚动加载）
def get_chat_messages_stable(d, max_count=10, max_scroll=15):
    """
    稳定版聊天抓取（支持滚动加载）
    """

    all_messages = []
    seen_keys = set()

    last_fp = ""
    no_change_count = 0

    for i in range(max_scroll):
        # 1. 抓当前屏幕
        page_msgs = _extract_page_messages(d, exclude_system=True)

        # 2. 去重 + 插入（保证时间顺序）
        for msg in reversed(page_msgs):
            key = f"{msg['content']}_{msg.get('bounds', '')}"

            if key not in seen_keys:
                seen_keys.add(key)
                all_messages.insert(0, msg)

        # 3. 截断数量
        if len(all_messages) >= max_count:
            return all_messages[-max_count:]

        # 4. 判断是否加载到头（关键优化点）
        fp = _get_msg_fingerprint(page_msgs)

        if fp == last_fp:
            no_change_count += 1
        else:
            no_change_count = 0
            last_fp = fp

        # 连续2次没变化 → 到顶
        if no_change_count >= 2:
            break

        # 5. 滚动加载
        _safe_scroll_up(d)

    return all_messages[-max_count:]

#  获取当前页面的消息
def _extract_page_messages(d, exclude_system=True):
    """
    提取当前页面的消息
    
    Args:
        d: uiautomator2设备对象
        exclude_system: 是否排除系统消息
        
    Returns:
        list: 当前页面的消息列表
    """
    messages = []
    
    # 获取聊天区域的所有消息项
    message_items = d(resourceId="cn.soulapp.android:id/item_root")
    
    for item in message_items:
        try:
            msg = {}
            
            # 获取消息的位置信息
            bounds = item.info.get('bounds', {})
            msg['top'] = bounds.get('top', 0)
            
            # 检查是否是系统消息
            system_text = item.child(resourceId="cn.soulapp.android:id/spannable_text")
            if system_text.exists:
                if not exclude_system:
                    msg['type'] = 'system'
                    msg['content'] = system_text.get_text()
                    msg['sender'] = 'system'
                    messages.append(msg)
                continue
            
            # 获取文本消息
            content_text = item.child(resourceId="cn.soulapp.android:id/content_text")
            if content_text.exists:
                msg['type'] = 'text'
                msg['content'] = content_text.get_text()
                
                # 判断发送者
                avatar = item.child(resourceId="cn.soulapp.android:id/avatar")
                if avatar.exists:
                    avatar_bounds = avatar.info.get('bounds', {})
                    left = avatar_bounds.get('left', 0)
                    if left < 200:
                        msg['sender'] = 'other'
                    elif left > 800:
                        msg['sender'] = 'me'
                
                # 获取时间戳
                timestamp = item.child(resourceId="cn.soulapp.android:id/timestamp")
                if timestamp.exists:
                    msg['timestamp'] = timestamp.get_text()
                
                if msg.get('content'):
                    messages.append(msg)
            
            # 获取图片消息
            image_view = item.child(resourceId="cn.soulapp.android:id/img_static")
            if image_view.exists and 'content' not in msg:
                msg['type'] = 'image'
                msg['content'] = '[图片消息]'
                
                avatar = item.child(resourceId="cn.soulapp.android:id/avatar")
                if avatar.exists:
                    avatar_bounds = avatar.info.get('bounds', {})
                    left = avatar_bounds.get('left', 0)
                    msg['sender'] = 'other' if left < 200 else 'me'
                
                messages.append(msg)
                
        except Exception as e:
            continue
    
    # 按位置排序（从上到下）
    messages.sort(key=lambda x: x.get('top', 0))
    
    return messages


# 最简单的实现：直接获取指定条数 没有sender和timestamp等信息，只有纯文本内容数组
def get_n_messages(d, n=20):
    """
    最简单的实现：获取N条消息
    
    Args:
        d: uiautomator2设备对象
        n: 需要获取的消息条数
        
    Returns:
        list: 消息列表
    """
    # 先滚动到底部（最新消息）
    d.swipe(540, 1500, 540, 500, duration=0.3)
    time.sleep(0.5)
    
    messages = []
    seen = set()
    
    while len(messages) < n:
        # 获取所有文本消息
        texts = d(resourceId="cn.soulapp.android:id/content_text")
        
        # 从下往上收集
        for i in range(len(texts) - 1, -1, -1):
            try:
                text = texts[i].get_text()
                if text and text.strip() and text not in seen:
                    seen.add(text)
                    messages.insert(0, text.strip())
                    if len(messages) >= n:
                        break
            except:
                pass
        
        if len(messages) >= n:
            break
        
        # 向上滚动加载更多
        d.swipe(540, 600, 540, 1000, duration=0.3)
        time.sleep(0.5)
    
    return messages[-n:]  # 返回最新的N条

# 获取未读消息数量
def get_message_count(d):
    """
    获取当前聊天的未读消息数量

    Args:
        d: uiautomator2设备对象

    Returns:
        int: 消息数量
    """
    # return len(d(resourceId="cn.soulapp.android:id/content_text"))
    
    # 查找未读消息红点
    red_dot = d(resourceId="cn.soulapp.android:id/main_tab_msg_red_dot")
    if red_dot.exists:
        return int(red_dot.get_text())
    return 0

# 获取当前一页的消息列表
def get_chat_list(d):
    """获取聊天列表"""
    chats = []
    
    # 查找所有聊天项
    items = d(resourceId="cn.soulapp.android:id/item_content_root")
    
    for item in items:
        try:
            # 获取聊天名称
            name = item.child(resourceId="cn.soulapp.android:id/name")
            # 获取最后一条消息
            message = item.child(resourceId="cn.soulapp.android:id/message")
            # 获取时间
            time = item.child(resourceId="cn.soulapp.android:id/time")
            
            chat_info = {
                'name': name.get_text() if name.exists else "",
                'last_message': message.get_text() if message.exists else "",
                'time': time.get_text() if time.exists else "",
            }
            chats.append(chat_info)
        except:
            continue
    
    return chats

def get_unread_list(d):
    """获取所有未读消息"""
    unread = []
    
    # 查找所有带有未读数字的聊天项
    items = d(resourceId="cn.soulapp.android:id/item_content_root")
    
    for item in items:
        # 查找未读数字
        unread_badge = item.child(resourceId="cn.soulapp.android:id/unread_msg_number")
        if unread_badge.exists:
            unread_num = unread_badge.get_text()
            if unread_num and unread_num != "0":
                name = item.child(resourceId="cn.soulapp.android:id/name").get_text()
                message = item.child(resourceId="cn.soulapp.android:id/message").get_text()
                unread.append({
                    'name': name,
                    'message': message,
                    'unread_count': unread_num,
                    'element': item  # 保存元素对象，方便点击
                })
                print(f"未读: {name} ({unread_num}条) - {message[:30]}")
    
    return unread



# 使用示例
if __name__ == "__main__":
    # import uiautomator2 as u2
    # d = u2.connect()
    
    # 最简单用法
    # msgs = get_n_messages(d, 20)
    # for msg in msgs:
    #     print(msg)
    
    # 带发送者信息
    # msgs = get_chat_messages_v2(d, max_count=20)
    # for msg in msgs:
    #     print(f"[{msg['sender']}] {msg['content']}")
    
    pass


# 获取未读消息列表
def get_unread_list_accurate(d, max_scroll=10):
    unread_map = {}

    # ✅ 获取系统未读总数（目标值）
    target_count = get_message_count(d)
    print("系统未读总数:", target_count)

    for i in range(max_scroll):
        print(f"第{i+1}次扫描...")

        xml = d.dump_hierarchy()
        root = ET.fromstring(xml)

        for node in root.iter():
            if node.attrib.get("resource-id") == "cn.soulapp.android:id/unread_msg_number":
                unread_num = node.attrib.get("text", "")

                # 👉 有些是红点无数字
                if not unread_num:
                    unread_num = "1"

                if unread_num == "0":
                    continue

                # ✅ 找父容器
                parent = node
                for _ in range(10):
                    parent = find_parent(root, parent)
                    if not parent:
                        break
                    if parent.attrib.get("resource-id") == "cn.soulapp.android:id/item_content_root":
                        break

                if not parent:
                    continue

                name = ""
                message = ""

                for child in parent.iter():
                    rid = child.attrib.get("resource-id")
                    txt = child.attrib.get("text", "")

                    if rid == "cn.soulapp.android:id/name":
                        name = txt
                    elif rid == "cn.soulapp.android:id/message":
                        message = txt

                bounds = parent.attrib.get("bounds")

                if name:
                    unread_map[name] = {
                        "name": name,
                        "message": message,
                        "unread_count": int(unread_num),
                        "bounds": bounds
                    }

        # ✅ 当前扫描到的未读总数
        current_total = sum(i["unread_count"] for i in unread_map.values())

        print(f"当前累计未读: {current_total}")

        # ✅ 核心优化：达到目标就停止
        if current_total >= target_count:
            print("已达到系统未读数，停止扫描")
            break

        # ✅ 滑动
        d.swipe(500, 1600, 500, 400, 0.3)
        time.sleep(0.5)

    unread = list(unread_map.values())

    print("\n最终未读列表：")
    for item in unread:
        print(f"{item['name']} ({item['unread_count']}) - {item['message']}")

    return unread

def find_parent(root, target):
    for node in root.iter():
        for child in node:
            if child is target:
                return node
    return None

# 配合get_unread_list_accurate使用：根据bounds点击对应聊天项（需要调整坐标偏移以点击到中间位置）
def click_by_bounds(d, bounds):
    nums = list(map(int, re.findall(r'\d+', bounds)))

    x = nums[0] + 300
    y = (nums[1] + nums[3]) // 2

    d.click(x, y)

# 点击第一个未读消息（配合get_unread_list_accurate使用）
def click_first_unread_1(d):
    unread = get_unread_list_accurate(d)

    if not unread:
        print("没有未读消息")
        return False

    first = unread[0]

    print(f"点击第一个未读: {first['name']} ({first['unread_count']})")

    click_by_bounds(d, first["bounds"])

    return True

# 滑动点击第一个未读消息
def click_first_unread_on_screen(d, max_scroll=10):
    import xml.etree.ElementTree as ET
    import re
    import time

    # ✅ 1. 先判断有没有未读
    total_unread = get_message_count(d)
    print("系统未读数:", total_unread)

    if total_unread == 0:
        print("没有未读消息")
        return False

    # ✅ 2. 开始滑动查找
    for i in range(max_scroll):
        print(f"第{i+1}次查找未读...")

        xml = d.dump_hierarchy()
        root = ET.fromstring(xml)

        candidates = []

        for node in root.iter():
            if node.attrib.get("resource-id") == "cn.soulapp.android:id/unread_msg_number":
                unread_num = node.attrib.get("text", "") or "1"

                if unread_num == "0":
                    continue

                parent = node
                for _ in range(10):
                    parent = find_parent(root, parent)
                    if not parent:
                        break
                    if parent.attrib.get("resource-id") == "cn.soulapp.android:id/item_content_root":
                        break

                if not parent:
                    continue

                bounds = parent.attrib.get("bounds")

                # 计算y（用于排序）
                nums = list(map(int, re.findall(r'\d+', bounds)))
                y = nums[1]

                candidates.append((y, bounds))

        # ✅ 当前屏幕找到了未读 → 直接点最上面的
        if candidates:
            candidates.sort(key=lambda x: x[0])
            top_bounds = candidates[0][1]

            print("找到未读，点击最上面的")
            click_by_bounds(d, top_bounds)
            time.sleep(1)

            return True

        # ❌ 当前屏幕没有 → 滑动继续找
        print("当前屏幕没有未读，继续滑动")
        d.swipe(500, 1600, 500, 400, 0.3)
        time.sleep(0.5)

    print("滑动结束，仍未找到未读")
    return False