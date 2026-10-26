# hotsrm

基于 [ObjectStack](https://github.com/objectstack-ai/objectstack) 的通用供应商关系管理（SRM）应用。

hotsrm 管企业**与供应商协同**的那一半：供应商全生命周期、合同、质量整改、绩效、风险、
寻源定价，以及面向供应商的门户。采购订单、收货、对账、发票、付款留在 ERP，hotsrm 只记
结论、不做第二套账（[ADR-0008](./docs/adr/0008-order-to-pay-stays-in-erp.md)）。

## 三层结构

| 层 | 内容 | 设计 | 源码 |
|---|---|---|---|
| 通用核心 | 所有企业都需要的功能与管理制度 | [`docs/design/`](./docs/design/README.md) | `src/core/`（`type: app`） |
| 行业扩展包 | 同类企业共有的做法，按需组合：[大宗物料包](./docs/packs/bulk-materials.md)、[危化品包](./docs/packs/hazmat.md)、[国企采购合规包](./docs/packs/soe-procurement.md)。**设计保留，未排期**（[ADR-0009](./docs/adr/0009-core-first-pack-criteria-and-customer-layer.md)） | [`docs/packs/`](./docs/packs/README.md) | 将来放 `src/bulk/`、`src/hazmat/`、`src/soe/`（`type: module`） |
| 客户配置 | 某个客户的参数取值、组织结构、物资目录、审批权限、文件样式、Studio 覆盖层、客户私有包 | — | 客户的私有仓库与客户环境，不在本仓库 |

客户需求按「通用核心 → 扩展包 → 参数 → 定制」的顺序归位；现阶段只做核心包，客户个性化
放客户层，核心 API 名冻结（见 [扩展包总览](./docs/packs/README.md#1-三层结构) 与 ADR-0009）。

## 扩展包怎么组合与安装

ObjectStack 中客户能安装的只有应用（`type: app`）。扩展包是模块，**在构建时和核心合成
一个应用**，而不是装完核心后再单独安装（见 [ADR-0002](./docs/adr/0002-packs-composed-into-one-app.md)）：

| 发行版 | 组合 | 在哪里组合 | 发布到 |
|---|---|---|---|
| 标准版 | 核心 | 本仓库 | 公开应用市场 |
| 客户版 | 核心 + 客户选定的扩展包 + 客户初始化数据 | 客户的私有仓库 | 只发布到该客户的组织 |

扩展包只通过对象扩展、选项列表扩展和导航贡献接入核心，不修改核心；桥接模块等第二个
包出现再做。客户后来要加扩展包，发布同一个应用的新版本并升级即可（见
[扩展包总览 §3](./docs/packs/README.md#3-扩展包怎么组合与安装)）。

## 管理制度与系统同源

hotsrm 附带一套供应商管理体系文件模板（程序文件、管理办法、表单），源文件用 Markdown，
交付给客户的是生成的 Word / PDF。制度条款与系统控制点一一对应，审批金额、时限、等级线
等参数只在 `params/` 维护一处，同时用于生成制度文本和配置系统。见
[`governance/`](./governance/README.md) 与 [ADR-0005](./docs/adr/0005-governance-and-system-share-parameters.md)。

## 设计原则

- **只用元数据实现**：对象、校验规则、行级权限、flow、审批全部用平台元数据表达，在托管云
  上无需应用代码即可运行（[ADR-0001](./docs/adr/0001-declarative-only.md)）。
- **记结论、不记过程**：订单到付款留在 ERP，SRM 用导入的交付记录算绩效，预留集成点
  （[ADR-0008](./docs/adr/0008-order-to-pay-stays-in-erp.md)）。
- **供应商之间零可见**：门户按供应商隔离，取不到隔离依据时一行也不放行
  （[ADR-0003](./docs/adr/0003-portal-isolation-by-supplier-position.md)）。
- **封标**：开标前，内部任何角色（包括 AI 助手）都读不到报价
  （[ADR-0004](./docs/adr/0004-sealed-bid.md)）。
- **流程即 flow**：单据状态是对象上的字段，审批是 flow 节点，审批历史由平台保存。

## 仓库结构

```
hotsrm/
├── README.md
├── AGENTS.md                      开发规则与红线（人和 AI agent 共用）
├── CLAUDE.md                      指向 AGENTS.md
├── docs/                          文档，地图见 docs/README.md
│   ├── design/                    核心设计
│   ├── packs/                     扩展包设计（设计保留，未排期）
│   ├── engineering/               建模规范、CI 门禁、测试与版本策略
│   └── adr/                       决策记录
├── governance/                    体系文件模板与生成脚本
├── params/                        参数定义与示例默认值（制度与系统共用）
├── src/
│   └── core/                      核心（type: app）；v0.1 已合入（PR #5）
│       （扩展包 bulk/ hazmat/ soe/ 与桥接模块等有客户要求时再建，ADR-0009）
├── test/                          启动测试与 flow 测试；门户隔离（v0.6 起）、封标（v0.7 起）
├── objectstack.composition.ts     按开关选出要组合的模块（现只有核心）
├── objectstack.config.ts          发布制品
└── objectstack.manifest.json      标准版的应用标识（市场展示信息）
```

## 本地开发

需要 Node 22 和 pnpm 10。

```bash
pnpm install
pnpm dev          # 本地启动（sqlite，库文件在 .objectstack/data/）
pnpm validate     # 每次改元数据后跑；其余检查见 AGENTS.md §6
```

按岗位建测试账号、导入样例数据做验收或演示，见 [本地演示环境](./docs/implementation/local-demo.md)。

定时 flow（证书到期扫描）受部署开关 `OS_AUTOMATION_SCHEDULED_WORK_ENABLED` 控制，平台默认关闭，本地和
托管云都要显式打开才会运行；托管云上如何为本应用打开，待与平台确认。

## 当前状态

2026-10-23：范围与路线重定（ADR-0008、ADR-0009）。核心收到 **27 个对象**（2026-10-24 审核问题项改为子对象后为 28 个），按版本交付：

| 版本 | 内容 | 累计对象 |
|---|---|---|
| v0.1（已合入，PR #5） | 内部工作台：主数据、两级准入审批、资质到期扫描 | 7 |
| v0.2（已合入，PR #13–#18） | 物料只读副本、银行账户、存量导入、信息变更单 | 10 |
| v0.3（已合入，PR #29–#33、#41） | 合同与协议、供应商处置 | 13 |
| v0.4（已合入，PR #40、#42、#44–#46、#56、#57） | 交付记录导入、质量问题 / SCAR、供应商审核与年度审核计划 | 17 |
| v0.5 | 绩效、风险事件、管理报表 = 内部版 MVP，试运行 | 21 |
| v0.6 | 供应商门户（依赖 objectstack#25233） | 22 |
| v0.7 | 寻源与封标、价格库；核心对象冻结 | 28 |

已完成：核心设计、三个扩展包设计（保留）、ADR-0001～0009、参数文件首版、体系文件生成脚本
和 16 份模板、v0.1 内部工作台（PR #5）、v0.2 主数据补齐（PR #13–#18）、v0.3 合同与处置（PR #29–#33、#41）、v0.4 质量（PR #40、#42、#44–#46、#56、#57）。文档目录见 [docs/README.md](./docs/README.md)；
参与开发前先读 [AGENTS.md](./AGENTS.md)。

下一步：v0.5 绩效与风险——指标库、按周期考评、风险事件与黑名单，出口即门槛 1 内部 MVP 验收（[07 §1](./docs/design/07-delivery-plan.md#1-分期路线图)）。
