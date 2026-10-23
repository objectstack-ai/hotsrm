# 03 · 业务流程与自动化

> 所属：[SRM 设计总览](./README.md)　·　上一篇：[02 领域模型](./02-domain-model.md)　·　下一篇：[04 权限与门户](./04-security-and-portal.md)

## 1. 流程总览

| 编号 | 流程 | 起点 → 终点 | 涉及对象 | 期次 |
|---|---|---|---|---|
| P1 | 供应商注册与准入 | 公开表单提交 → 合格供应商 | 准入申请、审核、供应商、品类资格 | 一期 |
| P2 | 信息变更与供应商处置 | 变更 / 处置申请 → 档案更新 | 变更单、处置单、供应商、银行账户 | 二期 |
| P3 | 寻源：询价 → 比价 → 定标 | 寻源单草稿 → 价格记录 | 寻源单、邀请、报价、价格记录 | 一期 |
| P4 | 合同审批、签署与到期 | 合同草稿 → 生效 → 到期 | 合同 | 二期 |
| P5 | 订单协同 | ERP 下发 PO → 供应商确认 | 订单、订单行 | 二期 |
| P6 | 送货与收货 | 送货单 → 收货回传 | 送货单、收货记录、订单行 | 二期 |
| P7 | 来料检验与质量整改 | 检验不合格 → SCAR 关闭 | 检验、整改单 | 三期 |
| P8 | 对账与结算 | 月度对账单 → 付款回写 | 对账单、发票、收货记录 | 四期 |
| P9 | 季度绩效评估 | 自动生成考评 → 发布与应用 | 考评单、评分明细、供应商 | 三期 |
| P10 | 资质与风险监控 | 到期 / 外部风险 → 预警与处置 | 证书、风险事件、供应商 | 一期 / 四期 |

## 2. 平台机制与本设计的用法

### 2.1 用到的平台能力

| 能力 | 平台机制 | 在 SRM 中的典型用法 |
|---|---|---|
| 记录触发 | flow 类型 `record_change`，在开始节点上声明对象、触发时机与 CEL 条件 | 状态变为「准入评审」时发起审批；检验不合格时生成 SCAR |
| 定时任务 | `schedule` 触发（cron） | 截标扫描、月度对账、季度绩效 |
| 相对日期 | `time_relative` 触发：按某个日期字段，在提前 / 逾期若干天时对每条记录各启动一次 | 证书到期 30 / 15 / 7 天提醒、合同到期提醒 |
| 外部调用入口 | `api` 触发 | ERP 回调、外部调度器触发关键扫描（见 §2.3） |
| 审批 | flow 的 `approval` 节点：审批人类型 `user` / `field` / `manager` / `position` / `expression` 等；会签方式 `first_response` / `unanimous`；可退回修改；超时可升级 | 准入、定标、合同、变更、处置、绩效发布 |
| 数据节点 | `get_record` / `create_record` / `update_record` / `loop` / `decision` / `assignment` | 定标后批量生成价格记录 |
| 通知 | `notify` 节点（站内 / 邮件等通道） | 邀请、待办、提醒、升级 |
| 外部系统 | `http` 节点、webhook | 推送 ERP、电子签、企业信息查询 |
| 状态约束 | `state_machine` 校验规则（`transitions` + `initialStates`） | 所有单据的状态跳转 |
| 记录校验 | `script` / `cross_field` 校验规则（CEL，可用 `now()` / `today()`，可经一个引用字段读关联记录） | 截止后锁价、开标时限、邀请供应商的状态兜底、条件必填 |
| 受控写入口 | `screen` 类型的 flow，以系统身份运行，用户对目标对象**没有**直接创建权限 | 邀请供应商、建送货单、提交发票等需要跨对象判断的写操作 |

三条贯穿全文的取舍：

- **全部用元数据表达，托管云今天就能运行**。在托管云上安装应用包时，平台只合并包里
  的元数据，包里的代码函数（钩子、任务处理函数、插件）不会执行。因此本设计不依赖
  任何应用代码；需要代码的增强只在自托管部署中启用，并单独标注。
- **校验规则能读本记录和一跳关联记录**（如 `record.supplier.status`），更远或需要
  汇总的判断用两种声明式办法强制：
  1. **冗余 + 校验**：把判断所需的值在创建时冗余到本记录（例如把寻源单的截止时间
     复制到报价单，报价明细再经一跳读取），再用校验规则判断；
  2. **受控写入口**：敏感的创建动作只开放为 `screen` flow（以系统身份运行，flow 里
     查询、判断、再写入），用户对目标对象本身不授予创建权限。
- **界面过滤只是体验，不是强制**：选择器上的 `lookupFilters`（例如只列合格供应商）
  能减少误操作，但绕过界面直接调 API 时它不起作用，所以每条强制规则都必须落在上面
  两种办法之一。

### 2.2 审批能力的使用范围

本设计的审批只用基础能力：单人 / 串行多级、`user` / `field` / `manager` /
`position` 审批人、简单并行（`unanimous` / `first_response`）、撤回、锁记录和
不可篡改的审批历史。

按部门树递归找审批人、按比例会签（quorum）、运行时加签、委派与离岗改派、审批
分析看板等更高级的能力，都标为「可选增强」，不作为任何流程成立的前提。

审批超时（`timeoutHours`）按**日历小时**计算，夜间、周末、节假日都计入。「3 个
工作日」这类要求写成 72 小时会在长假前后失真，因此本设计把「工作日」口径的时限
放在业务字段（如 `containment_due`）里计算，由扫描任务判断逾期，而不是依赖审批
超时。

### 2.3 定时任务的可靠性设计

定时类 flow（`schedule` / `time_relative`）的触发可能因为部署环境的原因延迟或
漏掉一次，SRM 的业务规则不能建立在「计时器一定准时」的假设上。另外，生产环境要
确认所用的部署方式和套餐支持定时任务。

本设计遵守三条规则：

| 规则 | 做法 |
|---|---|
| R1 强制性规则不依赖计时器 | 「截止后不能改报价」由校验规则在**写入时**用 `now()` 比较冗余在报价上的截止时间；「截止前不能开标」由寻源单的校验规则比较 `locked_deadline`。计时器失灵也不会放过一次越界写入 |
| R2 扫描任务是追赶式且幂等的 | 每次扫描处理「所有已到期而尚未处理」的记录，而不是「今天到期」的记录；处理后打标记，重复运行不重复处理。漏掉一次，下一次自动补上 |
| R3 关键扫描有外部心跳 | 截标、PO 催办、SCAR 逾期这三个时效敏感的扫描，同时暴露为 `api` 触发的 flow，由外部调度器（ERP 中间件或运维定时任务）每 10 分钟调用一次，保证准时 |

## 3. P1 供应商注册与准入

```mermaid
sequenceDiagram
  autonumber
  actor V as 潜在供应商
  participant F as 公开注册表单
  participant S as SRM
  actor CM as 品类经理
  actor Q as SQE
  actor D as 采购总监
  V->>F: 填写公司信息、资质、品类（匿名）
  F->>S: 新建准入申请（已提交）
  S->>S: 受理 flow：按身份标识查重、黑名单检查
  alt 命中黑名单
    S-->>V: 自动驳回通知
  else 通过
    S->>S: 建「潜在」供应商与联系人，状态→资料审核
    S-->>CM: 待办：资料审核
    CM->>S: 邀请联系人开通门户账号
    V->>S: 登录门户补充资料与证书
    CM->>S: 资料审核通过
    opt 高风险品类
      Q->>S: 现场审核 / 样品验证并录入结果
    end
    S->>S: 状态→准入评审，发起审批 flow
    CM->>S: 审批（第 1 级）
    D->>S: 审批（第 2 级）
    S->>S: 供应商→合格，品类资格→合格 / 试供，推送 ERP 建供应商
    S-->>V: 准入通过通知
  end
```

**步骤说明**

| 步骤 | 触发 | 自动化 / 人工动作 |
|---|---|---|
| 1 受理 | 公开表单提交（匿名 `POST /forms/:slug/submit`） | flow `srm_application_intake`（record_change，after-create）：按身份标识查供应商（`country == 'cn'` 用 `credit_code`，其他国家 / 地区用 `country` + `registration_no`，BR-01）；命中 `blacklisted` → 申请置 `rejected`、`duplicate_check = blacklisted`，通知申请人；命中其他状态 → `duplicate`，通知品类经理人工判断；未命中 → `pass` |
| 2 建档 | 受理通过 | 同一 flow：新建 `potential` 供应商与主联系人，`supplier` 回填到申请；按申请品类找到品类经理和 SQE，写入 `reviewer` / `sqe`，并把这些品类中最高的风险等级写入 `risk_class`；申请→`doc_review`，供应商 `potential → qualifying`；通知品类经理 |
| 3 开通门户 | 品类经理 / 管理员 | 邀请主联系人加入组织并开通门户（见 [04 §3.3](./04-security-and-portal.md#33-门户账号的开通与回收)） |
| 4 补充资料 | 供应商 | 门户内补齐公司资料（门户可改的字段见 [04 §4.2](./04-security-and-portal.md#42-字段级权限fls)）、银行账户、证书；品类经理可「退回补充」（申请→`returned`，通知联系人）。应付会计经「核验银行账户」、SQE 经「核验证书」两个 screen flow 完成核验 |
| 5 现场审核 | `risk_class == 'high'` | SQE 建供应商审核记录；结果为通过或有条件通过时，flow 把申请的 `audit_passed` 置为 true。条件校验：`risk_class == 'high' && audit_passed == false` 时申请不得进入 `admission_review`（FR-204） |
| 6 准入评审 | 申请→`admission_review` | flow `srm_admission_approval`：第 1 级 `field` 审批人 = `reviewer`；第 2 级 `position` = `srm_procurement_director`；高风险品类第 2 级并行加 `srm_quality_manager`（`unanimous`）。驳回 → 申请回 `doc_review` 并通知 |
| 7 批准后 | 审批通过 | 申请→`approved`，写入 `cycle_days`；供应商 `qualifying → qualified`；按申请品类建 `srm_supplier_category`（审核结论为有条件通过时为 `trial`，否则 `qualified`）；`http` 节点调 ERP 建供应商，回写 `erp_vendor_code`；通知供应商 |
| 8 未通过 | 终止 | 申请→`rejected`；供应商 `qualifying → potential`；回收门户账号 |

## 4. P3 寻源：询价 → 比价 → 定标

```mermaid
flowchart TD
  A[寻源工程师建寻源单<br/>明细 + 邀请合格供应商] --> B{单一来源?}
  B -->|是| B1[单一来源审批] --> C
  B -->|否| C[发布]
  C --> D[为每家受邀供应商预建报价单草稿<br/>并通知]
  D --> E[供应商门户报价<br/>截止前可反复修改]
  E --> F[截标：校验规则拒绝截止后写入<br/>扫描把未提交报价置为过期]
  F --> G[开标：bid_opened = true<br/>可选监标人确认]
  G --> H[比价 / 评分]
  H --> I{需要下一轮?}
  I -->|是| C
  I -->|否| J[勾选中标行与份额<br/>提交定标]
  J --> K[按金额分级审批]
  K -->|驳回| H
  K -->|通过| L[生成价格记录，截断旧价格<br/>推送 ERP，通知中标与未中标]
```

**步骤说明**

| 步骤 | 触发 | 自动化 / 人工动作 |
|---|---|---|
| 1 建单 | 寻源工程师 | 建寻源单与明细（草稿）。邀请供应商只能通过「邀请供应商」screen flow：选择器带 `lookupFilters`（`status == 'qualified'`、`qualification_alert == false`），flow 再查一次供应商状态与该品类资格，不满足则拒绝并说明原因（BR-03、BR-04）；邀请对象上另有一跳读取供应商状态的校验规则兜底；内部角色对邀请对象没有直接创建权限 |
| 2 发布 | 「发布」screen flow | 寻源单的 `status` 对用户只读，只经 screen flow 推进。普通询价直接→`published`；单一来源→`approval_pending`，由 `srm_single_source_approval` 审批（品类经理 → 采购总监，必须填写单一来源理由），通过后→`published`，驳回回到 `draft` |
| 3 发布后 | 状态→`published` | flow `srm_event_publish`：把 `quote_deadline` 复制为 `locked_deadline`；为本轮应报价的供应商（第 1 轮为全部受邀者，之后只取 `shortlisted == true` 的）各建一张 `draft` 报价单，冗余截止时间与门户岗位，再按明细建报价明细并快照物料信息（单价留空）；通知这些供应商 |
| 4 报价 | 供应商门户 | 供应商只填自己报价单上的单价、交期、税率、附件，提交后 `status → submitted`、记录 `submitted_at`；截止前可撤回重改 |
| 5 截标 | 截止时间到 | **强制**（R1）：报价单的校验规则 `now() > record.quote_deadline && record.bid_opened == false && record.status != 'expired'` 为真时拒绝写入；报价明细经一跳读报价单做同样判断。截止到开标之间报价被冻结；开标后门户写策略也不再放行（[04 §3.4](./04-security-and-portal.md#34-rls-示例)）。**扫描**：`srm_bid_close_sweep`（每 10 分钟，追赶式）把已过截止时间的 `published` 寻源单置为 `bid_closed`，其未提交的报价单置为 `expired` |
| 6 开标 | 「开标」screen flow `srm_bid_open`（寻源单所有者、采购总监可用） | 寻源单的校验规则保证状态进入 `bid_closed` 及以后时已过 `locked_deadline`，截止前开标会被拒绝；若截标扫描还没跑到这张单（计时器漏跑），flow 先补做截标；可选「监标」：`approval` 节点，`position = srm_procurement_compliance`，`first_response`。随后以系统身份把本轮报价单的 `bid_opened` 置为 `true`，统一重算一次报价金额，寻源单→`evaluating`，按明细计算名次 |
| 7 评标 | 评标小组 | 最低价法：比价视图直接按单价排序。综合评分法：技术评分人经「技术评分」screen flow 填 `technical_score`，flow 按价格计算 `commercial_score`（最低价得满分，其余按「最低价 ÷ 本家价格 × 100」），再按权重算 `total_score` |
| 8 多轮议价 | 「下一轮」screen flow | 先在邀请上勾选入围供应商（`shortlisted`）；flow 把本轮报价单置为 `superseded`（只读保留，不再计入 `submitted_quote_count`），`round + 1`，同时写入本轮新的 `quote_deadline` 与 `locked_deadline`，寻源单→`published`，回到步骤 3 |
| 9 提交定标 | 「提交定标」screen flow | 在 flow 里勾选中标明细并填写份额，flow 以系统身份写入报价明细的 `is_awarded` / `award_quantity` / `award_ratio`（内部角色对报价明细没有编辑权），汇总 `awarded_amount`、`savings_amount`；`submitted_quote_count < 3` 时要求填写 `low_competition_reason`（BR-07）；寻源单→`award_review` |
| 10 定标审批 | 状态→`award_review` | 见 §12 审批矩阵：按 `awarded_amount` 分档；有效报价少于 3 家时额外升一级 |
| 11 定标后 | 审批通过 | flow `srm_award_apply`：`loop` 中标明细 → 查同供应商 × 物料 × 工厂的有效价格，把它的 `valid_to` 截断到新价生效日前一天并置为 `superseded`（BR-10）→ 新建 `active` 价格记录 → `http` 推送 ERP 价格信息记录 → 通知中标与未中标供应商；二期起可选：生成合同草稿 |

**封标的完整机制**（BR-05 / BR-06 / FR-304）

| 环节 | 机制 |
|---|---|
| 内部看不到报价 | 报价单与报价明细的内部 RLS 读策略只放行 `bid_opened == true`；封标期间内部查询、列表、导出、仪表盘、AI 助手都拿不到这些行 |
| 内部仍知道「报了几家」 | 寻源单上的汇总字段 `submitted_quote_count` 由平台在报价单写入时重算，内部可见数量但看不到内容 |
| 供应商看不到别家 | 门户 RLS 只放行本公司的报价单（见 04） |
| 截止后不能改 | 写入时校验规则比较冗余的截止时间（R1），不依赖扫描任务准时运行；`quote_deadline`、`bid_opened` 对门户只读（FLS + 字段 `readonly`） |
| 开标后不能改 | 门户写策略要求 `bid_opened == false`；中标与金额字段对门户只读；上一轮报价为 `superseded`，写策略不放行 |
| 截止时间不能被悄悄提前 | 发布时锁定 `locked_deadline`，只能经「延期截止」screen flow 推后；非草稿状态下 `quote_deadline` 必须等于它 |
| 谁能开标 | 「开标」screen flow 只对寻源单的所有者和采购总监开放；寻源单状态对用户只读，校验规则拒绝截止前进入开标 |
| 不可抵赖 | 报价单开启字段历史，`submitted_at` 与每次修改都有记录 |
| 关闭封标 | `sealed == false` 仅允许 `single_source` 寻源单，由校验规则约束 |

## 5. P2 信息变更与供应商处置

**信息变更**（二期，FR-207）：供应商在门户经「提交变更申请」screen flow 提交变更单 →
`before_value` 自动快照当前档案 → 审批 flow `srm_change_approval`：第 1 级
`position = srm_buyer_lead`（采购确认）；`change_type == 'bank_account'` 时增加第 2 级
`position = srm_ap_accountant`（财务复核），
两级审批人由不同岗位担任（BR-11）→ 通过后 flow 把 `after_value` 写回供应商或银行
账户，新银行账户为 `active`，旧账户为 `inactive`；ERP 推送成功前，银行账户变更在
ERP 侧不生效。驳回时通知供应商并写明原因。

**供应商处置**（二期，FR-208）：品类经理发起处置单 → 审批：冻结 / 解冻为品类经理 →
采购总监；淘汰与黑名单再加 `position = srm_general_manager`；解除黑名单单独走同一条
最高级别审批 → 通过后 flow 更新供应商 `status`（或指定品类资格为 `suspended`），
通知供应商，推送 ERP 冻结 / 解冻标志。冻结**不影响**在途订单，只阻止新的寻源邀请
和新订单（ERP 侧的冻结标志拦截新订单）。

## 6. P4 合同审批、签署与到期

| 步骤 | 触发 | 动作 |
|---|---|---|
| 1 起草 | 品类经理手工新建，或定标后由 flow 生成草稿 | 带出供应商、金额、来源寻源单 |
| 2 审批 | 状态→`in_review` | 法务（`field = legal_reviewer`）→ 按金额分档的采购审批（同 §12）；审批中合同只读（平台审批锁记录） |
| 3 签署 | 状态→`signing` | 方式一：上传双方盖章扫描件；方式二：`http` 节点调电子签服务发起签署，回调 `api` flow 写回签署文件和 `esign_request_id` |
| 4 生效 | 签署完成 | 状态→`active`；质量协议 / 廉洁协议生效时把供应商对应的布尔字段置为 true |
| 5 到期提醒 | `time_relative`：`end_date`，提前 60 / 30 / 7 天 | 通知合同所有者和品类经理 |
| 6 到期 | 追赶式扫描：`end_date < today` 且仍为 `active` | 状态→`expired`；`auto_renew == true` 的合同生成续签草稿 |

## 7. P5 订单协同与 P6 送货收货

```mermaid
sequenceDiagram
  autonumber
  participant ERP
  participant S as SRM
  actor V as 供应商
  actor B as 采购员
  ERP->>S: PO upsert（按 erp_po_id）
  S-->>V: 待确认通知
  V->>S: 逐行答复交期 / 数量
  alt 答复交期晚于需求日期
    S-->>B: 交期风险通知
    B->>V: 协商（站外或评论）
  end
  S->>S: 全部行已答复 → 已确认
  S->>ERP: 回写确认交期
  V->>S: 按未交数量建送货单（ASN）
  S->>ERP: ASN 推送 WMS（可选）
  ERP->>S: 收货记录 upsert（按 erp_receipt_id）
  S->>S: 判定准时、累计已收、更新订单状态
```

| 步骤 | 触发 | 动作 |
|---|---|---|
| 1 下发 | ERP 调 REST API upsert 订单与订单行 | 新单 `status = released`、`released_at = now`；flow 通知供应商的 `sales` 联系人 |
| 2 确认 | 供应商在门户答复 | 订单行写入 `promised_date` / `promised_quantity`（门户对订单头有编辑权以满足子记录写入要求，但订单头字段全部 FLS 只读）；flow：`promised_date > required_date` → `delivery_risk = true`、通知采购员（BR-13），并要求 `delay_reason` 非空（校验规则）；全部行答复后订单头→`confirmed`，存在风险行→`partially_confirmed` |
| 3 催办 | 追赶式扫描 `srm_po_ack_sweep`（每小时 + 外部心跳） | `released` 超过 24 小时：提醒供应商；超过 48 小时：通知采购员主管（BR-12）；每级只发一次（以标记字段去重） |
| 4 变更 | ERP 再次 upsert 且 `change_version` 增大 | 订单→`change_pending`，变更前后差异写入订单的评论 / 历史，通知供应商重新确认 |
| 5 回写 | 订单确认后 | `http` 节点把确认交期推回 ERP（ERP 支持时） |
| 6 送货 | 供应商通过「创建送货单」screen flow | flow 列出本公司「未交数量 − 在途数量 > 0」的订单行，校验送货数量 ≤ `open_quantity − in_transit_quantity`（BR-14，扣除已发未收的其他送货单）后以系统身份建送货单与明细（明细 `line_status = shipped`），生成二维码标签；门户对送货明细没有直接创建权限 |
| 7 收货 | ERP / WMS upsert 收货记录 | flow `srm_receipt_apply`：按订单行的 `promised_date`（无答复时取 `required_date`）判定 `on_time`；按订单行单价写 `amount`；重算订单行 `open_quantity` 与 `line_status`；对应送货明细→`received`；更新送货单与订单头状态（未确认的订单也允许直接进入交货中 / 已收齐，见 02 §5.4） |

## 8. P7 来料检验与质量整改（SCAR / 8D）

```mermaid
stateDiagram-v2
  [*] --> open: 检验不合格（严重/主要）自动生成
  open --> containment_submitted: 供应商提交 D3 临时措施
  containment_submitted --> open: SQE 退回
  containment_submitted --> action_submitted: 供应商提交 D4–D7
  action_submitted --> containment_submitted: SQE 退回
  action_submitted --> verifying: SQE 审核通过
  verifying --> action_submitted: 验证不通过
  verifying --> closed: 效果确认（D8）
  closed --> open: 问题复发
  open --> cancelled: 误判撤销
```

| 步骤 | 触发 | 动作 |
|---|---|---|
| 1 生成 | 检验记录 upsert，`result == 'fail'` 且 `severity in ['critical','major']` | flow `srm_scar_create`：新建整改单，`sqe` 取物料品类的 SQE，`containment_due = 检验时间 + 72 小时`、`final_due = 检验日期 + 30 天`（可按严重度配置）；通知供应商 `quality` 联系人与 SQE（BR-15）。`minor` 不合格只计入绩效，不自动开单 |
| 2 临时措施 | 供应商提交 D3 | 状态→`containment_submitted`；通知 SQE |
| 3 根因与措施 | 供应商提交 D4–D7 | 状态→`action_submitted`；flow 发起 `approval` 节点：`field` 审批人 = `sqe`，驳回走「退回修改」回到供应商，退回意见写入 `sqe_comment`（FR-604） |
| 4 效果验证 | SQE 审核通过 | 状态→`verifying`；SQE 跟踪后续批次，确认有效后关闭 |
| 5 逾期升级 | 追赶式扫描 `srm_scar_overdue_sweep`（每小时 + 外部心跳） | 超过 `containment_due` 仍为 `open`、或超过 `final_due` 仍未到 `verifying`：`is_overdue = true`，提醒供应商并通知 SQE 主管（FR-605） |
| 6 索赔 | SQE 填写 `claim_amount`，`claim_status → proposed` | 供应商在门户接受或提出异议；接受后（`supplier_accepted`）由月度对账生成扣款行 |

## 9. P8 对账与结算

| 步骤 | 触发 | 动作 |
|---|---|---|
| 1 生成 | `schedule`：每月 1 日 02:00（追赶式：处理所有 `reconciled == false`、`settlement_mode == 'standard'` 且收货日期早于本月的记录；其他结算方式的收货由对应扩展包自己生成对账明细） | 按「供应商 × 法人」分组，建对账单与明细：收货行、退货行、`claim_status == 'supplier_accepted'` 的索赔扣款行；把纳入的收货记录置为 `reconciled = true`、纳入的索赔置为 `settled`（防止下月重复扣款）；按明细税率算 `tax_amount`；状态 `draft`（FR-801） |
| 2 内部复核 | 采购员 / 应付会计 | 检查后发送：状态→`sent`，通知供应商 `finance` 联系人 |
| 3 供应商确认 | 门户 | 确认→`supplier_confirmed`（锁定，BR-16）；或标记差异行并填写原因→`disputed`，通知采购员 |
| 4 差异处理 | 采购员 | 调整明细（补录 / 剔除 / 改价须有原因）后重新发送 |
| 5 财务确认 | 应付会计 | →`finance_confirmed`，通知供应商开票 |
| 6 开票 | 供应商通过「提交发票」screen flow | flow 先确认对账单为 `finance_confirmed`（FR-803）；再把「已登记发票不含税金额 `invoiced_amount` + 本张」与 `net_amount` 比较，税额同样与 `tax_amount` 比较，超过容差拒绝并提示差额（BR-17）；发票代码 + 号码唯一，重复登记被拒绝；通过后建发票记录；可选：`http` 调用发票查验服务写 `verify_status` |
| 7 入账 | 发票校验通过 | `http` 推送 ERP 生成应付发票，回写 `erp_ap_doc_no`；对账单→`invoiced` |
| 8 付款回写 | ERP 付款后调 `api` flow | 写发票 `paid_amount` / `paid_date` / `payment_status`；全部付清时对账单→`paid`，供应商门户可见 |

> 数据量提示：月度生成在 flow 里用 `loop` 实现，适合每月数千条收货行的规模。规模
> 更大时有两条路：按法人或品类拆成多个错峰的 `schedule` flow；或在自托管部署中把
> 「分组建单」实现为服务端函数，由 flow 调用（托管云上应用包函数不执行）。

## 10. P9 季度绩效评估

| 步骤 | 触发 | 动作 |
|---|---|---|
| 1 生成 | `schedule`：每季度首日 03:00 | 为上季度有交易或在供的合格供应商各建一张考评单（`calculating`），按指标库建评分明细（FR-702） |
| 2 自动算分 | 同一次运行 | 按 [05 §4](./05-experience-and-analytics.md#4-仪表盘与指标口径) 的口径计算 OTD、批次合格率、PPM、订单响应及时率、价格指数，写入原始值与得分。计数类口径依赖收货、检验上的标志字段（`on_time`、`result`），由 flow 的查询节点按供应商和期间汇总 |
| 3 人工评分 | 状态→`scoring` | 按评分明细的 `scorer`（品类经理、SQE、需求部门评分人）通知，评分人经「提交评分」screen flow 只看到并填写分配给自己的评分项；截止 10 天，扫描任务提醒未评项；截止后未评项按「取 60 分并标记未评」处理（可配置） |
| 4 汇总分级 | 全部评分完成或截止 | `total_score = Σ(score × weight)`；等级默认 A ≥ 90、B 80–89、C 70–79、D < 70；状态→`reviewing` |
| 5 审定发布 | 审批：采购总监（`position = srm_procurement_director`） | 通过后→`published`；回写供应商 `grade`、`latest_score`；供应商可在门户查看结果与扣分项（FR-704） |
| 6 结果应用 | 发布后的记录触发 | C 级：生成改善要求（整改单，`source = audit`）；连续两期 D 级：生成淘汰处置单草稿交品类经理评审（BR-18）；A 级：在名录中标记优选，供寻源邀请参考 |
| 7 申诉 | 供应商发布后 7 天内 | 状态→`appealed`，采购总监处理后回到 `published`，结果留痕（FR-706） |

## 11. P10 资质与风险监控

| 场景 | 触发 | 动作 |
|---|---|---|
| 到期提醒 | `time_relative`：证书 `valid_to`，提前 30 / 15 / 7 天 | 证书 `status → expiring`；通知 SQE 与供应商联系人（FR-901） |
| 到期生效 | 追赶式扫描：`valid_to < today` 且不是 `expired` | 证书→`expired`；`is_mandatory` 的证书过期时供应商 `qualification_alert = true`（FR-902）；四期起同时新建 `qualification` 类风险事件 |
| 供应商修改证书 | 证书的编号、有效期或附件被门户修改 | flow 把 `verified` 重置为 false，通知 SQE 重新核验 |
| 资质恢复 | 证书写入后的记录触发 | 重新计算：每一种必备资质类型都有 `status == 'valid'` 且 `verified == true` 的证书时，`qualification_alert = false`（四期起关闭对应风险事件）。只上传新证书而未经 SQE 核验，不会解除异常 |
| 外部风险 | `schedule`：每周一 04:00（四期） | flow 按批 `loop` 合格供应商，`http` 节点调用企业信息服务；新出现的经营异常、失信、重大诉讼、股权变更按 `external_ref` 去重后建风险事件，`high` 级通知品类经理（FR-903） |

> v0.1 先实现其中的一部分：`srm_certificate_expire_sweep` 每日一次，把证书状态对齐到已过期 / 即将到期（30 天内）/
> 有效（有效期被延长时恢复）；`srm_supplier_qualification_recalc` 在证书状态或「必备」标志变化后重算
> `qualification_alert`。到期提醒通知、`is_mandatory` 按品类必备资质自动写入、「经 SQE 核验才解除」随门户版本
> （v0.2）加入；v0.1 由内部人员维护证书与「必备」标志。

## 12. 审批矩阵

审批人一律按**岗位**或**记录上的人员字段**解析，不写死具体的人；换人只改岗位任命，
不改流程。金额阈值放在应用包的常量配置里，实施时按企业授权手册调整。

| 单据 | 条件 | 第 1 级 | 第 2 级 | 第 3 级 | 方式 |
|---|---|---|---|---|---|
| 准入申请 | 全部 | 品类经理（`field: reviewer`） | 采购总监 | — | 串行 |
| 准入申请 | 高风险品类 | 品类经理 | 采购总监 + 质量经理 | — | 第 2 级并行 `unanimous` |
| 单一来源寻源 | 全部 | 品类经理 | 采购总监 | — | 串行 |
| 定标 | `awarded_amount < 10 万` | 品类经理 | — | — | — |
| 定标 | `10 万 ≤ 金额 < 100 万` | 品类经理 | 采购总监 | — | 串行 |
| 定标 | `金额 ≥ 100 万` | 品类经理 | 采购总监 | 总经理 | 串行 |
| 定标 | 有效报价 < 3 家 | 在上表基础上增加一级 | | | |
| 合同 | 全部 | 法务（`field: legal_reviewer`） | 按定标同档金额审批 | | 串行 |
| 银行账户变更 | 全部 | 采购主管 | 应付会计 | — | 串行，两级不同岗位 |
| 其他信息变更 | 全部 | 采购主管 | — | — | — |
| 冻结 / 解冻 | 全部 | 品类经理 | 采购总监 | — | 串行 |
| 淘汰 / 黑名单 / 解除黑名单 | 全部 | 品类经理 | 采购总监 | 总经理 | 串行 |
| 绩效发布 | 全部 | 采购总监 | — | — | — |
| SCAR 措施审核 | 全部 | SQE（`field: sqe`） | — | — | 可退回修改 |

职责分离：同一张单据的发起人不应出现在审批人中。平台审批服务目前**没有**内置
「提交人不得审批本人单据」的开关，本设计用两层保证：岗位设置上，发起岗与审批岗不
由同一人兼任；在 flow 中，审批人等于发起人时改用上一级岗位（`expression` 审批人）。
详见 [04 §6](./04-security-and-portal.md#6-职责分离sod)。

## 13. 自动化清单

| flow | 触发 | 对象 | 期次 |
|---|---|---|---|
| `srm_application_intake` | record_change：新建 | 准入申请 | 一期 |
| `srm_admission_approval` | record_change：状态→`admission_review` | 准入申请 | 一期 |
| `srm_certificate_expiry_notice` | time_relative：`valid_to` −30 / −15 / −7 天 | 资质证书 | 一期 |
| `srm_certificate_expire_sweep` | schedule：每日 01:00（追赶式） | 资质证书 | 一期 |
| `srm_supplier_qualification_recalc` | record_change：证书写入 | 资质证书 → 供应商 | 一期 |
| `srm_single_source_approval` | record_change：状态→`approval_pending` | 寻源单 | 一期 |
| `srm_event_publish` | record_change：状态→`published` | 寻源单 | 一期 |
| `srm_bid_close_sweep` | schedule：每 10 分钟 + api 心跳 | 寻源单、报价单 | 一期 |
| `srm_bid_open` | screen：「开标」 | 寻源单、报价单 | 一期 |
| `srm_bid_scoring` | record_change：技术评分写入 | 报价单 | 一期 |
| `srm_award_approval` | record_change：状态→`award_review` | 寻源单 | 一期 |
| `srm_award_apply` | record_change：状态→`awarded` | 寻源单 → 价格记录 | 一期 |
| `srm_change_approval` / `srm_change_apply` | record_change | 变更单 | 二期 |
| `srm_disposition_approval` / `srm_disposition_apply` | record_change | 处置单 | 二期 |
| `srm_contract_approval` | record_change：状态→`in_review` | 合同 | 二期 |
| `srm_contract_expiry_notice` / `srm_contract_expire_sweep` | time_relative / schedule | 合同 | 二期 |
| `srm_esign_callback` | api | 合同 | 二期 |
| `srm_po_release_notice` | record_change：新建 | 订单 | 二期 |
| `srm_po_line_ack` | record_change：答复交期写入 | 订单行 → 订单 | 二期 |
| `srm_po_ack_sweep` | schedule：每小时 + api 心跳 | 订单 | 二期 |
| `srm_receipt_apply` | record_change：新建 / 更新 | 收货记录 → 订单行、送货单 | 二期 |
| `srm_scar_create` | record_change：检验写入 | 检验 → 整改单 | 三期 |
| `srm_scar_review` | record_change：状态→`action_submitted` | 整改单 | 三期 |
| `srm_scar_overdue_sweep` | schedule：每小时 + api 心跳 | 整改单 | 三期 |
| `srm_performance_generate` | schedule：每季度首日 | 考评单 | 三期 |
| `srm_performance_publish` | record_change：状态→`reviewing` | 考评单 → 供应商 | 三期 |
| `srm_statement_generate` | schedule：每月 1 日 | 对账单 | 四期 |
| `srm_invoice_post` | record_change：发票校验通过 | 发票 → ERP | 四期 |
| `srm_payment_callback` | api | 发票、对账单 | 四期 |
| `srm_external_risk_scan` | schedule：每周一 | 风险事件 | 四期 |
| `srm_erp_push_retry` | schedule：每 15 分钟（追赶式） | 所有带同步字段的对象 | 一期 |

用户操作入口的 screen flow（均以系统身份运行，flow 内做校验后再写入）：

| screen flow | 入口 | 使用者 | 期次 |
|---|---|---|---|
| `srm_invite_supplier` 邀请供应商 | 寻源单 | 寻源工程师 | 一期 |
| `srm_event_submit` 发布 | 寻源单 | 寻源工程师 | 一期 |
| `srm_deadline_extend` 延期截止 | 寻源单 | 寻源工程师 | 一期 |
| `srm_bid_open` 开标 | 寻源单 | 所有者、采购总监 | 一期 |
| `srm_technical_score` 技术评分 | 报价单 | 评标小组 | 一期 |
| `srm_next_round` 下一轮 | 寻源单 | 寻源工程师 | 一期 |
| `srm_award_submit` 提交定标 | 寻源单 | 寻源工程师 | 一期 |
| `srm_event_cancel` 取消 / 流标 | 寻源单 | 寻源工程师 | 一期 |
| `srm_certificate_verify` 核验证书 | 资质证书 | SQE | 一期 |
| `srm_bank_verify` 核验银行账户 | 银行账户 | 应付会计 | 一期 |
| `srm_portal_enable` 开通门户 | 供应商联系人 | `srm_supplier_admin` | 一期 |
| `srm_change_submit` 提交变更申请 | 门户：公司资料 | 门户管理员 | 二期 |
| `srm_asn_create` 创建送货单 | 门户：订单 | 门户用户 | 二期 |
| `srm_score_submit` 提交评分 | 考评单 | 评分人 | 三期 |
| `srm_appeal_submit` 申诉 | 门户：绩效 | 门户管理员 | 三期 |
| `srm_invoice_submit` 提交发票 | 门户：对账单 | 门户用户 | 四期 |

所有写其他用户不可见数据的 flow（例如开标时更新封标中的报价单、受理时创建供应商）
声明以系统身份运行；只改当前用户自己可见数据的 flow 以用户身份运行。
