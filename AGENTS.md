# AGENTS.md

在本仓库工作的人和 AI agent 都要先读完本文件。本文件是工作规则的唯一出处，`CLAUDE.md`
只指向这里，不另写规则。

## 1. 项目是什么

hotsrm 是基于 [ObjectStack](https://github.com/objectstack-ai/objectstack) 的通用供应商关系
管理（SRM）应用，由三层组成：

- **通用核心**：设计在 `docs/design/`，源码在 `src/core/`（`type: app`）；
- **行业扩展包**：设计在 `docs/packs/`，源码在 `src/bulk/`、`src/hazmat/`、`src/soe/`
  （`type: module`），构建时与核心合成一个应用（[ADR-0002](./docs/adr/0002-packs-composed-into-one-app.md)）；
- **客户配置**：参数取值、组织、物资目录、样式等，放在客户的私有仓库，**不进本仓库**。

文档地图见 [docs/README.md](./docs/README.md)，关键决定见 [docs/adr/](./docs/adr/README.md)。

## 2. 红线（违反即退回）

1. **只用元数据**（[ADR-0001](./docs/adr/0001-declarative-only.md)）：业务规则不得依赖生命周期
   钩子、插件或服务端函数。托管云不执行应用包代码，依赖它们的规则会静默失效。
2. **供应商之间零可见**（[ADR-0003](./docs/adr/0003-portal-isolation-by-supplier-position.md)）：
   - 新增面向供应商的顶层对象，必须同时有 `portal_position` 字段、前缀校验规则、门户 RLS
     和隔离测试；
   - 内部权限集一律不设 `isDefault`；
   - 不得删除或跳过隔离测试。
3. **封标**（[ADR-0004](./docs/adr/0004-sealed-bid.md)）：任何能读到报价的权限集、报表、视图
   都必须受 `bid_opened == true` 约束；不得给任何角色报价对象的全量读取权限。
4. **扩展包不改核心**：扩展包只能用 `objectExtensions`、`picklistExtensions`、导航贡献三种
   方式接入核心，不修改 `src/core/` 下的文件；扩展包之间不互相引用，联动放
   `src/bridges/<A>-<B>/`。
5. **不写客户信息**：本仓库是公开仓库。不写客户名称，也不写能认出客户的组合（某客户的
   物料清单、组织形态、合同条款）；参数只用标明「示例」的行业常见值。
6. **不提交密钥**：连接串、令牌、密码、证书私钥一律不进仓库、提交信息、PR 和文档。

## 3. 元数据约定

- `@objectstack/spec` 是唯一契约。元数据跑不通时改元数据，不去放宽运行时；不确定某个
  写法是否合法时，查框架源码中的规范定义，不要猜。
- 命名：核心对象 `srm_*`；扩展包对象 `srm_bulk_*`、`srm_hz_*`、`srm_soe_*`；字段名和选项值
  用 snake_case，不以数字开头。
- 建模原则见[核心 02 §1](./docs/design/02-domain-model.md#1-建模原则)，要点：
  - 状态是主对象上的 `select` 字段，作为 `stageField`，每个选项带 `kind`；
    `state_machine` 校验同时声明 `transitions` 和 `initialStates`；
  - 审批是 flow，不建审批记录表；
  - 汇总字段写明 `summaryOperations`，带条件的用 `filter`；
  - 每个对象显式声明 `sharingModel`；
  - 布尔字段不设必填，给默认值；人员字段默认非必填；
  - 可能被扩展包追加选项的枚举做成共享选项列表。
- 一个对象一个文件；标签用中文，并补英文翻译。

## 4. 文档约定

- 正文用简体中文，机器名用英文。
- 先改设计再改元数据：行为变化先更新 `docs/design/` 或 `docs/packs/` 的对应章节，再改源码。
- 新的关键决定写 ADR；改变已有决定时写新的 ADR 取代旧的，不改写旧记录的「决定」部分。
- `docs/reference/` 由脚本从元数据生成，禁止手改。
- 体系文件条款与系统控制点同步修改：改了一边，检查另一边（[ADR-0005](./docs/adr/0005-governance-and-system-share-parameters.md)）。
- 体系文件模板只写通用表述，不写【待确认】和任何客户信息；客户的取值、标注和专属段落放
  客户私有仓库（见 [governance/README.md §5](./governance/README.md#5-客户实例与生成方式)）。

## 5. 提交与 PR

- 在分支上工作，通过 PR 合入 `main`，不直接推 `main`，不强推。
- 提交信息用英文，格式 `type(scope): summary`（如 `docs(packs): …`、`feat(core): …`）。
- AI 生成的提交以两行结尾，不写模型名称：
  `Claude-Session: <会话链接>` 和 `Co-authored-by: Claude <noreply@anthropic.com>`。
- PR 说明写清改了什么、为什么、怎么验证的。

## 6. 验证

- 文档：所有相对链接和锚点有效。
- 体系文件：`python3 governance/scripts/build.py --check` 与
  `python3 governance/scripts/build.py --check --packs bulk,hazmat,soe` 都通过；改了模板的，
  生成 Word 打开检查版式。
- 元数据（有代码之后）：校验、类型检查、lint、构建、测试全部通过；每种扩展包组合都能构建。
