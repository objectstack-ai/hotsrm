import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 审核问题项转整改单（03 §8 第 1 步、§13，FR-607；WI-01 6.7.4）：SQE 在已完成的审核记录上一次把还没转出的
// 不符合项（严重、一般；观察项不转）各生成一张 source = audit 的整改单，并把整改单回填到问题项。
// 已转出的问题项不再转，重复点击不重复开单。严重不符合 → 整改单「严重」，一般不符合 → 「主要」
// （两者都要求供应商按 8D 回复，「次要」只计入绩效）；负责 SQE 为操作人，期限按整改单的默认值计算。
// 以系统身份运行：岗位检查写在 flow 里（objectstack#25481，同 srm_bank_verify）。
const allowed = `current_user != null && ('srm_sqe' in current_user.positions || 'srm_quality_manager' in current_user.positions)`;
const isDone = `audit != null && audit.status == 'done'`;
const pendingOf = `findings.filter(f, f.severity != 'observation' && (!has(f.quality_issue) || f.quality_issue == null || isBlank(f.quality_issue)))`;
const hasPending = `${pendingOf}.size() > 0`;
const cond = (source: string) => ({ dialect: 'cel' as const, source });
const text = (k: string) => `(has(finding.${k}) && finding.${k} != null && !isBlank(finding.${k}) ? finding.${k} : '')`;

export const AuditFindingToScarFlow: Automation.Flow = {
  name: 'srm_audit_finding_to_scar',
  label: '转整改单',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '已为不符合项生成整改单',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取审核',
      config: { objectName: 'srm_supplier_audit', filter: { id: cel`recordId` }, outputVariable: 'audit' },
    },
    {
      id: 'load_findings',
      type: 'get_record',
      label: '读取问题项',
      config: {
        objectName: 'srm_supplier_audit_finding',
        filter: { audit: cel`audit != null ? audit.id : ''` },
        limit: 200,
        outputVariable: 'findings',
      },
    },
    { id: 'gate', type: 'decision', label: '可以转？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是质量岗位',
      config: { outcome: 'refused', message: '只有 SQE 或质量经理可以把审核问题项转为整改单' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '审核未完成',
      config: { outcome: 'refused', message: '审核完成后才能把问题项转为整改单' },
    },
    {
      id: 'refuse_none',
      type: 'end',
      label: '没有待转的问题项',
      config: { outcome: 'refused', message: '没有待转的不符合项：观察项不转整改单，已转出的不再重复转' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认转整改单',
      config: {
        title: '转整改单：{{ audit.audit_no }}',
        description: '将为本次审核中还没转出的严重、一般不符合项各生成一张整改单，由你担任负责 SQE。观察项不转。',
        waitForInput: true,
      },
    },
    {
      id: 'each_finding',
      type: 'loop',
      label: '逐条问题项',
      config: {
        collection: cond(pendingOf),
        iteratorVariable: 'finding',
        body: {
          nodes: [
            {
              id: 'guard_finding',
              type: 'try_catch',
              label: '单条问题项',
              config: {
                try: {
                  nodes: [
                    {
                      id: 'create_issue',
                      type: 'create_record',
                      label: '新建整改单',
                      config: {
                        objectName: 'srm_quality_issue',
                        fields: {
                          supplier: cel`audit.supplier`,
                          audit: cel`audit.id`,
                          source: 'audit',
                          severity: cel`finding.severity == 'serious' ? 'critical' : 'major'`,
                          problem_description: cond(
                            `'审核 ' + audit.audit_no + ' 问题项：' + finding.title`
                            + ` + (${text('description')} != '' ? '\\n事实：' + ${text('description')} : '')`
                            + ` + (${text('requirement')} != '' ? '\\n整改要求：' + ${text('requirement')} : '')`,
                          ),
                          sqe: cel`current_user.id`,
                        },
                        outputVariable: 'issue',
                      },
                    },
                    {
                      id: 'link_finding',
                      type: 'update_record',
                      label: '回填问题项',
                      config: { objectName: 'srm_supplier_audit_finding', filter: { id: cel`finding.id` }, fields: { quality_issue: cel`issue.id` } },
                    },
                  ],
                  edges: [{ id: 'e_link', source: 'create_issue', target: 'link_finding', type: 'default' }],
                },
                // 单条失败不影响其他问题项；没转出的下次再点「转整改单」补上
                catch: { nodes: [{ id: 'skip_finding', type: 'assignment', label: '跳过该条' }] },
              },
            },
          ],
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'load_findings', type: 'default' },
    { id: 'e2', source: 'load_findings', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_position', type: 'conditional', condition: cond(`!(${allowed})`), label: '不是质量岗位' },
    { id: 'e4', source: 'gate', target: 'refuse_status', type: 'conditional', condition: cond(`${allowed} && !(${isDone})`), label: '未完成' },
    {
      id: 'e5',
      source: 'gate',
      target: 'refuse_none',
      type: 'conditional',
      condition: cond(`${allowed} && ${isDone} && !(${hasPending})`),
      label: '没有待转',
    },
    { id: 'e6', source: 'gate', target: 'confirm', type: 'conditional', condition: cond(`${allowed} && ${isDone} && ${hasPending}`), label: '可以' },
    { id: 'e7', source: 'confirm', target: 'each_finding', type: 'default' },
    { id: 'e8', source: 'each_finding', target: 'end', type: 'default' },
  ],
};
