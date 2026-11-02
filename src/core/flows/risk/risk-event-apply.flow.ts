import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 高风险事件处理（03 §11，FR-903）：风险事件新建为高风险或改为高风险时，为合格供应商生成冻结（全部品类）处置单
// 草稿并回填到事件的 disposition，通知供应商各品类的品类经理核实后提交审批或作废（没有品类经理时通知全部品类经理）。
// 不直接发起审批：风险是否成立、要不要冻结由品类经理判断，草稿只是把处置准备好。
// - 这家供应商已有冻结草稿：不再建，事件指向那张草稿（多个高风险事件合并到一张处置单）；
// - 已有审批中的处置单，或供应商不是合格状态（已冻结、淘汰、黑名单、准入中）：不生成草稿，只通知。
const becameHigh = `record.severity == 'high' && record.status != 'closed' && (previous == null || !has(previous.severity) || previous.severity != 'high') && (!has(record.disposition) || record.disposition == null)`;
const canDraft = `vendor != null && vendor.status == 'qualified' && (!has(vendor.open_disposition_count) || vendor.open_disposition_count == 0)`;
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
// 供应商各品类的品类经理；一个都没有时通知全部品类经理
const managers = cel$(
  `size(categories.filter(c, has(c.category_manager) && c.category_manager != null)) > 0`
  + ` ? categories.filter(c, has(c.category_manager) && c.category_manager != null).map(c, c.category_manager)`
  + ` : allManagers.map(p, p.user_id)`,
);

const notify = (id: string, label: string, title: string, message: string) => ({
  id: `${id}_guard`,
  type: 'try_catch' as const,
  label,
  config: {
    try: {
      nodes: [
        {
          id,
          type: 'notify' as const,
          label,
          config: { recipients: managers, title, message, severity: 'warning' as const, sourceObject: 'srm_risk_event', sourceId: cel`record.id` },
        },
      ],
    },
    // 没有可通知的人时不影响草稿
    catch: { nodes: [{ id: `${id}_skip`, type: 'assignment' as const, label: '跳过通知' }] },
  },
});

export const RiskEventApplyFlow: Automation.Flow = {
  name: 'srm_risk_event_apply',
  label: '高风险事件生成处置单草稿',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '风险事件为高风险',
      config: { objectName: 'srm_risk_event', triggerType: 'record-after-write', condition: cel$(becameHigh) },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'vendor' },
    },
    {
      id: 'load_qualifications',
      type: 'get_record',
      label: '读取品类资格',
      config: { objectName: 'srm_supplier_category', filter: { supplier: cel`record.supplier` }, limit: 200, outputVariable: 'qualifications' },
    },
    {
      id: 'load_categories',
      type: 'get_record',
      label: '读取品类',
      config: { objectName: 'srm_category', filter: { id: { $in: cel`qualifications.map(q, q.category)` } }, limit: 200, outputVariable: 'categories' },
    },
    {
      id: 'load_all_managers',
      type: 'get_record',
      label: '读取全部品类经理',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_category_manager' }, limit: 50, outputVariable: 'allManagers' },
    },
    { id: 'can_draft', type: 'decision', label: '可以生成冻结草稿？' },
    {
      id: 'find_draft',
      type: 'get_record',
      label: '已有冻结草稿？',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { supplier: cel`record.supplier`, status: 'draft', action: 'freeze' },
        outputVariable: 'existingDraft',
      },
    },
    { id: 'has_draft', type: 'decision', label: '已有草稿？' },
    {
      id: 'create_draft',
      type: 'create_record',
      label: '生成冻结处置单草稿',
      config: {
        objectName: 'srm_supplier_disposition',
        fields: {
          supplier: cel`record.supplier`,
          action: 'freeze',
          scope: 'all',
          status: 'draft',
          reason: cel`'高风险事件 ' + record.event_no + '：' + record.description`,
        },
        outputVariable: 'draft',
      },
    },
    {
      id: 'link_new',
      type: 'update_record',
      label: '事件回填处置单',
      config: { objectName: 'srm_risk_event', filter: { id: cel`record.id` }, fields: { disposition: cel`draft.id` } },
    },
    {
      id: 'link_existing',
      type: 'update_record',
      label: '事件指向已有草稿',
      config: { objectName: 'srm_risk_event', filter: { id: cel`record.id` }, fields: { disposition: cel`existingDraft.id` } },
    },
    notify(
      'notify_draft',
      '通知品类经理：已生成冻结草稿',
      '高风险事件 {{ record.event_no }}：已生成冻结处置单草稿',
      '供应商出现高风险事件，系统已生成冻结（全部品类）处置单草稿。请核实风险后在处置单上「提交审批」，不需要冻结时「作废」。',
    ),
    notify(
      'notify_only',
      '通知品类经理：未生成草稿',
      '高风险事件 {{ record.event_no }}：请评估处置',
      '供应商出现高风险事件。供应商不是合格状态或已有审批中的处置单，系统没有生成冻结草稿，请评估是否需要其他处置。',
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_supplier', type: 'default' },
    { id: 'e2', source: 'load_supplier', target: 'load_qualifications', type: 'default' },
    { id: 'e3', source: 'load_qualifications', target: 'load_categories', type: 'default' },
    { id: 'e4', source: 'load_categories', target: 'load_all_managers', type: 'default' },
    { id: 'e5', source: 'load_all_managers', target: 'can_draft', type: 'default' },
    { id: 'e_yes', source: 'can_draft', target: 'find_draft', type: 'conditional', condition: cel$(canDraft), label: '合格且没有审批中的处置单' },
    { id: 'e_no', source: 'can_draft', target: 'notify_only_guard', type: 'conditional', condition: cel$(`!(${canDraft})`), label: '不能生成' },
    { id: 'e6', source: 'find_draft', target: 'has_draft', type: 'default' },
    { id: 'e_new', source: 'has_draft', target: 'create_draft', type: 'conditional', condition: P`existingDraft == null`, label: '没有' },
    { id: 'e_old', source: 'has_draft', target: 'link_existing', type: 'conditional', condition: P`existingDraft != null`, label: '已有' },
    { id: 'e7', source: 'create_draft', target: 'link_new', type: 'default' },
    { id: 'e8', source: 'link_new', target: 'notify_draft_guard', type: 'default' },
    { id: 'e9', source: 'link_existing', target: 'notify_draft_guard', type: 'default' },
    { id: 'e10', source: 'notify_draft_guard', target: 'end', type: 'default' },
    { id: 'e11', source: 'notify_only_guard', target: 'end', type: 'default' },
  ],
};
