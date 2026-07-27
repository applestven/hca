# Sub 获客脚本 1.0（架构对齐修订）

> 定位：轻量 CRM + 对话状态机。  
> 对齐本仓库：Electron 主进程 IPC + `userData` 持久化 + 中控 `scriptRunner` 按设备启脚本。  
> 目标：可长期跑、多设备不抢同一用户、失败可重试、等待回复可判定、日志可追加分析。

---

## 0. 本轮相对上一版的修正

| # | 问题 | 修订 |
|---|------|------|
| 1 | `waitingReply` 无法判定「是否新回复」 | 增加 `lastSendMessageId` / `lastReplyMessageId`（及时间兜底） |
| 2 | `step` 在 waiting 时语义冲突 | 改为 `completedStep` + `nextStep` |
| 3 | `users.json` 无限膨胀 | **1.0 即用 SQLite**（`userData/sub_guest.db`）；不用整文件 JSON 当用户库 |
| 4 | 话术无变量 | 预留 `{name}` 等模板变量 |
| 5 | 失败无限重试 | `retryCount` + 超限 `blocked` |
| 6 | `processed` 失败也跳过 | runtime 拆 `selected / success / fail` |
| 7 | 日志 JSON 数组整文件重写 | **JSONL** 按天 append |
| 8 | 多设备业务层重复领取 | `lockedBy` / `lockExpireAt` 任务锁 |
| 9 | 状态字段不足 | 采用下方「最终用户状态」完整模型 |

---

## 1. 与现有项目架构的对齐

| 现有能力 | Sub 获客用法 |
|----------|----------------|
| `scriptRunner` 按 `device` 启 Python | 每个设备一个脚本进程；环境注入 `ANDROID_SERIAL` / `device` |
| `electron-store`（设备/主题等） | **不适合**十万级用户 CRM；仅可用于话术配置、脚本开关等小配置 |
| `app.getPath('userData')` | 放 `sub_guest.db`、`logs/*.jsonl`、默认话术拷贝 |
| 主进程 IPC | 所有用户状态读写、加锁/解锁、写日志走主进程（Python 只负责 UI 自动化） |
| 中控日志 | 脚本 `emit` JSON 行；同时主进程 append JSONL |

推荐职责拆分：

```text
渲染进程：话术弹窗 UI、导入导出、看状态/统计
主进程：  SQLite + 文件锁语义 + IPC + 启停脚本
Python：  点 UI、读消息气泡、发消息；通过 stdin/HTTP/本地 IPC 调主进程存取状态
```

> 实现落地时：Python ↔ 主进程可用「本地 HTTP 小服务」或「命名管道 / 临时请求文件」；优先 **主进程起一个仅本机的状态服务**，脚本用 `requests` 调（项目已有 `requests` 依赖）。具体协议见 §11。

---

## 2. 目录结构

```text
# 随包（可覆盖）
scripts/codeApp/sub_guest/
├── main.py
├── manifest.json
└── scripts.default.json

# userData（长期）
# Windows 例：%APPDATA%/<productName>/sub_guest/
sub_guest/
├── scripts.json                 # 用户话术库（小，可用 electron-store 或单 JSON）
├── sub_guest.db                 # SQLite：users / locks 等
└── logs/
    └── 2026-07-27.jsonl         # 当天流水，一行一条
```

运行时临时（内存或 `userData/sub_guest/runtime/`）：

```text
runtime/{runId}.json             # 本轮 selected/success/fail（可仅内存）
```

---

## 3. 数据模型

### 3.1 最终用户状态（SQLite `users` 表 / 逻辑模型）

```json
{
  "userId": "sub_xxxxx",
  "displayName": "小仙女",
  "scriptId": "default",
  "scriptName": "默认话术",

  "completedStep": 2,
  "nextStep": 3,

  "status": "waiting",
  "waitingReply": true,

  "lastSendMessageId": "msg_send_001",
  "lastSendAt": "2026-07-27 22:30",
  "lastReplyMessageId": "msg_reply_002",
  "lastReplyAt": "2026-07-27 22:35",

  "retryCount": 0,
  "lastFailReason": null,

  "lockedBy": null,
  "lockExpireAt": null,

  "updatedAt": "2026-07-27 22:35"
}
```

| 字段 | 含义 |
|------|------|
| `completedStep` | **已成功发完**的句本序号；无则 `0` |
| `nextStep` | **下一次要执行**的句本序号；从 `1` 开始 |
| `status` | `pending` / `sending` / `waiting` / `success` / `fail` / `blocked` / `done` |
| `waitingReply` | 是否卡在「等对方新回复」 |
| `lastSendMessageId` | 我方最近一次发送成功后，会话里**我方最后一条**消息的稳定 ID |
| `lastReplyMessageId` | 已确认过的对方最后一条消息 ID（推进时更新） |
| `retryCount` | 当前 `nextStep` 连续失败次数 |
| `lockedBy` | 占用设备 serial / runId；空表示可领取 |
| `lockExpireAt` | 锁过期时间（防崩溃死锁） |

**语义无歧义：**

- 要发什么 → 永远看 `nextStep`
- 已经完成到哪 → 看 `completedStep`
- 是否在等回复 → `waitingReply === true` 且 `status === "waiting"`

示例：句本 2 发完在等回复：

```json
{
  "completedStep": 2,
  "nextStep": 3,
  "status": "waiting",
  "waitingReply": true
}
```

下次：若检测到对方新回复 → 保持 `nextStep=3`，`waitingReply=false`，`status=pending`，再发送句本 3。  
若句本 2 **失败**：`completedStep` 仍为 1，`nextStep` 仍为 2，`status=fail`，`retryCount++`。

### 3.2 SQLite 表（建议）

```sql
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  script_id TEXT NOT NULL,
  script_name TEXT,
  completed_step INTEGER NOT NULL DEFAULT 0,
  next_step INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  waiting_reply INTEGER NOT NULL DEFAULT 0,
  last_send_message_id TEXT,
  last_send_at TEXT,
  last_reply_message_id TEXT,
  last_reply_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_fail_reason TEXT,
  locked_by TEXT,
  lock_expire_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_locked ON users(locked_by);
```

日志**不入 SQLite 大表亦可**（见 §3.3 JSONL）；若要做转化率可另建 `events` 表或离线扫 JSONL。

### 3.3 日志 JSONL（按天 append）

`logs/2026-07-27.jsonl`：

```text
{"time":"2026-07-27 22:30","device":"192.168.0.101:33679","runId":"...","userId":"u1","scriptId":"default","action":"send","completedStep":2,"nextStep":3,"content":["你经常玩这个吗","好怕被人发现啊"],"result":"success"}
{"time":"2026-07-27 22:31","device":"...","userId":"u2","action":"skip","reason":"waiting_no_reply"}
```

主进程：`fs.appendFile` 追加一行即可；崩溃也不易整文件损坏。中控 `emit` 与落盘字段对齐。

### 3.4 话术 JSON（变量 + 间隔）

```json
{
  "version": 1,
  "scripts": [
    {
      "id": "default",
      "name": "默认话术",
      "variables": ["name"],
      "steps": [
        {
          "order": 1,
          "messages": ["哈哈 {name}", "你好"],
          "delay": { "min": 2, "max": 5 }
        },
        {
          "order": 2,
          "messages": ["你经常玩这个吗", "好怕被人发现啊"],
          "delay": { "min": 2, "max": 5 }
        },
        {
          "order": 3,
          "messages": ["哈哈哈"],
          "delay": { "min": 1, "max": 3 }
        }
      ]
    }
  ]
}
```

发送前模板渲染：`{name}` ← `displayName`（拿不到则去掉占位或用空串）。未知变量原样保留或清空，行为写死一种并打日志。

默认话术内容不变：1 `哈哈`→`你好`；2 `你经常玩这个吗`→`好怕被人发现啊`；3 `哈哈哈`（默认模板可不强制带 `{name}`）。

---

## 4. 如何判断「对方新回复」（核心）

### 4.1 原则

不能只看「聊天里有没有对方消息」，要看：

> 是否存在 **晚于我方上次发送**、且 **发送者是对方** 的消息。

### 4.2 推荐：消息 ID 差分

发送句本成功后：

1. 读取会话中 **我方最后一条**消息，写入 `lastSendMessageId`（及 `lastSendAt`）。
2. `waitingReply=true`，`completedStep=N`，`nextStep=N+1`，`status=waiting`。

再次进入该会话检测：

```text
扫描对方消息（从新到旧或全量可见区）
若存在消息 M：
  M.sender != 自己
  且 M.id != lastSendMessageId
  且 M.id 不在「已知的我方消息」集合
  且（优先）M.id 比 lastSendMessageId 更新
     或 M.time > lastSendAt
则判定为新回复：
  lastReplyMessageId = M.id
  waitingReply = false
  status = pending
  // nextStep 已是 N+1，直接发送
否则：
  继续 waiting，本轮 skip
```

### 4.3 拿不到稳定 messageId 时的兜底

部分 App 气泡无稳定 ID，则组合指纹：

```text
messageKey = hash(senderSide + text + approxTime + indexInList)
```

仍写入 `lastSendMessageId` / `lastReplyMessageId` 字段（存的是 key）。  
时间戳不准时：用「列表相对位置 + 文本」；并在日志打 `reply_detect_fallback`。

### 4.4 与「不读历史推断进度」的关系

- **进度**：只信 DB 的 `completedStep/nextStep`，不靠历史推断说到第几句。  
- **是否新回复**：打开会话时只需做一次轻量「末尾几条消息」检测，不是全量 CRM 回放。

---

## 5. 失败重试与 blocked

| 条件 | 行为 |
|------|------|
| `status=fail` 且 `retryCount < 3` | 可再次领取，重试同一 `nextStep` |
| `retryCount >= 3` | `status=blocked`，本轮与后续默认跳过（可人工解封） |
| 发送成功 | `retryCount=0`，`lastFailReason=null` |

`lastFailReason` 示例：`send_timeout` / `input_not_found` / `app_not_foreground`。

---

## 6. 设备锁（多设备防抢）

领取用户（事务）：

```text
WHERE (locked_by IS NULL OR lock_expire_at < now)
  AND status NOT IN ('done','blocked')
  AND user_id = ?
→ UPDATE locked_by=deviceSerial, lock_expire_at=now+2min
```

处理结束（成功 / 失败 / skip waiting）：

```text
UPDATE locked_by=NULL, lock_expire_at=NULL
```

崩溃：锁过期后其他设备可抢。  
同一用户不会被两台机同时点开。

`lockedBy` 建议存 **adb serial**（与中控 `device` 一致）。

---

## 7. 本轮 runtime（勿用单一 processed）

```json
{
  "runId": "sub_guest-...",
  "device": "192.168.0.101:33679",
  "limit": 20,
  "selected": ["u1", "u2"],
  "success": ["u1"],
  "fail": ["u2"],
  "skipped": ["u3"]
}
```

规则：

- 点开并尝试处理后 → 进入 `selected`（本轮不再随机到，避免死循环刷同一人）。
- **仅** `success` 算完成额；`fail` 本轮不重复点，但用户状态仍是 `fail`，**下一轮 run** 可再试（未 blocked）。
- `skipped`：waiting 无新回复、被锁、done 等。
- 结束条件：`|selected| >= limit`（或 `|success| >= limit`，产品二选一，**建议按 selected 计次数**，避免一直点不到成功卡死）。

---

## 8. 界面与脚本参数

### 8.1 话术管理

- 最多 100 话术；每话术最多 10 句本；句本内多消息 + `delay`；支持 `{name}`。
- 本地导入导出；默认话术从 `scripts.default.json` 初始化到 `userData/scripts.json`。
- 小配置可用 `electron-store`（如 `subGuest.scripts`）；与用户 CRM 分离。

### 8.2 运行参数

| 参数 | 说明 |
|------|------|
| 对话次数 | 本轮 `selected` 上限 |
| 需对方回复再推进 | 默认 true |
| 最大重试 | 默认 3 |
| 锁超时秒 | 默认 120 |

---

## 9. 主流程

```text
start(device)
  → 确保 DB / scripts 初始化
  → 打开 Sub → 消息列表（可下滑补采）
  → while selected < limit:
      · 解析候选 userId（优先级：用户ID > 主页ID > hash > 昵称）
      · 过滤：本轮 selected、done、blocked、锁未过期且非本机
      · 随机选一人 → tryClaim(userId, device)
      · 读状态：
          · 无记录：随机 scriptId，completedStep=0,nextStep=1,status=pending
          · waiting：末尾消息检测新回复
              · 无 → skip + unlock；continue
              · 有 → waitingReply=false,status=pending
          · fail 且 retryCount>=max → 视为 blocked；continue
      · status=sending；渲染模板；按 delay 发送 nextStep 句本
      · 成功：
          · 记录 lastSendMessageId
          · completedStep=nextStep；nextStep+=1
          · 若 nextStep > max → status=done,waitingReply=false
          · 否则若需等回复 → status=waiting,waitingReply=true
          · 否则 status=pending
          · retryCount=0；appendLog；unlock；success[]
      · 失败：
          · status=fail；retryCount++；记 lastFailReason
          · 若 retryCount>=max → status=blocked
          · nextStep 不变；appendLog；unlock；fail[]
  → done
```

---

## 10. 必要日志节点（emit + JSONL）

| action / step | 内容 |
|---------------|------|
| `start` | device、limit、dbPath |
| `pick` / `claim` / `skip` | userId、reason（locked/waiting/blocked） |
| `reply_check` | lastSendMessageId、detected、lastReplyMessageId |
| `before_send` / `send` / `send_fail` | nextStep、content、retryCount |
| `state_write` | completedStep、nextStep、status、waitingReply |
| `done` / `error` | 汇总 |

---

## 11. IPC / 本地状态服务（建议）

主进程模块：`src/main/utils/subGuestStore.js`

| 方法 | 说明 |
|------|------|
| `init()` | 建库、拷贝默认话术 |
| `listScripts / saveScripts` | 话术 |
| `getUser / upsertUser` | 用户状态 |
| `claimUser / releaseUser` | 设备锁 |
| `appendLog(line)` | JSONL |
| `render?` | 可选：模板在主进程或脚本侧 |

Python：启动时读环境变量 `HCA_SUB_GUEST_API=http://127.0.0.1:<port>`（主进程随 App 启动的本机服务），所有状态变更走 HTTP，避免多 Python 进程抢 SQLite 写（SQLite 也可只给主进程用）。

---

## 12. 验收清单

- [ ] `completedStep` / `nextStep` 语义清晰；失败不推进 `nextStep`
- [ ] `waitingReply` 依赖 `lastSendMessageId` 差分，而非「有对方消息」
- [ ] 用户数据在 SQLite（`userData`），日志 JSONL append
- [ ] `retryCount` → `blocked`
- [ ] 话术支持 `delay` + `{name}`
- [ ] runtime 区分 selected/success/fail
- [ ] `lockedBy` 多设备互斥 + 过期释放
- [ ] 连接指定 `device`，禁止裸 `connect_usb()`
- [ ] 中控可见关键 emit，磁盘有对应 JSONL

---

## 13. 明确不做（本版本）

- 不用「按天 users JSON」当状态库  
- 不用整文件 JSON 数组追加日志  
- 不把可变昵称当主键  
- 不在发送失败时把 `nextStep` +1  

---

## 14. 总结

按本仓库架构，Sub 获客 = **主进程 SQLite CRM** + **脚本只做自动化** + **JSONL 审计日志**。  
状态机以 `completedStep/nextStep` + `lastSendMessageId` 为核心，即可长期运行且可解释。
