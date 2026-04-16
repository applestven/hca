import React from 'react'
import merge from 'lodash/merge'

import { Modal, message } from 'antd'
// import Loading from '@/components/common/loading';

/**
 * message 消息全局提醒
 * https://ant.design/components/message-cn/
 *
 * e.p：
 * React.$message.info('This is a normal message')
 */
export const MessageContextHolder = () => {
  const [messageApi, contextHolder] = message.useMessage({
    // top: 84
  })

  React.$message = messageApi

  return contextHolder
}

/**
 * confirm 对话框
 * https://ant.design/components/modal-cn/
 *
 * @param {object} config [属性参考如下]
 *
 * 默认属性：
 * center: true
 * icon: <ExclamationCircleOutlined />
 * okText: '确认'
 * cancelText: '取消'
 *
 * 详细属性参考： https://ant.design/components/modal-cn/#Modal.method()
 *
 * e.p：
 * React.$confirm({
 *   title: '标题标题',
 *   content: '内容内容',
 *   onOk: () => {},
 *   onCancel: () => {},
 * });
 */
export const ModalContextHolder = () => {
  const [modal, contextHolder] = Modal.useModal()

  React.$modal = modal

  React.$confirm = (config = {}) => {
    return modal.confirm(
      merge(
        {
          title: '提示',
          width: 500,
          icon: React.$icon('icon-ic_prompt_1', 'anticon'),
          autoFocusButton: null,
          centered: true
        },
        config
      )
    )
  }

  return contextHolder
}
