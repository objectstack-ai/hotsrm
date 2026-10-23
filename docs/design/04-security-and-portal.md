# 04 · 权限设计与供应商门户

> 所属：[SRM 设计总览](./README.md)　·　上一篇：[03 流程与自动化](./03-processes-and-automation.md)　·　下一篇：[05 界面与分析](./05-experience-and-analytics.md)

> 版本：内部岗位与权限集随 v0.1–v0.5 逐步建立；供应商门户在 v0.6，前提是门槛 1 通过、
> objectstack#25233（门户用户可列出全组织用户）修复，并完成 [07 §6](./07-delivery-plan.md#6-平台依赖与验证结果) 的 V1–V5 实测；
> 封标在 v0.7。订单、送货、对账、发票相关的权限为 ERP 集成后的预留（[ADR-0008](../adr/0008-order-to-pay-stays-in-erp.md)）。

## 1. 安全目标与主要威胁

SRM 同时服务内部员工和互相竞争的供应商，权限设计的首要目标是**供应商之间零可见**，
其次是**寻源过程的公正**（封标、职责分离）和**资金安全**（银行账户）。

| # | 威胁 | 后果 | 控制措施 | 章节 |
|---|---|---|---|---|
| S1 | 供应商 A 读到供应商 B 的报价、订单、绩效 | 商业泄密，寻源失效，法律风险 | 门户岗位 + RLS，fail-closed | §3 |
| S2 | 内部人员在截止前看到报价并泄露给关系户 | 围标串标，廉洁风险 | 封标 RLS（`bid_opened == true`），开标留痕 | §4 |
| S3 | AI 助手被用来绕过封标或越权查询 | 同 S1、S2 | AI 以提问者身份调用，受同一套 RLS / FLS 约束 | §4、[06 §3](./06-integration-and-ai.md#3-ai-助手) |
| S4 | 伪造银行账户变更，把货款转到骗子账户 | 直接资金损失 | 变更双人审批、新账户待核验、ERP 推送前不生效 | [03 §5](./03-processes-and-automation.md#5-p2-信息变更与供应商处置) |
| S5 | 寻源发起人自己审批自己的定标 | 职责分离失效 | 岗位分离 + 审批人等于发起人时改走上一级 | §6 |
| S6 | 公开注册表单被灌水或注入伪造字段 | 垃圾数据，越权写入 | v0.6 默认邀请注册，不开公开表单；开放时：平台剥离服务端字段 + 初始状态约束 + 前置限流 + 人工确认后才建主数据 | §8 |
| S7 | 离职员工或终止合作的供应商账号仍可登录 | 数据外泄 | 账号回收流程，岗位任命随供应商状态撤销 | §3.3 |
| S8 | 门户用户通过用户目录看到其他供应商的账号或员工名单 | 暴露竞争对手、泄露员工联系方式 | 已实测存在（objectstack#25233，P1）；平台修复前不开门户 | §3.6 |

## 2. 角色、岗位与权限集

平台把**能做什么**（权限集）和**看多大范围**（OWD、共享规则、RLS、层级范围）分开。
本设计的权限集挂在岗位上，员工通过岗位任命获得权限；唯一的例外是门户管理员权限集，
它直接授予具体的供应商用户（§3.3）。

### 2.1 内部岗位

| 岗位（position） | 中文 | 挂载的权限集 |
|---|---|---|
| `srm_procurement_director` | 采购总监 | `srm_internal_base`、`srm_sourcing`、`srm_buyer`、`srm_executive` |
| `srm_category_manager` | 品类经理 | `srm_internal_base`、`srm_sourcing`、`srm_supplier_admin` |
| `srm_sourcing_engineer` | 寻源工程师 | `srm_internal_base`、`srm_sourcing` |
| `srm_buyer` | 采购员 | `srm_internal_base`、`srm_buyer` |
| `srm_buyer_lead` | 采购主管 | `srm_internal_base`、`srm_buyer`、`srm_supplier_admin` |
| `srm_sqe` | SQE | `srm_internal_base`、`srm_quality` |
| `srm_quality_manager` | 质量经理 | `srm_internal_base`、`srm_quality` |
| `srm_iqc_inspector` | IQC 检验员 | `srm_internal_base`、`srm_iqc` |
| `srm_ap_accountant` | 应付会计 | `srm_internal_base`、`srm_finance` |
| `srm_legal_counsel` | 法务 | `srm_internal_base`、`srm_legal` |
| `srm_evaluator` | 评分人（需求部门、技术评委） | `srm_internal_base`；技术评分、绩效评分只经 screen flow |
| `srm_general_manager` | 总经理 | `srm_internal_base`、`srm_executive` |
| `srm_procurement_compliance` | 内控 / 监标 | `srm_auditor` |
| `srm_admin` | SRM 系统管理员 | `srm_admin` |

### 2.2 权限集

| 权限集 | 说明 |
|---|---|
| `srm_internal_base` | 内部员工的基础：读品类、物料、工厂、供应商主数据（不含银行账号）、价格库；**不是** `isDefault` |
| `srm_sourcing` | 寻源单、寻源明细的增改（状态只经 screen flow 推进）；邀请、技术评分、定标只经 screen flow；读报价（受封标 RLS 约束）；新建合同 |
| `srm_supplier_admin` | 供应商档案、联系人、证书、准入申请、审核、供货品类资格、处置单、合同的增改；开通门户 |
| `srm_buyer` | 供应商档案、合同、交付记录读；物料只改 `category` 关联（其余字段 FLS 只读，不新建、不删除）；代供应商发起变更单（v0.6 前）；ERP 集成后加订单、送货单的内部字段 |
| `srm_quality` | 审核、交付记录（录入）、整改单的增改；证书只读，核验经 screen flow |
| `srm_iqc` | 交付记录的录入（没有质量系统的客户） |
| `srm_finance` | 银行账号可读，核验经 screen flow；银行账户变更的第 2 级审批；整改单索赔结论标记 |
| `srm_legal` | 合同读改（审批由 flow 授予） |
| `srm_executive` | 全部 SRM 对象只读 + 仪表盘；审批由 flow 授予，不需要额外写权限 |
| `srm_auditor` | 全部 SRM 对象只读（报价同样受封标约束），可读审批历史与字段历史，不可导出银行账号 |
| `srm_admin` | 品类、指标库、编码、通知模板的配置；物料导入与维护；不授予报价读权限 |
| `srm_portal_supplier` | 供应商门户用户：见 §3.2 |
| `srm_portal_supplier_admin` | 在 `srm_portal_supplier` 之上：维护本公司联系人、银行账户，提交变更申请与绩效申诉；直接授予具体用户 |
| `srm_integration` | 预留（ERP 集成后）：集成服务账号，物料、交付记录、订单镜像的写入；供应商仅可写 `erp_vendor_code`，价格记录只读；**不**授予报价单与银行账号 |

**为什么 SRM 不用 `isDefault` 权限集**：`isDefault` 的权限集绑定到组织的每一个成员。
在托管云上，供应商的门户用户也是组织成员，一个 `isDefault` 的内部权限集会直接把
内部对象开放给所有供应商。因此 SRM 的每个权限集都只通过岗位任命或对具体用户的直接授予来分配。上线前还要
检查同一环境里**其他应用**的默认权限集，确认它们不会把别的业务数据开放给供应商
用户（见 [07 §4](./07-delivery-plan.md#4-风险与应对)）。

### 2.3 对象权限矩阵（节选）

R 读 · C 建 · E 改 · D 删 · F 仅经 flow / screen flow 写入 · — 无权限。删除一律只给
`srm_admin`，业务上用状态（取消、作废）代替删除。

| 对象 | base | sourcing | supplier_admin | buyer | quality | finance | portal |
|---|---|---|---|---|---|---|---|
| 供应商 | R | R | RCE | R | R | R | RE（本公司；只能改资料字段，见 §4.2） |
| 联系人 | R | R | RCE | R | R | R | R；门户管理员 CE |
| 银行账户 | — | — | R | — | — | R + F（核验） | R（本公司）；门户管理员 C |
| 资质证书 | R | R | RCE | R | R + F（核验） | R | RCE（本公司；状态与核验字段只读） |
| 准入申请 | — | — | RCE | — | RE | — | R（本公司） |
| 变更单 | — | — | R | R | — | R | R（本公司）+ F（提交） |
| 寻源单 / 明细 | R | RCE（状态只经 F） | R | R | R | — | — |
| 寻源邀请 | R | RF | R | — | — | — | RE（本公司：接受 / 拒绝） |
| 报价单 / 明细 | — | R（开标后）+ F（评分、定标） | — | — | — | — | RE（本公司，截止前且未开标） |
| 价格记录 | R | RF | R | R | — | R | R（本公司） |
| 合同 / 合同明细 | — | RC | RCE | RE（上传签署件） | — | R | R（本公司，签署中及以后） |
| 交付记录 | R | — | — | R | RCE（录入） | R | R（本公司） |
| 供应商审核 | R | — | R | — | RCE | — | — |
| 整改单 | R | — | — | R | RCE | R（索赔结论） | RE（本公司：回复） |
| 考评单 / 评分明细 | R | — | — | R | R | — | R（本公司，已发布）+ F（申诉） |
| 风险事件 | R | R | RCE | R | RCE | R | — |
| 门户邀请 | — | — | RCE | RC | — | — | — |
| 采购订单 / 行、送货单 / 明细 | 预留（ERP 集成后的门户镜像）：内部 R，采购员改内部字段，门户只改答复字段 / 经 F 建送货单 | | | | | | |
| 对账单、发票 | 不做（ERP） | | | | | | |

表中未列的权限集：`srm_executive`、`srm_auditor` 对全部对象只读（报价同样受封标约束）；
`srm_legal` 对合同读改；`srm_iqc` 对检验增改；绩效评分只经「提交评分」screen flow。

**`controlled_by_parent` 的写入规则**：子记录（联系人、证书、银行账户、合同明细、报价
明细）的修改要求对父记录有编辑权。所以门户对供应商、报价单都授予编辑权，再用字段级
权限把父记录上门户不该改的字段设为只读——表中「RE」带括号说明的就是这种情况。

## 3. 供应商门户的数据隔离

### 3.1 机制：每家供应商一个门户岗位

```mermaid
flowchart LR
  U1[门户用户 李四<br/>A 公司商务] -- 任命 --> P1[岗位<br/>srm_vendor_sup0000128]
  U2[门户用户 王五<br/>A 公司财务] -- 任命 --> P1
  P1 -- 挂载 --> PS[权限集<br/>srm_portal_supplier]
  S1[供应商 A<br/>portal_position = srm_vendor_sup0000128]
  D1[A 的报价 / 订单 / 对账单<br/>portal_position = srm_vendor_sup0000128]
  D2[B 的报价 / 订单 / 对账单<br/>portal_position = srm_vendor_sup0000311]
  PS -. RLS: portal_position in current_user.positions .-> S1
  PS -. 放行 .-> D1
  PS -. 不放行 .-> D2
```

1. 每家开通门户的供应商有一个专属岗位，命名 `srm_vendor_<供应商编号小写>`，挂载
   门户权限集。该供应商的所有门户用户都任命到这个岗位。
2. 供应商档案和它的每张顶层单据都带 `portal_position` 字段，在单据创建时由 flow 从
   供应商档案复制，门户只读。`master_detail` 子记录跟随父记录。
3. 门户权限集上的 RLS 只放行 `portal_position in current_user.positions` 的行。平台在
   每个请求里解析当前用户持有的岗位；RLS 编译为数据库过滤条件。字段为空、用户
   没有岗位，都匹配不到任何行（fail-closed）。
4. **防止冒用内置岗位**：每个带 `portal_position` 的对象都有一条校验规则，值必须以
   `srm_vendor_` 开头。否则一个被误写成 `everyone`（平台给所有登录用户的内置岗位）
   的单据会对全体用户可见。字段为空是允许的：没开通门户的供应商，其单据本来就不该被
   任何门户用户看到。

**为什么选这个方案**

| 方案 | 托管云今天可用 | 代价 | 结论 |
|---|---|---|---|
| A 每家供应商一个门户岗位 | 可用：只用到岗位、RLS、flow | 每家供应商首次开通时管理员要新建一个岗位定义；每张顶层单据冗余一个字段 | **推荐** |
| B 应用自带 membership resolver 插件，RLS 写成 `supplier in current_user.portal_supplier_ids` | 不可用：托管云不执行应用包代码；自托管可用 | 需要代码；该扩展点在开源框架中已定义，使用前需验证 | 自托管时的可选增强（§3.5） |
| C 记录所有者设为供应商用户 | 可用 | 一家供应商多个用户时只有所有者能看；破坏「所有者 = 内部经办人」的语义 | 不采用 |
| D 每家供应商一个组织（多组织隔离） | 需要企业版多组织许可 | 一张寻源单要同时给多家供应商看，跨组织做不到 | 不采用 |

### 3.2 各对象的门户策略

| 对象 | 门户读 | 门户写 | 说明 |
|---|---|---|---|
| 供应商 | 本公司 | 只能改资料字段（§4.2）；名称、地址、银行账户等关键信息走变更单 | RLS 在供应商自身的 `portal_position` 上；授予编辑权是为了让门户能维护证书等子记录 |
| 联系人、证书、银行账户、品类资格 | 跟随供应商 | 证书可增改；联系人和银行账户仅门户管理员可增 | `controlled_by_parent` |
| 准入申请 | 本公司 | 「退回补充」状态时可改 | |
| 变更单 | 本公司 | 只经「提交变更申请」screen flow（门户管理员） | v0.6 |
| 寻源邀请 | 本公司 | 可改 `status`（接受 / 拒绝）与拒绝原因 | 邀请上有寻源单的快照，门户不读寻源单本身 |
| 报价单 | 本公司 | `status in ['draft','submitted'] && bid_opened == false` 的本公司报价 | 写策略 `using` 限定可改哪些行，`check` 限定改完仍属本公司；上一轮的 `superseded` 报价不可改 |
| 报价明细 | 跟随报价单 | 跟随报价单；只能改单价、交期、税率、起订量、备注 | 截止后由校验规则锁定（BR-06）；金额、中标字段、快照字段只读 |
| 价格记录 | 本公司 | — | |
| 合同 | 本公司且 `status in ['signing','active','expired','terminated']` | — | 草稿与审批中的合同不可见 |
| 交付记录 | 本公司 | — | 供应商看到的是用于算分的交付结果 |
| 整改单 | 本公司 | 供应商回复字段 | `sqe_comment`、`claim_amount` 只读 |
| 考评单 / 评分明细 | 本公司且 `status == 'published'` | 只经「申诉」screen flow | 未发布的考评不可见 |
| 采购订单 / 订单行、送货单 / 明细 | 预留（ERP 集成后） | 订单行的答复字段；送货单只经 screen flow | 订单头授予编辑权但字段全部 FLS 只读 |
| 寻源单、寻源明细、审核、风险事件、门户邀请 | 不可见 | — | 门户权限集不授予这些对象 |

### 3.3 门户账号的开通与回收

托管云上，组织邀请是进入环境的唯一入口，供应商的门户用户就是被邀请进组织的成员。

**开通**（由 `srm_supplier_admin` 操作）：

1. 在组织成员页按联系人邮箱发出邀请，角色为普通成员；
2. **该供应商第一次开通门户时**，由管理员在 Setup 新建岗位 `srm_vendor_<编号>`，并在
   岗位定义里挂上门户权限集。平台把岗位视为环境级的**定义**（元数据），不是数据行，
   所以这一步不能由 flow 完成，需要持有元数据编辑权限的管理员操作（已向平台提出
   「按外部方在运行时建岗位并任命」，objectstack#25443；存量供应商批量开通时管理员
   按清单批量建）；
3. 运行「开通门户」screen flow：选择联系人、已加入的用户和刚建的岗位 → 写入供应商的
   `portal_position`，并把它回填到该供应商已有的单据上 → 把用户任命到该岗位（任命是
   数据行，flow 以系统身份写入是否放行按 07 §6 V3 实测，objectstack#25251；不放行时
   由管理员在成员页任命，flow 只做回填）→ 在联系人上写 `portal_user`；联系人
   `contact_function` 含 `admin` 时，再把门户管理员权限集**直接授予该用户**（同一家供应商
   的用户共用一个岗位，管理员能力只能按人授予）；
4. 同一供应商以后再开通账号，只需第 1、3 步。

岗位定义随开通门户的供应商数量增长（几百到上千个），设置界面的岗位列表会变长。
这是方案 A 的主要运维代价。如果平台以后支持在元数据里声明成员集合（例如「当前用户
作为联系人所属的供应商」），就可以改用方案 B 的写法，不再需要为每家供应商建岗位。

**回收**：

| 场景 | 动作 |
|---|---|
| 联系人离职 / 停用 | 撤销岗位任命，移出组织；联系人 `active = false` |
| 供应商冻结 | 账号与门户功能保持不变：整改单仍要回复，资料仍要维护；冻结只阻止新的询价邀请（BR-03），新订单由 ERP 侧冻结标志拦截 |
| 供应商淘汰 / 黑名单 | 处置 flow 撤销该岗位的全部任命，账号移出组织 |
| 季度复核 | 报表列出每家供应商的门户账号与在职联系人，差异由采购主管确认 |

### 3.4 RLS 示例

```ts
import { definePermissionSet } from '@objectstack/spec/security';

const OWN = 'portal_position in current_user.positions';

export const PortalSupplier = definePermissionSet({
  name: 'srm_portal_supplier',
  label: '供应商门户用户',
  objects: {
    // 父记录授予编辑权，是 controlled_by_parent 子记录（证书、订单行、报价明细）写入的前提；
    // 父记录上门户不该改的字段在下面的 fields 里逐个设为只读
    srm_supplier:      { allowRead: true, allowCreate: false, allowEdit: true,  allowDelete: false },
    srm_supplier_certificate: { allowRead: true, allowCreate: true, allowEdit: true, allowDelete: false },
    srm_quotation:     { allowRead: true, allowCreate: false, allowEdit: true,  allowDelete: false },
    srm_quotation_line:{ allowRead: true, allowCreate: false, allowEdit: true,  allowDelete: false },
    srm_purchase_order:{ allowRead: true, allowCreate: false, allowEdit: true,  allowDelete: false },
    srm_po_line:       { allowRead: true, allowCreate: false, allowEdit: true,  allowDelete: false },
    // …其余对象按 §3.2
  },
  fields: {
    'srm_supplier.name':                    { readable: true,  editable: false },
    'srm_supplier.country':                 { readable: true,  editable: false },
    'srm_supplier.credit_code':             { readable: true,  editable: false },
    'srm_supplier.registration_no':         { readable: true,  editable: false },
    'srm_supplier.status':                  { readable: true,  editable: false },
    'srm_supplier.portal_position':         { readable: true,  editable: false },
    'srm_supplier_certificate.status':      { readable: true,  editable: false },
    'srm_supplier_certificate.verified':    { readable: true,  editable: false },
    'srm_supplier_certificate.is_mandatory':{ readable: true,  editable: false },
    'srm_quotation.bid_opened':             { readable: true,  editable: false },
    'srm_quotation.quote_deadline':         { readable: true,  editable: false },
    'srm_quotation.technical_score':        { readable: false, editable: false },
    'srm_quotation.rank':                   { readable: false, editable: false },
    'srm_quotation_line.amount':            { readable: true,  editable: false },
    'srm_quotation_line.is_awarded':        { readable: true,  editable: false },
    'srm_quotation_line.award_quantity':    { readable: true,  editable: false },
    'srm_purchase_order.status':            { readable: true,  editable: false },
    'srm_po_line.quantity':                 { readable: true,  editable: false },
    'srm_po_line.unit_price':               { readable: true,  editable: false },
    'srm_po_line.required_date':            { readable: true,  editable: false },
    // …父记录与子记录上其余门户不该改的字段同样列出
  },
  rowLevelSecurity: [
    { name: 'portal_supplier_read',  object: 'srm_supplier',       operation: 'select', using: OWN },
    { name: 'portal_quote_read',     object: 'srm_quotation',      operation: 'select', using: OWN },
    {
      name: 'portal_quote_write',
      object: 'srm_quotation',
      operation: 'update',
      // 能改哪些已有行：本公司、本轮、未开标。报价明细跟随报价单，同样受这条约束
      using: `${OWN} && status in ['draft', 'submitted'] && bid_opened == false`,
      check: OWN,                                            // 改完的行仍须属于本公司
    },
    { name: 'portal_supplier_write', object: 'srm_supplier',       operation: 'update', using: OWN, check: OWN },
    { name: 'portal_po_read',        object: 'srm_purchase_order', operation: 'select', using: OWN },
    { name: 'portal_po_write',       object: 'srm_purchase_order', operation: 'update', using: OWN, check: OWN },
    { name: 'portal_review_read',    object: 'srm_performance_review', operation: 'select',
      using: `${OWN} && status == 'published'` },
    // …
  ],
});
```

### 3.5 自托管增强：membership resolver

自托管部署可以运行应用代码，此时可以把方案 A 换成方案 B：应用注册一个
`rls-membership-resolver` 服务，声明键 `portal_supplier_ids`，按「当前用户作为
`portal_user` 的在职联系人所属供应商」解析出供应商 id 集合；RLS 改写为
`supplier in current_user.portal_supplier_ids`，单据不再需要 `portal_position` 冗余。

注意两点：每个运行环境只取**一个**该服务，同一环境若有其他应用也要注册，需要合并成
一个组合解析器；解析器抛错或漏键时相关策略匹配零行（fail-closed），所以它的故障表现
为「门户看不到数据」而不是越权。

### 3.6 用户目录的可见范围

门户用户和内部员工是同一个组织的成员，除了业务数据，还要看**用户目录**的可见范围：

- 供应商 A 的用户不应看到供应商 B 有哪些门户账号，否则可以推断竞争对手；
- 供应商用户不应看到内部员工的完整名单和联系方式，只应看到与其业务往来的人员
  （如订单上的采购员）。

门户权限集只能放宽或收窄 SRM 自己的对象，用户目录由平台的成员权限决定。因此：

1. 已实测：门户用户在界面和 REST 上能列出全组织用户（objectstack#25233，P1，已补充 SRM
   场景）；纳入 §3.7 的验收用例，v0.6 开工前复测；
2. 平台修复前不开门户；若必须在解决前上线，由业务方书面接受该风险，并把门户用户的
   显示名统一为「公司简称-角色」，减少个人信息暴露。

### 3.7 隔离验收测试

一期上线前必须全部通过，之后每次权限相关变更都回归：

| 用例 | 方法 | 期望 |
|---|---|---|
| 交叉读 | 准备供应商 A、B 各一个门户用户；对 §3.2 每个对象，用 A 的身份按 B 的记录 id 读取 | 全部返回「不存在」，列表与搜索中不出现 |
| 交叉写 | 用 A 的身份修改 B 的记录、或把自己记录的 `portal_position` 改成 B 的 | 全部拒绝 |
| 冒用内置岗位 | 以系统身份把一条记录的 `portal_position` 写成 `everyone` | 校验规则拒绝 |
| 开标后改价 | 开标后用中标供应商的身份修改本公司报价明细的单价或中标字段 | 拒绝 |
| 自解资质异常 | 用门户身份把本公司过期证书的 `status` 改为有效，或修改有效期 | 改状态被拒绝；改有效期后 `verified` 被重置，资质异常不解除 |
| 空岗位 | 新建一张尚未回填 `portal_position` 的单据 | 任何门户用户都看不到 |
| 回收 | 撤销 A 用户的岗位任命后立即访问 | 看不到任何供应商数据 |
| 用户目录 | 用 A 的身份在界面和 REST API 上查询用户列表 | 看不到 B 的门户账号，也看不到内部员工的完整名单（§3.6） |
| 多通道 | 以上用例分别经门户界面、REST API、导出、AI 助手执行 | 结果一致 |

## 4. 封标与字段级权限

### 4.1 封标

内部角色读报价单的唯一通道是下面这条 RLS，它挂在 `srm_sourcing`、`srm_executive`、
`srm_auditor` 三个权限集上：

```ts
{ name: 'internal_quote_read_after_opening', object: 'srm_quotation', operation: 'select',
  using: 'bid_opened == true' }
```

报价明细是报价单的 `master_detail` 子对象，跟随父记录，自动同样受限。要点：

- **管理员也不例外**：`srm_admin` 不授予报价读权限；平台超级管理员的数据库级访问在
  运维制度里约束（访问留痕、双人授权），不在应用权限里放开；
- **AI 助手不例外**：AI 以提问者的身份查询，同一条 RLS 生效（[06 §3](./06-integration-and-ai.md#3-ai-助手)）；
- **数量可见、内容不可见**：寻源单上的 `submitted_quote_count` 由平台在报价写入时重算，
  内部能看到「已报价 N 家」；
- **开标由 flow 以系统身份执行**：它需要更新内部尚不可见的报价，这是唯一被允许的
  系统身份写入，flow 本身留有运行记录；
- **价格记录不受封标约束**：`srm_supplier_admin`、`srm_buyer` 对价格记录可读，但价格记录
  在定标后才由 flow 产生，与中标报价一一对应，不泄露封标期间的任何报价；
- **平台管理员的数据库级访问**是已知例外，写进运维制度（GL-10）而不是应用权限。

### 4.2 字段级权限（FLS）

| 字段 | 谁可读 | 谁可改 | 原因 |
|---|---|---|---|
| `srm_supplier_bank_account.account_no` | 应付会计、`srm_supplier_admin`、本公司门户管理员 | 门户管理员（新建时）、经变更单 flow | 资金安全（BR-20） |
| `srm_supplier_contact.mobile` | 内部员工、本公司门户用户 | 本公司门户管理员 | 个人信息最小化 |
| `srm_sourcing_event.budget_amount` | 寻源、采购总监、内控 | 寻源 | 门户不可见（门户本就不读寻源单） |
| `srm_sourcing_item.target_price` / `last_price` | 同上 | 寻源 | 同上 |
| `srm_quotation.technical_score` / `commercial_score` / `total_score` / `rank` | 内部评标相关角色（开标后） | 寻源、评标 flow | 门户不可见，防止供应商据此调价 |
| `srm_quotation.bid_opened` / `quote_deadline` | 所有可读报价的人 | 仅 flow | 封标开关与锁价依据 |
| `srm_delivery_record` 全部字段 | 内部、本公司门户 | 仅导入与质检员录入 | 交付结果以 ERP / 质量系统为准 |
| `srm_sourcing_event.budget_amount`、`srm_sourcing_item.target_price` / `last_price` | 寻源、采购总监、内控 | 寻源 | 寻源单 OWD 为 `public_read`，预算类字段靠 FLS 保护，不另做按品类的共享规则 |
| `srm_po_line.unit_price` / `quantity` / `required_date`（预留） | 内部、本公司门户 | 仅 ERP 集成 | 订单以 ERP 为准 |
| `srm_quality_issue.claim_amount` | 内部、本公司门户 | SQE | |
| `srm_performance_review.*_score` | 内部、本公司门户（已发布） | 算分 flow、评分人 | |
| `*.portal_position` | 所有可读该记录的人 | 仅 flow | 隔离锚点，门户不可改 |
| `srm_supplier` 的 `name`、`country`、`credit_code`、`registration_no`、`address`、`legal_representative`、`registered_capital`、`status`、`grade`、`qualification_alert`、`erp_vendor_code` | 内部、本公司门户 | 内部（关键信息变更走变更单） | 门户只读；门户可直接改的只有 `short_name`、`website`、`supplier_type`、`taxpayer_type`、`established_date` 等资料字段 |
| `srm_supplier_certificate.status` / `is_mandatory` / `verified` | 内部、本公司门户 | 仅 flow 与「核验证书」screen flow | 防止供应商自行解除资质异常 |
| `srm_quotation_line` 的 `amount`、`is_awarded`、`award_quantity`、`award_ratio` 及快照字段 | 所有可读报价的人 | 仅 flow | 防止供应商改金额或自报中标 |
| `srm_purchase_order` 全部字段（预留） | 内部、本公司门户 | 内部与集成 | 门户对订单头有编辑权只为写订单行，字段全部只读 |

## 5. 多法人与多工厂

**推荐：单组织 + 业务单元树**，不开法人之间的「墙」。

```
集团（组织）
├── 苏州工厂（业务单元）── 采购部、质量部
├── 成都工厂（业务单元）── 采购部、质量部
└── 集团采购中心（业务单元）
```

理由：

1. **供应商主数据在集团内共享**：同一家供应商给多个工厂供货，档案、资质、绩效应只有
   一份。开墙后每个法人各有一份供应商档案，正是 SRM 要消除的痛点 T1；
2. **门户用户只需加入一个组织**：在多组织隔离下，同一家供应商的用户要加入它供货的
   每个法人组织，账号管理成本成倍增加；
3. **法人维度用字段表达**：合同、交付记录上有 `legal_entity` / `plant` 字段，报表按法人
   出数，不需要墙；订单、对账在 ERP（ADR-0008）。

内部「只看本工厂」的可见性有两种做法：

| 做法 | 版本 | 适用 |
|---|---|---|
| 共享规则：按 `plant` 字段把单据共享给对应工厂的业务单元（criteria 规则，接收方为 `business_unit`） | 开源 | 工厂数量少且稳定 |
| 层级范围：内部权限集对合同、交付记录声明 `readScope: 'unit_and_below'` | 企业版（`hierarchySecurity`） | 组织层级多、需要「集团看全部、工厂看本厂」的逐级可见 |

**什么时候改为开墙**：先问三个问题——这个法人需要自己的管理员班子独立管理用户和
权限吗？有监管或合资方要求的数据隔离吗？未来可能被整体出售或分立吗？三问都是「否」
就不开墙；有一个「是」就开墙，并单独评估供应商主数据在墙内外的共享方式。

## 6. 职责分离（SoD）

| 冲突的职责 | 控制 |
|---|---|
| 发起寻源 ↔ 审批定标 | 寻源工程师岗位不挂审批岗位；定标审批 flow 的第 1 级审批人用 `expression` 计算：品类经理若就是寻源单所有者，则改为采购总监 |
| 维护银行账户 ↔ 核验银行账户 | 门户管理员或采购录入，应付会计核验；变更单两级审批人分属采购与财务两个岗位 |
| 准入资料审核 ↔ 准入批准 | 第 1 级审批人是 `reviewer`（品类经理），第 2 级为采购总监岗位 |
| 录入交付记录 ↔ 评价绩效 | 交付记录来自 ERP 导出或质检员录入，采购员和品类经理不能改；绩效由 flow 算分、采购总监审定 |
| 修改价格 ↔ 下单 | 价格记录只经定标 flow 产生，任何角色无直接编辑权限；订单价格以 ERP 为准 |
| 系统配置 ↔ 业务数据 | `srm_admin` 不授予报价读权限、不参与任何审批 |

上表的「岗位分离 + `expression` 改派」在应用层保证发起人不审批本人单据，不依赖平台
提供专门的开关（见 [07 §6](./07-delivery-plan.md#6-平台依赖与验证结果)）。

## 7. 审计、合规与数据保护

| 要求 | 做法 |
|---|---|
| 主数据变更可追溯 | 供应商、银行账户、证书、品类资格、价格记录开启 `enable.trackHistory`，关键字段逐个声明 `trackHistory` |
| 审批不可篡改 | 平台审批历史（开源档能力）；审批中的记录被锁定 |
| 寻源过程可复盘 | 报价单开启字段历史；开标、截标 flow 的运行记录保留 |
| AI 操作可审计 | 企业版 AI 治理：每次工具调用记录提问者、问题与触达的数据 |
| 个人信息保护 | 注册表单展示个人信息处理告知并要求勾选同意；只收集业务必需的联系人信息；联系人停用后按保留期限清理 |
| 导出控制 | 报价、银行账户所在对象的导出权限只给内控与应付会计；导出动作留痕 |
| 客户层定制不越权 | 客户在 Studio 覆盖层新增的字段、视图不得放宽门户 RLS 与封标 RLS；核心升级前跑「核心 + 客户层」组合构建复核（[ADR-0009](../adr/0009-core-first-pack-criteria-and-customer-layer.md)） |

## 8. 公开注册表单的防护

v0.6 的默认注册方式是**邀请注册**（01 FR-202）：供应商以受邀成员身份进门户后填申请，不
依赖匿名门。公开注册表单（FR-201）在多组织托管云上会落入部署默认组织（objectstack
ADR-0138 D4），且公开表单不能带附件（objectstack#25445），待 07 §6 V1 实测与
objectstack#25447 后再启用。启用时它是整个系统唯一对互联网开放的写入口，按下表防护；
另外提交后不直接建供应商主数据，由品类经理推进到「资料审核」时才建档（03 §3 第 2 步）。

| 风险 | 控制 |
|---|---|
| 伪造系统字段（所有者、组织、时间戳） | 平台在公开表单写入时按名剥离服务端管理的字段，提交者无法指定 |
| 伪造业务状态（直接提交成「已通过」） | `state_machine` 的 `initialStates: ['submitted']`；`supplier`、`duplicate_check`、`reviewer` 等字段不出现在表单上且为只读 |
| 恶意附件 | `file` 字段限制类型（PDF / 图片）和大小 |
| 灌水、刷量 | 上线前在前置网关按 IP 限流；部署环境的公开表单如支持验证码，一并启用 |
| 读取他人申请 | 表单只写不读；申请人通过邮件收到受理编号，后续在门户中查看 |
