# 04 · 权限设计与供应商门户

> 所属：[SRM 设计总览](./README.md)　·　上一篇：[03 流程与自动化](./03-processes-and-automation.md)　·　下一篇：[05 界面与分析](./05-experience-and-analytics.md)

> 版本：内部岗位与权限集随 v0.1–v0.5 逐步建立；供应商门户在 v0.6，前提是门槛 1 通过、
> objectstack#25233（门户用户可列出全组织用户）修复（18.1.0），并完成 [07 §6](./07-delivery-plan.md#6-平台依赖与验证结果) 的 V1–V5 实测（2026-11-02 完成，结论见 07 §6.2）；
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
本设计的权限集挂在岗位上，员工通过岗位任命获得权限；供应商的门户用户同样经静态门户岗位获得权限，
门户管理员按人任命到 `srm_portal_admin`（§3.1 第 6 条、§3.3）。

### 2.1 内部岗位

| 岗位（position） | 中文 | 挂载的权限集 |
|---|---|---|
| `srm_procurement_director` | 采购总监 | `srm_internal_base`、`srm_sourcing`、`srm_buyer`、`srm_executive`、`srm_performance` |
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
| `srm_supplier_admin` | 供应商档案、联系人、证书、准入申请、审核、供货品类资格、处置单、合同的增改；门户邀请（提出开通需求，开通本身由组织管理员操作，§3.3） |
| `srm_buyer` | 供应商档案、合同、交付记录读；物料只改 `category` 关联（其余字段 FLS 只读，不新建、不删除）；代供应商发起变更单（v0.6 前；银行账户变更要填完整账号，由持完整账号能力的品类经理或采购主管发起）；ERP 集成后加订单、送货单的内部字段 |
| `srm_quality` | 审核、交付记录（录入）、整改单的增改；证书只读，核验经 screen flow |
| `srm_iqc` | 交付记录的录入（没有质量系统的客户） |
| `srm_finance` | 银行账号可读，核验经 screen flow；银行账户变更的第 2 级审批；整改单索赔结论标记 |
| `srm_legal` | 合同读改（审批由 flow 授予） |
| `srm_executive` | 全部 SRM 对象只读 + 仪表盘；审批由 flow 授予，不需要额外写权限 |
| `srm_performance` | 绩效指标库的增改（采购总监，FR-701）；改别人建的指标由共享规则 `srm_kpi_director_edit` 放行，不能删除。不并入 `srm_executive`，否则总经理也能改指标 |
| `srm_auditor` | 全部 SRM 对象只读（报价同样受封标约束），可读审批历史与字段历史，不可导出银行账号 |
| `srm_admin` | 品类、指标库、编码、通知模板的配置；物料导入与维护；存量供应商、联系人、证书的导入（v0.2，唯一能写「存量导入」标记的权限集，[导入说明](../implementation/legacy-supplier-import.md)）；不授予报价读权限 |
| `srm_portal_supplier` | 供应商门户用户：见 §3.2 |
| `srm_portal_admin` | 在 `srm_portal_supplier` 之上：维护本公司联系人、银行账户，看完整银行账号，提交变更申请与绩效申诉；挂在门户管理员岗位 `srm_portal_admin` 上，按人任命 |
| `srm_integration` | 预留（ERP 集成后）：集成服务账号，物料、交付记录、订单镜像的写入；供应商仅可写 `erp_vendor_code`，价格记录只读；**不**授予报价单与银行账号 |

**为什么 SRM 不用 `isDefault` 权限集**：`isDefault` 的权限集绑定到组织的每一个成员。
在托管云上，供应商的门户用户也是组织成员，一个 `isDefault` 的内部权限集会直接把
内部对象开放给所有供应商。因此 SRM 的每个权限集都只通过岗位任命或对具体用户的直接授予来分配。上线前还要
检查同一环境里**其他应用**的默认权限集，确认它们不会把别的业务数据开放给供应商
用户（见 [07 §4](./07-delivery-plan.md#4-风险与应对)）。

### 2.3 对象权限矩阵（节选）

R 读 · C 建 · E 改 · D 删 · F 仅经 flow / screen flow 写入 · — 无权限。删除一律只给
`srm_admin`，业务上用状态（取消、作废）代替删除。供应商主数据在集团内共享（§5），
`supplier_admin` 和 `srm_admin` 对供应商的编辑不限于自己建的记录。平台的 `modifyAllRecords` 会连删除一起放开
（objectstack#25470），所以「改别人建的记录、不能删」一律用共享规则表达：OWD 保持目标值，权限集给 `allowEdit`、
不给 `modifyAllRecords`，再按岗位加授 `edit` 的 `criteria` 共享规则（`src/core/security/sharing-rules.ts`，见下方各对象）。
没有任何对象用 OWD `public_read_write`。`srm_quality` 为写证书保留对供应商的编辑权、供应商字段经 FLS 全部只读。

| 对象 | base | sourcing | supplier_admin | buyer | quality | finance | portal |
|---|---|---|---|---|---|---|---|
| 供应商 | R | R | RCE | R | R | R | RE（本公司；只能改资料字段，见 §4.2） |
| 联系人 | R | R | RCE | R | R | R | R；门户管理员 CE |
| 银行账户 | — | — | R | — | — | R + F（核验） | R（本公司）；门户管理员 C |
| 资质证书 | R | R | RCE | R | R + F（核验） | R | RCE（本公司；状态与核验字段只读） |
| 准入申请 | — | — | RCE（现场审核结论只读，经 F 写回） | — | R | — | R（本公司） |
| 变更单 | — | — | RCE（本人发起的） | RCE（本人发起的；不含银行账户变更） | — | R | R（本公司）+ F（提交） |
| 寻源单 / 明细 | R | RCE（状态只经 F） | R | R | R | — | — |
| 寻源邀请 | R | RF | R | — | — | — | RE（本公司：接受 / 拒绝） |
| 报价单 / 明细 | — | R（开标后）+ F（评分、定标） | — | — | — | — | RE（本公司，截止前且未开标） |
| 价格记录 | R | RF | R | R | — | R | R（本公司） |
| 合同 / 合同明细 | — | RC | RCE | RE（只能改签署件、签署日期；明细 R） | — | R | R（本公司，签署中及以后） |
| 交付记录 | R | — | — | R | RCE（录入） | R | R（本公司） |
| 供应商审核（含问题项） | R | — | R | — | RCE（计划年度、问题项的整改单只读）+ F（转整改单） | — | — |
| 整改单 | R | — | — | R | RCE（逾期标志只读） | RE（只改索赔状态：标记已扣款） | RE（本公司：回复） |
| 绩效指标 | R | R | R | R | R | R | — |
| 考评单 / 评分明细 | R | — | — | R | R | — | R（本公司，已发布）+ F（申诉） |
| 风险事件 | R | R | RCE | R | RCE | R | — |
| 门户邀请 | — | — | RCE | RC | — | — | — |
| 采购订单 / 行、送货单 / 明细 | 预留（ERP 集成后的门户镜像）：内部 R，采购员改内部字段，门户只改答复字段 / 经 F 建送货单 | | | | | | |
| 对账单、发票 | 不做（ERP） | | | | | | |

表中未列的权限集：`srm_executive`、`srm_auditor` 对全部对象只读（报价同样受封标约束）；
`srm_performance` 对绩效指标增改、`srm_admin` 对绩效指标增改删；`srm_legal` 对合同与明细读改（不新建）；`srm_iqc` 对检验增改；绩效评分只经「提交评分」screen flow。
风险事件 OWD `public_read`，持 `srm_supplier_admin`、`srm_quality` 的岗位经共享规则改别人登记的和系统生成的事件（可改不可删）；
来源、相关证书、处置单三个字段只经 F 写入（v0.5）。

改别人建的记录靠的共享规则（可改不可删，每个岗位一条，规则名 `<对象>_edit_<岗位>`）：

| 对象 | OWD | 经共享规则可改的岗位 |
|---|---|---|
| 供应商 | `public_read` | 品类经理、采购主管、SQE、质量经理（只为写证书）、SRM 系统管理员 |
| 物料 | `public_read` | 采购员、采购主管、采购总监（只改品类）；SRM 系统管理员用 `modifyAllRecords`（本来就能删） |
| 合同 | `private`（内部读靠 `viewAllRecords`） | 品类经理、采购主管、法务、采购员与采购总监（只改签署件、签署日期） |
| 整改单 | `public_read` | SQE、质量经理、应付会计（只改索赔状态） |
| 供应商审核 | `private`（内部读靠 `viewAllRecords`） | SQE、质量经理 |
| 风险事件 | `public_read` | 品类经理、采购主管、SQE、质量经理 |
| 绩效指标 | `public_read` | 采购总监（`srm_kpi_director_edit`） |

门户上线（v0.6）后，门户 RLS 叠加在这些 OWD 与共享规则之上。上表的编辑共享规则只授内部岗位；门户另有三条只授
`srm_portal_user` 的**读**共享规则（准入申请、变更单、合同，§3.1 第 4 条），行范围由门户 RLS 限定到本公司（ADR-0010）。

**`controlled_by_parent` 的写入规则**：子记录（联系人、证书、银行账户、合同明细、报价
明细）的修改要求对父记录有编辑权。所以门户对供应商、报价单都授予编辑权，再用字段级
权限把父记录上门户不该改的字段设为只读——表中「RE」带括号说明的就是这种情况。

## 3. 供应商门户的数据隔离

### 3.1 机制：联系人名册上的成员键

```mermaid
flowchart LR
  U1[门户用户 李四<br/>A 公司商务] -- portal_user --> C1[联系人<br/>供应商 A，在职]
  U2[门户用户 王五<br/>A 公司财务] -- portal_user --> C2[联系人<br/>供应商 A，在职]
  C1 & C2 -. 成员键 portal_supplier_ids .-> K[current_user.portal_supplier_ids = A]
  U1 & U2 -- 任命 --> P[静态岗位 srm_portal_user<br/>挂 srm_portal_supplier]
  K -. RLS: supplier in current_user.portal_supplier_ids .-> D1[A 的合同 / 整改单 / 考评单]
  K -. 不放行 .-> D2[B 的合同 / 整改单 / 考评单]
```

1. **名册**：门户账号登记在供应商联系人的 `portal_user` 上（02 §4.1）。联系人上声明成员键
   `portal_supplier_ids`（`ObjectSchema.membershipKeys`：`userField: 'portal_user'`、`valueField: 'supplier'`、
   `filter: 'active == true'`）。平台每个请求以系统身份读一次名册，得到「当前用户作为在职联系人所属的供应商」，
   作为 `current_user.portal_supplier_ids` 交给 RLS。
2. **门户 RLS 只认这个键**：供应商自身 `id in current_user.portal_supplier_ids`，带 `supplier` 引用的顶层单据
   `supplier in current_user.portal_supplier_ids`，必要时叠加状态条件（§3.2）。`master_detail` 子记录跟随父记录。
   单据上不冗余任何门户字段。
3. **fail-closed**：键取不到、为空、超过 1,000 个值、名册读失败、同名键被声明两次，平台一律丢弃读这个键的
   策略并拒绝；用户没有门户岗位时整个对象无权访问。故障只会表现为「门户看不到数据」。
4. **private 对象两把锁**：`external` 成员对 OWD 一律按「仅本人」处理（§3.3），权限集上的 RLS 只在
   `public_read` 对象上解除这个下限。准入申请、变更单、合同是 `private`，各有一条只授 `srm_portal_user` 的读
   共享规则（合同只共享 §3.2 的可见状态），共享放进来的行再由 RLS 限定到本公司。共享规则本身是全量授权，
   所以隔离测试同时检查元数据：门户能读的每个对象都必须有读成员键的 RLS（或是子对象）。
5. **授权就是写名册**：`portal_user` 字段级只读，任何岗位都不能在界面或 REST 上写，只由 flow 写入（开通门户
   写入；淘汰、拉黑时清空）；在职标志 `active` 对门户只读，门户管理员不能恢复被停用的账号。
6. **岗位是静态的**：全体门户用户任命到 `srm_portal_user`，本公司门户管理员再任命到 `srm_portal_admin`；不再为
   每家供应商建岗位。

**为什么选这个方案**

| 方案 | 托管云今天可用 | 代价 | 结论 |
|---|---|---|---|
| A 每家供应商一个门户岗位，单据冗余 `portal_position` | 可用 | 每家供应商首次开通要管理员新建岗位定义；每个对象多一个冗余字段、一条前缀校验、一个回填 flow | 被取代（ADR-0003 → ADR-0010） |
| B 成员键，RLS 写成 `supplier in current_user.portal_supplier_ids` | 可用：18.1.0 起元数据声明（`ObjectSchema.membershipKeys`，objectstack#25234），平台代码解析，不需要应用代码 | 名册写入即授权，`portal_user` 必须只由 flow 写 | **采用**（2026-11-02 实测通过） |
| C 记录所有者设为供应商用户 | 可用 | 一家供应商多个用户时只有所有者能看；破坏「所有者 = 内部经办人」的语义 | 不采用 |
| D 每家供应商一个组织（多组织隔离） | 需要企业版多组织许可 | 一张寻源单要同时给多家供应商看，跨组织做不到 | 不采用 |

### 3.2 各对象的门户策略

| 对象 | 门户读 | 门户写 | 说明 |
|---|---|---|---|
| 供应商 | 本公司 | 只能改资料字段（§4.2）；名称、地址、银行账户等关键信息走变更单 | RLS 在供应商自身的 `id` 上；授予编辑权是为了让门户能维护证书等子记录；内部评估类字段（关联方、优选、风险事件数等）门户不可见 |
| 联系人、证书、银行账户、品类资格 | 跟随供应商 | 证书可增（v0.6 U2；修改随 U4 的「核验证书」一起放开）；联系人和银行账户仅门户管理员可增，门户管理员可改联系人手机 | `controlled_by_parent`；联系人的 `portal_user`、`active` 门户只读 |
| 准入申请 | 本公司 | 「退回补充」状态时可改（U4） | `private`：读共享规则 + RLS |
| 变更单 | 本公司 | 只经「提交变更申请」screen flow（门户管理员，U4） | `private`：读共享规则 + RLS |
| 寻源邀请 | 本公司 | 可改 `status`（接受 / 拒绝）与拒绝原因 | 邀请上有寻源单的快照，门户不读寻源单本身 |
| 报价单 | 本公司 | `status in ['draft','submitted'] && bid_opened == false` 的本公司报价 | 写策略 `using` 限定可改哪些行，`check` 限定改完仍属本公司；上一轮的 `superseded` 报价不可改 |
| 报价明细 | 跟随报价单 | 跟随报价单；只能改单价、交期、税率、起订量、备注 | 截止后由校验规则锁定（BR-06）；金额、中标字段、快照字段只读 |
| 价格记录 | 本公司 | — | |
| 合同 / 合同明细 | 本公司且 `status in ['signing','active','expired','terminated']` | — | 草稿与审批中的合同不可见；`private`：读共享规则只共享这几种状态，RLS 再限定本公司 |
| 交付记录 | 本公司 | — | 供应商看到的是用于算分的交付结果 |
| 整改单 | 本公司 | 供应商回复字段 | `sqe_comment`、`claim_amount` 只读 |
| 考评单 / 评分明细 | 本公司且 `status in ['published','appealed']` | 只经「申诉」screen flow（U5） | 未发布的考评不可见；申诉只能对已发布的考评提起，申诉期间照常可见 |
| 采购订单 / 订单行、送货单 / 明细 | 预留（ERP 集成后） | 订单行的答复字段；送货单只经 screen flow | 订单头授予编辑权但字段全部 FLS 只读 |
| 寻源单、寻源明细、审核、风险事件、处置单、门户邀请 | 不可见 | — | 门户权限集不授予这些对象；处置结果体现在供应商状态上 |

### 3.3 门户账号的开通与回收

托管云上，组织邀请是进入环境的唯一入口，供应商的门户用户就是被邀请进组织的成员。门户用户一律按组织角色
**`external`**（外部成员，平台 18.1.0 起提供，objectstack#25233）邀请，不按普通成员邀请。`external` 的行为：

- **只读自己的身份行**：看不到成员目录，团队、邀请列表也只返回自己相关的（§3.6）；
- **不受默认权限集作用**：持平台的 `org_external` 而不是 `everyone` 锚点，环境里任何 `isDefault` 权限集都到不了它；
  它只有平台内置的 `external_default` 基线（读自己的身份行；只能改、删自己创建的行）；
- **不放进业务单元**：门户岗位是组织级岗位，数据只经岗位和权限集授予；
- **OWD 对它一律视为仅本人**：`public_read` / `public_read_write` 对它不开放，只读写自己拥有的和共享给它的行
  （记录共享或共享规则，18.1.0 起公开对象上的共享也能到达 `external` 成员）；它持有的岗位或权限集上的行策略
  （RLS）在 `public_read` 对象上解除这个下限并限定行范围——门户权限集的 `supplier in current_user.portal_supplier_ids`
  正是这样起作用的；`private` 对象上 RLS 解除不了下限，要再加共享（§3.1 第 4 条，2026-11-02 实测）；
  `controlled_by_parent` 子对象跟随主记录。

所以门户用户能看到的数据只来自 §3.1 的门户岗位、门户权限集和只授门户岗位的读共享规则，内部权限集即使误设了 `isDefault` 也不会漏给他们
（内部权限集仍一律不设 `isDefault`，R2 照常审查；07 §6 V5 已实测）。`org_external` 是平台保留名，岗位不能用它命名。

**环境前提**：开门户的环境，成员策略（Setup → 认证 → 成员，平台设置 `auth.membership_policy`，或环境变量
`OS_AUTH_MEMBERSHIP_POLICY`）必须是 `invite-only`。单组织部署默认是 `auto`：任何人注册即以普通成员入组织，被邀请的
供应商在接受邀请前同样是普通成员，能读全组织用户目录、拿到所有 `isDefault` 权限集。`invite-only` 下注册不入组织，
接受邀请才以邀请上的角色（`external`）入组织（07 §6 V1 实测）。

**开通**：由组织管理员（组织角色 `owner` / `admin`，通常由 SRM 系统管理员兼任）操作；品类经理、采购主管
（`srm_supplier_admin`）提出开通需求，自己做不了：平台只让组织管理员发邀请、写岗位任命和权限集授予，委托管理
（`adminScope`）又只能在业务单元内任命，`external` 成员不进业务单元（07 §6 V2、V3 实测）。不需要新建任何岗位定义
（ADR-0010）。

1. 在组织成员页按联系人邮箱发出邀请，角色选 `external`（flow 发不了邀请：平台规定邀请只经组织接口，07 §6 V3）；
2. 运行「开通门户」screen flow（`srm_portal_enable`，v0.6 U3 实现；`runAs: 'user'`，以操作的组织管理员身份执行）：
   选择联系人和已加入的用户 → 把用户任命到静态岗位 `srm_portal_user`，联系人 `contact_function` 含 `admin` 时再任命到
   `srm_portal_admin` → 在联系人上写 `portal_user`。任命是数据行，18.1.0 起 `runAs: 'system'` 的 flow 不得写
   （objectstack#25251），`runAs: 'user'` 由组织管理员启动时能写，其他人启动被拒（07 §6 V2）；flow 进门先检查操作人
   是组织管理员，不是就直接结束并说明。写入 `portal_user` 后下一个请求起该用户即能看到本公司数据；flow 还要检查同一
   用户没有登记在别的联系人上（登记在两家时两家的数据都能看到）；
3. 同一供应商以后再开通账号，同样走第 1、2 步。

**回收**（下一个请求即生效，平台每个请求重读名册）：

| 场景 | 动作 |
|---|---|
| 联系人离职 / 停用 | 联系人 `active = false`（名册过滤条件），下一个请求起看不到数据；组织管理员随后撤销门户岗位任命并移出组织 |
| 供应商冻结 | 账号与门户功能保持不变：整改单仍要回复，资料仍要维护；冻结只阻止新的询价邀请（BR-03），新订单由 ERP 侧冻结标志拦截 |
| 供应商淘汰 / 黑名单 | `srm_disposition_apply` 执行时清掉该供应商全部联系人上的 `portal_user`，门户访问即刻失效，不靠人工停用联系人；岗位任命与组织成员身份由组织管理员随后移除（处置 flow 写不了任命，07 §6 V2）。重新准入通过后要重新开通门户 |
| 准入未通过 | 申请驳回、供应商退回 `potential`（重新准入的旧档回 `eliminated`）时清掉该供应商联系人上的 `portal_user`（03 §3 第 8 步，v0.6 U3）；已合格供应商增加品类的申请被驳回不动门户。岗位任命与组织成员身份由组织管理员随后移除 |
| 季度复核 | 报表列出每家供应商的门户账号与在职联系人，差异由采购主管确认 |

### 3.4 RLS 示例

v0.6 的实现在 `src/core/security/portal-permission-sets.ts`；下面的示例含 v0.7 寻源和预留的订单对象，说明写法。

```ts
import { definePermissionSet } from '@objectstack/spec/security';

const OWN = 'supplier in current_user.portal_supplier_ids';

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
    // 供应商自身用 id 比较
    { name: 'portal_supplier_read',  object: 'srm_supplier',       operation: 'select', using: 'id in current_user.portal_supplier_ids' },
    { name: 'portal_quote_read',     object: 'srm_quotation',      operation: 'select', using: OWN },
    {
      name: 'portal_quote_write',
      object: 'srm_quotation',
      operation: 'update',
      // 能改哪些已有行：本公司、本轮、未开标。报价明细跟随报价单，同样受这条约束
      using: `${OWN} && status in ['draft', 'submitted'] && bid_opened == false`,
      check: OWN,                                            // 改完的行仍须属于本公司
    },
    { name: 'portal_supplier_write', object: 'srm_supplier',       operation: 'update',
      using: 'id in current_user.portal_supplier_ids', check: 'id in current_user.portal_supplier_ids' },
    { name: 'portal_po_read',        object: 'srm_purchase_order', operation: 'select', using: OWN },
    { name: 'portal_po_write',       object: 'srm_purchase_order', operation: 'update', using: OWN, check: OWN },
    { name: 'portal_review_read',    object: 'srm_performance_review', operation: 'select',
      using: `${OWN} && status in ['published', 'appealed']` },
    // …
  ],
});
```

### 3.5 成员键的实测与边界

成员键在 v0.6 U2 限时实测后采用（2026-11-02，[ADR-0010](../adr/0010-portal-isolation-by-membership-key.md)），
取代原来的「每家供应商一个门户岗位」（ADR-0003）。要点：

- 解析由平台的安全插件完成，不是应用包代码：托管云关闭应用包代码（ADR-0001 的顾虑）不影响它。托管环境复测列为
  v0.6 出口条件（07 §6.2 V6），覆盖「键为空」和「运行时不认识这个键」两种情形，期望都是拒绝、零行；
- 每个键最多 1,000 个值，一个门户用户只属于一家供应商，远在上限内；
- 名册的过滤条件只能读名册自己的列（不能读 `current_user`，也不能经引用读供应商状态），所以淘汰、拉黑时由
  处置 flow 清掉 `portal_user`，而不是靠过滤条件读供应商状态（§3.3 回收）；
- 同一个键名在同一环境只能有一个来源：若环境里另有应用也声明 `portal_supplier_ids`，两边都解析不出来、全部
  拒绝。键名带 SRM 的语义，冲突的可能很小，发生时改名即可。

### 3.6 用户目录的可见范围

门户用户和内部员工是同一个组织的成员，除了业务数据，还要看**用户目录**的可见范围：

- 供应商 A 的用户不应看到供应商 B 有哪些门户账号，否则可以推断竞争对手；
- 供应商用户不应看到内部员工的完整名单和联系方式，只应看到与其业务往来的人员
  （如订单上的采购员）。

门户权限集只能放宽或收窄 SRM 自己的对象，用户目录由平台的成员权限决定。因此：

1. 18.0.0 实测：普通成员身份的门户用户在界面和 REST 上能列出全组织用户（objectstack#25233）；
2. 18.1.0 以组织角色 `external` 修复：`external` 成员只读自己的身份行，团队、邀请列表也只返回自己相关的。
   门户用户因此一律按 `external` 邀请（§3.3），07 §5 D8 不再需要；2026-11-02 实测通过（07 §6 V1），§3.7 的「用户目录」
   用例照常回归。同一家供应商的其他门户用户也看不到（按 id 读同样是「不存在」），门户里要列本公司账号时读联系人的
   `portal_user`，不读用户目录。

### 3.7 隔离验收测试

一期上线前必须全部通过，之后每次权限相关变更都回归：

| 用例 | 方法 | 期望 |
|---|---|---|
| 交叉读 | 准备供应商 A、B 各一个门户用户；对 §3.2 每个对象，用 A 的身份按 B 的记录 id 读取 | 全部返回「不存在」，列表与搜索中不出现 |
| 交叉写 | 用 A 的身份修改 B 的记录、把自己的单据改挂到 B 名下、在 B 名下新建联系人或证书 | 全部拒绝 |
| 冒用名册 | 用门户身份（含门户管理员）或任何内部岗位写联系人的 `portal_user`、改联系人归属或在职标志 | 拒绝或写入被丢弃，授权不变；只有 flow 能写 |
| 开标后改价 | 开标后用中标供应商的身份修改本公司报价明细的单价或中标字段 | 拒绝（v0.7 寻源上线时加入） |
| 自解资质异常 | 用门户身份把本公司过期证书的 `status` 改为有效，或修改有效期；新建证书时自带「已核验」 | 全部拒绝（v0.6 U2 门户只能新建证书；U4 放开修改时，改有效期重置 `verified`，资质异常不解除） |
| 空名册 | 持门户岗位但不在任何在职联系人上的用户；联系人停用的用户；在名册上但没有门户岗位的用户；没开通门户的供应商的单据 | 每个对象零行 |
| 回收 | 停用 A 用户的联系人、撤销其门户岗位任命、执行 A 的淘汰处置后立即访问 | 看不到任何供应商数据 |
| 用户目录 | 用 A 的身份在界面和 REST API 上查询用户列表 | 看不到 B 的门户账号，也看不到内部员工的完整名单（§3.6） |
| 多通道 | 以上用例分别经门户界面、REST API、导出、AI 助手执行 | 结果一致 |
| 元数据守卫 | 检查门户权限集与共享规则 | 门户能读的每个对象都有读成员键的 RLS（或是子对象）；只授门户岗位的共享规则只有读权限且对象有这条 RLS；门户权限集不设 `isDefault`、不授删除 / 全量读写 / 导出；每个带供应商引用的对象要么授给门户，要么写明不授的理由 |

自动化：`test/portal-isolation.test.ts` 覆盖除「开标后改价」以外的全部用例，在 CI 里跑，不得删除或跳过（AGENTS.md
红线 2）；门户界面走的就是 REST API，导出经 REST 验证被拒；AI 助手以提问者身份查询、走同一套 RLS，v0.6 出口测试时
在托管环境人工复核一次（07 §6.2 V6）。

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
  体系文件 GL-10 第 6.8 条里约束（双人授权、访问留痕），不在应用权限里放开；
- **AI 助手不例外**：AI 以提问者的身份查询，同一条 RLS 生效（[06 §3](./06-integration-and-ai.md#3-ai-助手)）；
- **数量可见、内容不可见**：寻源单上的 `submitted_quote_count` 由平台在报价写入时重算，
  内部能看到「已报价 N 家」；
- **开标由 flow 以系统身份执行**：它需要更新内部尚不可见的报价，这是唯一被允许的
  系统身份写入，flow 本身留有运行记录；
- **价格记录不受封标约束**：`srm_supplier_admin`、`srm_buyer` 对价格记录可读，但价格记录
  在定标后才由 flow 产生，与中标报价一一对应，不泄露封标期间的任何报价；
- **平台管理员的数据库级访问**是已知例外，写进体系文件 GL-10 第 6.8 条（双人授权、报价截止前不访问报价、访问留痕定期检查）而不是应用权限。

### 4.2 字段级权限（FLS）

| 字段 | 谁可读 | 谁可改 | 原因 |
|---|---|---|---|
| `srm_supplier_bank_account.account_no` | 完整值：应付会计（`srm_finance`）、`srm_supplier_admin`、本公司门户管理员（v0.6）；其他内部岗位读到只留后 4 位的脱敏值。实现为字段 `maskingRule: 'bank_account'` + `requiredPermissions: ['srm_view_bank_account_no']`，能力由权限集 `systemPermissions` 授予；没有任何权限集给银行账户 `allowExport` | 新建时（`srm_supplier_admin`；v0.6 起门户管理员）、经变更单 flow；`pending_verify` 期间与有效后都只读 | 资金安全（BR-20） |
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
| `srm_supplier_contact.portal_user` | 内部、本公司门户 | 仅 flow（字段级只读） | 门户名册：写入即授出这家供应商的门户数据（ADR-0010） |
| `srm_supplier_contact.active` | 内部、本公司门户 | 内部（`srm_supplier_admin`）；门户只读 | 名册过滤条件，门户不能恢复被停用的账号 |
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
| 准入资料审核 ↔ 准入批准 | 第 1 级审批人是 `reviewer`（品类经理），第 2 级为采购总监岗位；初审人就是发起人时品类经理一级上提给采购总监、与第 2 级合并（03 §3 第 6 步） |
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
ADR-0138 D4），待 07 §6 V1 实测与
objectstack#25447 后再启用。启用时它是整个系统唯一对互联网开放的写入口，按下表防护；
另外提交后不直接建供应商主数据，由品类经理推进到「资料审核」时才建档（03 §3 第 2 步）。
公开表单**不收附件**（2026-10-24 决定）：需要上传营业执照、证书等文件的，供应商先注册账户、
登录门户后再上传，匿名入口因此没有文件写入面。

| 风险 | 控制 |
|---|---|
| 伪造系统字段（所有者、组织、时间戳） | 平台在公开表单写入时按名剥离服务端管理的字段，提交者无法指定 |
| 伪造业务状态（直接提交成「已通过」） | `state_machine` 的 `initialStates: ['submitted']`；`supplier`、`duplicate_check`、`reviewer` 等字段不出现在表单上且为只读 |
| 恶意附件 | 公开表单不放 `file` 字段；登录后上传的 `file` 字段限制类型（PDF / 图片）和大小 |
| 灌水、刷量 | 上线前在前置网关按 IP 限流；部署环境的公开表单如支持验证码，一并启用 |
| 读取他人申请 | 表单只写不读；申请人通过邮件收到受理编号，后续在门户中查看 |
