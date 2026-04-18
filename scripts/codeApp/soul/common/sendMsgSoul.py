import time
import common.utils as utils

# 发送文本消息
def send_message(d, text, input_box_hint=None, wait_time=1):
    """
    发送文本消息
    
    Args:
        d: uiautomator2设备对象
        text: 要发送的消息内容
        input_box_hint: 输入框提示文字（可选，用于定位输入框）
        wait_time: 发送后等待时间（秒）
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        # 方法1: 通过 resource-id 定位输入框
        input_box = d(resourceId="cn.soulapp.android:id/et_sendmessage")
        
        if not input_box.exists:
            # 方法2: 通过类名和提示文字定位
            input_box = d(className="android.widget.EditText", 
                         text=input_box_hint) if input_box_hint else d(className="android.widget.EditText")
        
        if not input_box.exists:
            print("未找到输入框")
            return False
        
        # 点击输入框获取焦点
        input_box.click()
        time.sleep(0.3)
        
        # 清空输入框（可选）
        input_box.clear_text()
        
        # 输入文本
        input_box.set_text(text)
        time.sleep(0.2)
        
        # 方法1: 通过发送按钮发送（如果有）
        send_btn = d(resourceId="cn.soulapp.android:id/menu_tab_send")  # 可能需要确认实际ID
        if send_btn.exists:
            send_btn.click()
        elif d(text="发送").exists:
            utils.click_element(d, "发送")
        else:
            # 方法2: 通过键盘发送按钮
            d.press("enter")
            # 或者 d.press("back") 某些输入法用回车发送
        
        time.sleep(wait_time)
        print(f"消息发送成功: {text[:50]}...")
        return True
        
    except Exception as e:
        print(f"发送消息失败: {e}")
        return False


def send_quick_reply(d, reply_text, wait_time=1):
    """
    发送快捷回复（点击预设的快捷回复选项）
    
    Args:
        d: uiautomator2设备对象
        reply_text: 快捷回复的文本内容（如"下午好"、"礼物"等）
        wait_time: 发送后等待时间（秒）
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        # 查找快捷回复选项
        quick_reply = d(text=reply_text, 
                        resourceId="cn.soulapp.android:id/tv_menu_text")
        
        if not quick_reply.exists:
            # 尝试通过类名和文本查找
            quick_reply = d(className="android.widget.TextView", text=reply_text)
        
        if quick_reply.exists:
            quick_reply.click()
            time.sleep(wait_time)
            print(f"快捷回复发送成功: {reply_text}")
            return True
        else:
            print(f"未找到快捷回复选项: {reply_text}")
            return False
            
    except Exception as e:
        print(f"发送快捷回复失败: {e}")
        return False


def send_voice_message(d, duration=2, wait_time=2):
    """
    发送语音消息（长按录音按钮）
    
    Args:
        d: uiautomator2设备对象
        duration: 录音时长（秒）
        wait_time: 发送后等待时间（秒）
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        # 切换到语音输入模式
        voice_btn = d(resourceId="cn.soulapp.android:id/menu_tab_voice_inner")
        if voice_btn.exists:
            voice_btn.click()
            time.sleep(0.5)
        
        # 长按录音按钮
        record_btn = d(resourceId="cn.soulapp.android:id/voice_record_btn")
        if not record_btn.exists:
            # 尝试其他可能的ID
            record_btn = d(description="按住 说话")
        
        if record_btn.exists:
            # 长按录音
            record_btn.long_click(duration=duration)
            time.sleep(wait_time)
            print(f"语音消息发送成功，时长: {duration}秒")
            return True
        else:
            print("未找到录音按钮")
            return False
            
    except Exception as e:
        print(f"发送语音消息失败: {e}")
        return False


def send_image(d, image_path, wait_time=2):
    """
    发送图片消息
    
    Args:
        d: uiautomator2设备对象
        image_path: 图片文件路径
        wait_time: 发送后等待时间（秒）
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        # 点击更多按钮打开菜单
        more_btn = d(resourceId="cn.soulapp.android:id/menu_tab_more_inner")
        if more_btn.exists:
            more_btn.click()
            time.sleep(0.5)
        
        # 选择图片按钮（需要根据实际UI调整）
        image_btn = d(text="图片")
        if not image_btn.exists:
            image_btn = d(description="相册")
        
        if image_btn.exists:
            image_btn.click()
            time.sleep(1)
            
            # 选择图片（需要根据实际文件管理器调整）
            # 这里需要根据具体图片选择界面实现
            # 示例：选择最近的一张图片
            first_image = d(className="android.widget.ImageView", index=0)
            if first_image.exists:
                first_image.click()
                time.sleep(0.5)
                
                # 点击发送按钮
                send_btn = d(text="发送")
                if send_btn.exists:
                    send_btn.click()
                    time.sleep(wait_time)
                    print("图片发送成功")
                    return True
        
        print("发送图片失败")
        return False
        
    except Exception as e:
        print(f"发送图片失败: {e}")
        return False

# 返回上一页
def go_back(d):
    """
    返回上一页
    
    Args:
        d: uiautomator2设备对象
        
    Returns:
        bool: 成功返回True，失败返回False
    """
    try:
        back_btn = d(resourceId="cn.soulapp.android:id/item_left_back")
        if back_btn.exists:
            back_btn.click()
            time.sleep(0.5)
            return True
        else:
            # 尝试系统返回键
            d.press("back")
            time.sleep(0.5)
            return True
    except Exception as e:
        print(f"返回失败: {e}")
        return False


class SoulChat:
    """
    Soul聊天类，封装常用聊天操作
    """
    
    def __init__(self, d):
        """
        初始化
        
        Args:
            d: uiautomator2设备对象
        """
        self.d = d
        
        # 定义资源ID
        self.IDS = {
            'input_box': 'cn.soulapp.android:id/et_sendmessage',
            'voice_btn': 'cn.soulapp.android:id/menu_tab_voice_inner',
            'emoji_btn': 'cn.soulapp.android:id/menu_tab_emoji',
            'more_btn': 'cn.soulapp.android:id/menu_tab_more_inner',
            'follow_btn': 'cn.soulapp.android:id/chat_follow_btn',
            'back_btn': 'cn.soulapp.android:id/item_left_back',
        }
    
    def send_text(self, text, wait=True):
        """
        发送文本消息
        
        Args:
            text: 消息内容
            wait: 是否等待发送完成
            
        Returns:
            bool: 是否成功
        """
        try:
            input_box = self.d(resourceId=self.IDS['input_box'])
            if not input_box.exists:
                print("输入框不存在")
                return False
            
            input_box.click()
            time.sleep(0.2)
            input_box.clear_text()
            input_box.set_text(text)
            time.sleep(0.2)
            
            # 发送
            self.d.press("enter")
            
            if wait:
                time.sleep(0.5)
            
            print(f"已发送: {text[:30]}...")
            return True
            
        except Exception as e:
            print(f"发送失败: {e}")
            return False
    
    def send_quick_reply(self, text):
        """
        发送快捷回复
        
        Args:
            text: 快捷回复文本
            
        Returns:
            bool: 是否成功
        """
        try:
            reply = self.d(resourceId="cn.soulapp.android:id/tv_menu_text", text=text)
            if reply.exists:
                reply.click()
                time.sleep(0.5)
                print(f"快捷回复: {text}")
                return True
            else:
                print(f"快捷回复不存在: {text}")
                return False
        except Exception as e:
            print(f"快捷回复失败: {e}")
            return False
    
    def send_voice(self, duration=2):
        """
        发送语音消息
        
        Args:
            duration: 录音时长（秒）
            
        Returns:
            bool: 是否成功
        """
        try:
            # 切换到语音模式
            voice_btn = self.d(resourceId=self.IDS['voice_btn'])
            if voice_btn.exists:
                voice_btn.click()
                time.sleep(0.3)
            
            # 长按录音
            record_btn = self.d(className="android.view.View", 
                               description="按住 说话")
            if record_btn.exists:
                record_btn.long_click(duration=duration)
                time.sleep(0.5)
                print(f"语音已发送 ({duration}秒)")
                return True
            else:
                print("未找到录音按钮")
                return False
        except Exception as e:
            print(f"语音发送失败: {e}")
            return False
    
    def go_back(self):
        """返回上一页"""
        back_btn = self.d(resourceId=self.IDS['back_btn'])
        if back_btn.exists:
            back_btn.click()
            time.sleep(0.5)
            return True
        return False
    
    def get_input_hint(self):
        """获取输入框提示文字"""
        input_box = self.d(resourceId=self.IDS['input_box'])
        if input_box.exists:
            hint = input_box.info.get('text', '')
            if not hint:
                hint = input_box.attrib.get('hint', '')
            return hint
        return None
    
    def clear_input(self):
        """清空输入框"""
        input_box = self.d(resourceId=self.IDS['input_box'])
        if input_box.exists:
            input_box.click()
            input_box.clear_text()
            return True
        return False


# 使用示例
if __name__ == "__main__":
    # import uiautomator2 as u2
    # d = u2.connect()
    
    # ========== 方式1: 函数式调用 ==========
    # 发送普通文本
    # send_message(d, "你好呀")
    
    # 发送快捷回复
    # send_quick_reply(d, "下午好")
    
    # 发送语音
    # send_voice_message(d, duration=3)
    
    # ========== 方式2: 面向对象调用（推荐） ==========
    # chat = SoulChat(d)
    
    # 发送文本
    # chat.send_text("你好，很高兴认识你")
    
    # 发送快捷回复
    # chat.send_quick_reply("下午好")
    
    # 发送语音
    # chat.send_voice(duration=2)
    
    # 获取输入框提示
    # hint = chat.get_input_hint()
    # print(f"输入框提示: {hint}")
    
    # 返回上一页
    # chat.go_back()
    
    pass