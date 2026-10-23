# hotsrm

基于 [ObjectStack](https://github.com/objectstack-ai/objectstack) 的通用供应商关系管理（SRM）应用。

hotsrm 管企业**与供应商协同**的那一半：供应商全生命周期、寻源定价、合同、订单与送货协同、
质量整改、绩效、对账开票、风险，以及面向供应商的门户。物料、库存、应付凭证和付款仍由
ERP 记账，hotsrm 不做第二套账。

## 三层结构

| 层 | 内容 | 设计 | 源码 |
|---|---|---|---|
| 通用核心 | 所有企业都需要的功能与管理制度 | [`docs/design/`](./docs/design/README.md) | `src/core/`（`type: app`） |
| 行业扩展包 | 同类企业共有的做法，按需组合：[大宗物料包](./docs/packs/bulk-materials.md)、[危化品包](./docs/packs/hazmat.md)、[国企采购合规包](./docs/packs/soe-procurement.md) | [`docs/packs/`](./docs/packs/README.md) | `src/bulk/`、`src/hazmat/`、`src/soe/`（`type: module`） |
| 客户配置 | 某个客户的参数取值、组织结构、物资目录、审批权限、文件样式 | — | 客户的私有仓库，不在本仓库 |

客户需求按「通用核心 → 扩展包 → 参数 → 定制」的顺序归位，定制尽量少（见
[扩展包总览](./docs/packs/README.md#1-三层结构)）。

## 扩展包怎么组合与安装

ObjectStack 中客户能安装的只有应用（`type: app`）。扩展包是模块，**在构建时和核心合成
一个应用**，而不是装完核心后再单独安装（见 [ADR-0002](./docs/adr/0002-packs-composed-into-one-app.md)）：

| 发行版 | 组合 | 在哪里组合 | 发布到 |
|---|---|---|---|
| 标准版 | 核心 | 本仓库 | 公开应用市场 |
| 客户版 | 核心 + 客户选定的扩展包 + 客户初始化数据 | 客户的私有仓库 | 只发布到该客户的组织 |

扩展包只通过对象扩展、选项列表扩展和导航贡献接入核心，不修改核心；两个扩展包之间的
联动放在桥接模块里。客户后来要加扩展包，发布同一个应用的新版本并升级即可（见
[扩展包总览 §3](./docs/packs/README.md#3-扩展包怎么组合与安装)）。

## 管理制度与系统同源

hotsrm 附带一套供应商管理体系文件模板（程序文件、管理办法、表单），源文件用 Markdown，
交付给客户的是生成的 Word / PDF。制度条款与系统控制点一一对应，审批金额、时限、等级线
等参数只在 `params/` 维护一处，同时用于生成制度文本和配置系统。见
[`governance/`](./governance/README.md) 与 [ADR-0005](./docs/adr/0005-governance-and-system-share-parameters.md)。

## 设计原则

- **只用元数据实现**：对象、校验规则、行级权限、flow、审批全部用平台元数据表达，在托管云
  上无需应用代码即可运行（[ADR-0001](./docs/adr/0001-declarative-only.md)）。
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
│   ├── packs/                     扩展包设计
│   └── adr/                       决策记录
├── governance/                    体系文件模板与生成脚本
├── params/                        参数定义与示例默认值（制度与系统共用）
├── src/
│   ├── core/                      核心（type: app）
│   ├── bulk/  hazmat/  soe/       三个扩展包（type: module）                 〔待建〕
│   └── bridges/                   扩展包之间的联动（type: module）           〔待建〕
├── test/                          启动测试；门户隔离、封标、组合构建、flow 测试随功能补齐
├── objectstack.composition.ts     按开关选出要组合的模块                      〔待建〕
├── objectstack.config.ts          合成一个发布制品
└── objectstack.manifest.json      标准版的应用标识                            〔待建〕
```

## 本地开发

需要 Node 22 和 pnpm 10。

```bash
pnpm install
pnpm dev          # 本地启动（内存库）
pnpm validate     # 每次改元数据后跑；其余检查见 AGENTS.md §6
```

## 当前状态

v0.1 开发中：工程骨架、CI 和核心应用外壳（`srm_workbench` 工作台、采购品类）已就位。
建议的 v0.1 范围是内部工作台上的供应商主数据、准入审批和资质到期预警，门户、寻源和 ERP 集成
放在后续版本。设计文档目录见 [docs/README.md](./docs/README.md)；参与开发前先读
[AGENTS.md](./AGENTS.md)。
