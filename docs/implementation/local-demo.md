# 本地演示环境

在自己电脑上跑起 hotsrm、按岗位登录做验收或演示。只用于本地开发库，不要对正式环境运行初始化脚本。

## 1. 准备

- Node 22、pnpm 10（`corepack enable` 后 pnpm 版本取 `package.json` 的 `packageManager`）、git
- 只需要本仓库；平台以 npm 包（`@objectstack/*`）引入，不用克隆 objectstack / objectui

推荐本地运行。本仓库没有 `.devcontainer`，在 Codespace 里要自己装 Node 22，转发端口后的登录也未验证过。

## 2. 启动

```bash
git clone https://github.com/objectstack-ai/hotsrm.git
cd hotsrm
pnpm install
OS_AUTOMATION_SCHEDULED_WORK_ENABLED=true pnpm dev
```

Windows PowerShell：`$env:OS_AUTOMATION_SCHEDULED_WORK_ENABLED="true"; pnpm dev`

看到 `Server is ready` 后保持这个窗口。数据库是 `.objectstack/data/objectstack.db`（sqlite），重启后数据还在。
开关 `OS_AUTOMATION_SCHEDULED_WORK_ENABLED` 让证书到期扫描、整改逾期提醒等定时 flow 运行，不开也能用，只是定时任务不执行。

## 3. 建账号、导入样例数据

另开一个终端，在仓库根目录运行（测试账号的密码自己定，至少 8 位，不写进仓库）：

```bash
HOTSRM_DEMO_PASSWORD=<自定密码> pnpm setup:local
```

Windows PowerShell：`$env:HOTSRM_DEMO_PASSWORD="<自定密码>"; pnpm setup:local`

脚本 [`scripts/setup-local.mjs`](../../scripts/setup-local.mjs) 用平台开发管理员（`objectstack dev` 在空库上种的账号，启动日志里会打印）调用接口：

1. 每个岗位建一个账号 `<账号>@hotsrm.local`，见下表；
2. 给三个演示品类（电子元器件、包装材料、工业品与备件）指派品类经理、SQE、采购员、评分人，审批和自动整改单按品类找人；
3. 按 [样例导入表格](../../data/samples/README.md) 的顺序和匹配字段导入物料、存量供应商、联系人、证书、合同与明细、2026-09 交付记录（导入后自动开出 2 张整改单）；物料按物料号前缀关联到演示品类。

可重复运行：账号已存在则跳过，导入按匹配字段更新，不会重复建记录。

## 4. 登录

打开 http://localhost:3000/_console/ ，用下表账号和自定密码登录。

| 账号 | 岗位 |
|---|---|
| director@hotsrm.local | 采购总监 |
| director2@hotsrm.local | 采购总监（第二位，验证「本人审批不计入」） |
| cm@hotsrm.local | 品类经理 |
| buyer@hotsrm.local | 采购员 |
| buyerlead@hotsrm.local | 采购主管 |
| sqe@hotsrm.local | SQE |
| qm@hotsrm.local | 质量经理 |
| iqc@hotsrm.local | IQC 检验员 |
| ap@hotsrm.local | 应付会计 |
| legal@hotsrm.local | 法务 |
| evaluator@hotsrm.local | 评分人 |
| gm@hotsrm.local | 总经理 |
| compliance@hotsrm.local | 内控 / 监标 |
| srmadmin@hotsrm.local | SRM 系统管理员 |

平台开发管理员只用于 Setup，没有 SRM 岗位，看不到 SRM 菜单，验收不要用它。

## 5. 常用操作

- 同时用两个岗位：一个普通窗口、一个无痕窗口各登一个账号
- 从头再来：停掉 `pnpm dev`，删除 `.objectstack` 目录，重新启动后再运行一次 `pnpm setup:local`
- 更新代码：`git pull && pnpm install`，已有数据保留

## 6. 已知平台问题

| 现象 | 处理 | 跟踪 |
|---|---|---|
| 非管理员在人员选择框里输入文字搜索会报错 | 不输入，直接从下拉列表点选 | objectstack#25672 |
| 多级审批第二级起，「提交人」显示为上一级审批人，真正的提交人看不到「撤回审批」 | 已知，验收时忽略 | objectstack#24817 |
| 审批通知标题是英文模板 “Approval requested / A decision on …” | 已知，验收时忽略 | objectstack#23978 |
