# ADR-0010：门户按「联系人名册上的成员键」隔离

- 状态：已采纳；取代 [ADR-0003](./0003-portal-isolation-by-supplier-position.md)
- 日期：2026-11-02

## 背景

ADR-0003 让每家开通门户的供应商对应一个岗位 `srm_vendor_<编号>`，每张面向供应商的单据冗余
`portal_position`，门户 RLS 写成 `portal_position in current_user.positions`。代价是：岗位是环境级
元数据，每家供应商首次开通都要管理员新建一个；每个对象多一个冗余字段、一条前缀校验规则和一个
回填 flow；`runAs: 'system'` 的 flow 不得写岗位任命（objectstack#25251），开通门户无法自动化。

平台 18.1.0 起可以用元数据声明**成员键**（`ObjectSchema.membershipKeys`，objectstack#25234）：在名册
对象上写明用户列（`userField`）、取值列（`valueField`）和可选的过滤条件（`filter`），平台每个请求以
系统身份读一次名册，把结果作为 `current_user.<键>` 交给 RLS。ADR-0003「待验证」最后一条正是在等这项
能力；2026-10-26 总监裁定：v0.6 U2 先限时实测，通过则写新 ADR 改用。

约束与 ADR-0003 相同：只用元数据（[ADR-0001](./0001-declarative-only.md)）；取不到隔离依据时一行都不
放行（fail-closed）；界面、REST API、导出、AI 助手各通道都生效。

## 决定

- **名册**是供应商联系人：`srm_supplier_contact` 的 `portal_user`（user，字段级只读）指向门户账号。
  成员键 `portal_supplier_ids` 声明在联系人上：`userField: 'portal_user'`、`valueField: 'supplier'`、
  `filter: 'active == true'`。`current_user.portal_supplier_ids` 就是当前用户作为在职联系人所属的供应商。
- **门户 RLS** 一律读这个键：供应商自身 `id in current_user.portal_supplier_ids`，带 `supplier` 引用的
  顶层对象 `supplier in current_user.portal_supplier_ids`，状态限定照旧叠加（合同只放行签署中及以后，
  考评单只放行已发布）。`controlled_by_parent` 子对象跟随主记录。
- **岗位是静态的**：全体门户用户任命到 `srm_portal_user`（挂 `srm_portal_supplier`），本公司门户管理员
  再任命到 `srm_portal_admin`（挂 `srm_portal_admin`）。门户用户按组织角色 `external` 邀请。不再为每家
  供应商建岗位。
- **private 对象要两把锁**：`external` 成员对 OWD 一律按「仅本人」处理，权限集上的 RLS 只在 `public_read`
  对象上解除这个下限，解除不了 `private`。准入申请、变更单、合同各加一条只授 `srm_portal_user` 的读共享
  规则（合同只共享门户可见的状态），行范围再由门户 RLS 限定到本公司。共享规则本身是全量授权，所以
  元数据测试要求：门户能读的每个对象，要么是子对象，要么在同一个权限集里有读成员键的 RLS。
- **授权就是写名册**：写了 `portal_user` 就等于把这家供应商的门户数据授给这个用户。它是字段级只读，
  任何岗位都不能在界面或 REST 上写，只由 flow 写入（开通门户、处置执行）。在职标志 `active` 是名册的
  过滤条件，对门户也是只读，门户管理员不能恢复一个被停用的账号。
- **回收**：联系人离职、停用 → `active = false`，下一个请求起看不到任何数据；供应商淘汰或拉入黑名单 →
  `srm_disposition_apply` 清掉该供应商全部联系人的 `portal_user`，不靠人工停用联系人；撤销门户岗位任命
  同样立即生效。组织成员身份由管理员移除（`runAs: 'system'` 的 flow 不得改成员，objectstack#25251）。
- **`portal_position` 不加**：它从未合入主干，不涉及核心 API 名冻结（ADR-0009）。随之取消前缀校验规则、
  `srm_portal_position_backfill` 回填 flow 和每家供应商一个的门户岗位。
- 寻源沿用 ADR-0003 的做法：一张寻源单要给多家供应商看，门户不读寻源单本身，发布时把供应商要看的信息
  快照到邀请和报价上；邀请、报价带 `supplier`，按上面的写法隔离。封标（[ADR-0004](./0004-sealed-bid.md)）
  在 v0.7 按成员键重读一遍，`bid_opened` 仍是 RLS 上的第二个条件。

## 考虑过的方案

| 方案 | 为什么没选 |
|---|---|
| 沿用 ADR-0003：每家供应商一个门户岗位 + `portal_position` | 能工作，但每家供应商要管理员建岗位、每个对象多冗余字段 / 校验 / 回填；开通无法自动化。成员键在同样的约束下更少出错 |
| 名册另建对象（门户账号表：用户 + 供应商 + 有效） | 多一个对象和一套维护界面；联系人本来就是「谁代表哪家供应商」，`portal_user` 早已规划在联系人上（02 §4.1） |
| private 对象改用 `viewAllRecords` + RLS | 只有一把锁：RLS 一旦被误删，门户就能读全部行。共享规则 + RLS 两把锁，草稿合同连共享都不进 |
| 把门户权限集挂到平台内置的 `org_external` 身份上，不再任命门户岗位 | `org_external` 是平台保留名，应用不能挂权限集；即使能挂，同一环境里别的应用的外部用户也会拿到 SRM 的门户权限 |

## 后果

- 新增面向供应商的顶层对象，必须同时有：`supplier` 引用（或能经主记录追溯到供应商）、门户权限集上读成员键
  的 RLS、private 对象的门户读共享规则，以及隔离测试（AGENTS.md 红线 2，[核心 04 §3.7](../design/04-security-and-portal.md#37-隔离验收测试)）。
  `test/portal-isolation.test.ts` 同时检查元数据，缺 RLS 的对象过不了 CI。
- 平台在键取不到、为空、超过 1,000 个值、名册读失败、同名键被声明两次时，一律丢弃读这个键的策略并拒绝，
  所以故障表现为「门户看不到数据」而不是越权。
- 开通门户（v0.6 U3）只需：邀请为 `external` → 任命 `srm_portal_user`（能否由 flow 完成见 07 §6.2 V2）→ flow 在
  联系人上写 `portal_user`。不再需要建岗位定义。
- 同一用户只应登记在一家供应商的一位联系人上；登记在两家时两家的数据都能看到。开通门户的 flow 负责检查，
  平台没有「非空值唯一」的约束可以兜底。
- 内部权限集仍一律不设 `isDefault`（`external` 不受默认权限集作用，但内部员工受）。

## 待验证

- 限时实测（2026-11-02，平台 18.1.0，`@objectstack/verify` 进程内启动，与托管环境同一套 `plugin-security`）：
  - 结果（2026-11-02）：通过。`external` 门户用户只看到本公司的供应商、联系人、证书、品类资格、银行账户、
    准入申请、变更单、合同（含明细）、交付记录、整改单、考评单（含评分明细）；按 id 读其他供应商的记录
    返回不存在，REST 列表、搜索、query 一致，导出被拒；改其他供应商的记录、把自己的单据挂到别家名下、
    在别家名下建联系人或证书、写 `portal_user`、改联系人在职标志一律被拒；名册为空、联系人停用、没有
    门户岗位时每个对象都是零行；停用联系人、撤销任命、执行淘汰后下一个请求即失效；用户与成员列表只返回
    自己。用例见 `test/portal-isolation.test.ts`。
  - 发现：对 `external` 成员，权限集上的 RLS 只解除 `public_read` 对象的「仅本人」下限，`private` 对象还要共享
    （上文「两把锁」）；这一点方案 A 同样适用。
- 托管云复测：本次实测没有托管环境。成员键由平台代码解析，不是应用包代码，不受「托管云可以关闭应用包代码」
  影响；但仍作为 **v0.6 出口条件**在托管环境复测一次（07 §6.2 V6），覆盖「键为空」和「运行时不认识这个键
  （未声明 / 未解析）」两种情形，期望都是拒绝、零行。
- AI 助手通道：AI 以提问者身份查询，走同一套 RLS；v0.6 出口测试经 AI 助手复核一次。
