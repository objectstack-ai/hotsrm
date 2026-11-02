# hotsrm 工程规范

> 状态：首版（2026-10-23）。随 v0.1 W3 建立；建模规范来自平台契约与 2026-10-23 的设计审核，
> 测试与版本策略来自开发计划第 11 节。规则与 [AGENTS.md](../../AGENTS.md) 冲突时以 AGENTS.md 为准。

## 1. 建模规范

补充 [核心 02 §1](../design/02-domain-model.md#1-建模原则) 的建模原则，都是平台校验会直接拒收、
或能发布但运行时不对的写法。

| 规则 | 说明 | 出处 |
|---|---|---|
| 字段谓词只读本记录 | `requiredWhen`、`readonlyWhen`、选项的 `visibleWhen` 若经 lookup / master_detail / user / tree 字段读关联记录，`objectstack validate` 直接拒绝；`previous.*`、`parent.*` 在任何地方都没有一跳 | objectstack ADR-0137 D2，迁移 `field-predicate-reference-traversal-refused` |
| 关联记录只在 `script` 校验规则里读 | `validations[]` 的 `script` 规则会预加载一跳关联记录，可用 `now()` / `today()`；两跳以上的依据冗余到本记录，或改走 screen flow | 核心 02 §1 第 12 条 |
| 字段名不含 `role` | `role` 是平台保留禁用词；联系人的角色字段叫 `contact_function` | objectstack ADR-0090 D3 |
| `stageField` 不用共享选项列表 | 状态字段的每个选项必须带 `kind`，只能内联定义；其他可被扩展的枚举才做成 picklist | 迁移 `stage-field-option-kind-required` |
| 唯一约束按组织作用域、空值安全 | 声明索引用 `unique: 'organization'`；允许多条空值的组合唯一（如境外供应商的 `country` + `registration_no`）用平台的空值安全写法 | objectstack ADR-0120 |
| 跨记录规则不写校验规则 | 「每家供应商至多一位主联系人」这类规则由 screen flow 以系统身份处理，不写成单条校验；校验规则只经父记录的带条件汇总做守卫（拒绝第二位），同一批写入拦不住（objectstack#25477） | 审核 F-29 |
| 可改不可删用共享规则 | 要让某岗位改别人建的记录（含种子数据）但不能删：OWD 保持 `public_read`，权限集给 `allowEdit`、不给 `modifyAllRecords`（它连删除一起放开），再加按岗位授 `edit` 的 `criteria` 共享规则；条件不能恒真（平台当作不匹配），写成必填字段非空，如 `record.code != ''` | objectstack#25470 裁定；`srm_kpi_director_edit`（v0.5）；供应商、物料、合同、整改单、供应商审核、风险事件同样用（`src/core/security/sharing-rules.ts`，#60），不再用 OWD `public_read_write` |
| 表达式默认值先判 `has()` | 默认值按字段声明顺序计算，读后声明字段时该字段可能还没取默认值，写成 `has(record.x) && record.x == …` | v0.2 存量导入 |
| 平台限制提需求 | 遇到平台做不到的，先查重再在 objectstack 提 issue，PR 里链接；变通做法写明是临时措施，并登记到 07 §6.3 | 2026-10-23 用户要求 |
| 外部单号字段预留、空着 | `erp_vendor_code`、`erp_material_no` 等字段保留在对象上，ERP 集成前不写 | [ADR-0008](../adr/0008-order-to-pay-stays-in-erp.md) |
| 中国特有字段单独分组 | 统一社会信用代码、纳税人类型等放在「工商与税务」分组，便于将来拆中国本地化包 | [ADR-0009](../adr/0009-core-first-pack-criteria-and-customer-layer.md) |

## 2. 分支与 PR

- 每个工作项一个 PR，标题带版本和编号（如 `feat(core): v0.2 M2 bank account`）；一个 PR 不跨版本。
- PR 描述列出改动的对象、flow、权限集和对应的设计文档章节；设计与实现不一致时同一 PR 改文档。
- 改对象名、字段名、字段类型必须附 ADR；门槛 2（核心对象冻结）之后还要附迁移说明。

## 3. CI 门禁（全部必须绿）

| 检查 | 要求 | 起始版本 |
|---|---|---|
| `os validate` | 元数据合法，无自定义 hook（ADR-0001） | v0.1 |
| `os i18n check --strict` | zh / en 全部键齐全（ADR-0007） | v0.1 |
| `governance/scripts/build.py --check` | 体系文件模板无待确认占位，参数引用全部已定义 | v0.1 |
| 文档链接检查 | docs 内部链接与锚点无失效 | v0.1 |
| 导入幂等 | 样例表格跑两遍结果一致 | v0.2 |
| 隔离测试 | 门户跨公司访问七条路径（列表、详情 URL、关联搜索、报表、文件下载、API、用户目录）全部拒绝 | v0.6 |
| 封标测试 | 截止前内部任何岗位（含管理员视图、报表、导出、API）读不到报价 | v0.7 |

## 4. 测试策略

- **元数据级**：每个对象一组种子数据；每条校验规则一正一反。
- **流程级**：每条审批流覆盖通过、驳回、退回、升级；定时 flow 用追赶式测试（漏跑一次后下一次补上）。
- **权限级**：每个岗位一份「能看到什么」的快照，权限变更时对比。
- 用平台的 verify 工具在进程内启动整个应用包做端到端断言，失败即阻断发布。

## 5. 版本与升级

- 应用包按语义化版本发布，每个版本（v0.1 … v0.7）一个次版本号。
- 破坏性变更（删字段、改选项值、改 API 名）必须附 ADR 和数据迁移；核心字段只能隐藏，不能删除。
- 核心升级前跑一次「核心 + 客户层」组合构建，补平台尚未检测的覆盖层冲突（ADR-0009）。
- 每个版本出口时更新 [07 §1](../design/07-delivery-plan.md#1-分期路线图) 的路线表和根 README 的对象数。
