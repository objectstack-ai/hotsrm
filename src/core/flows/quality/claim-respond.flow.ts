import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 供应商确认索赔（03 §8 第 6 步，FR-606，v0.6 U5）：SQE 提出索赔（claim_status = proposed）后，供应商在门户的整改单上点
// 「确认索赔」，选择接受或提出异议并写意见（异议必填）。接受 → supplier_accepted，通知负责 SQE 与应付会计（财务据此在 ERP
// 扣款，回来标记「已扣款」）；异议 → disputed，通知负责 SQE 协商，SQE 调整后可重新提出。没开通门户的供应商仍由 SQE 线下
// 确认后直接改索赔状态。
// 以系统身份运行：索赔状态对门户字段级只读，门户只能经这个 flow 改。进门检查代替 RLS 做隔离：操作人必须持门户岗位，
// 并且是这张整改单所属供应商的在职联系人（与成员键 portal_supplier_ids 的名册条件相同，02 §4.1、04 §3.1）。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const member = `current_user != null && 'srm_portal_user' in current_user.positions && issue != null && membership != null`;
const proposed = `has(issue.claim_status) && issue.claim_status == 'proposed'`;

const notify = (id: string, label: string, recipients: string, title: string, message: string): Automation.FlowNode => ({
  id,
  type: 'try_catch',
  label,
  config: {
    try: {
      nodes: [
        {
          id: `${id}_send`,
          type: 'notify',
          label,
          config: { recipients: c(recipients), title, message, sourceObject: 'srm_quality_issue', sourceId: cel`issue.id` },
        },
      ],
    },
    // 没有可通知的人（整改单没有 SQE、没有应付会计）时不影响确认
    catch: { nodes: [{ id: `${id}_skip`, type: 'assignment', label: '跳过通知' }] },
  },
});

export const ClaimRespondFlow: Automation.Flow = {
  name: 'srm_claim_respond',
  label: '确认索赔',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '索赔确认已提交',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取整改单',
      config: { objectName: 'srm_quality_issue', filter: { id: cel`recordId` }, outputVariable: 'issue' },
    },
    {
      id: 'load_membership',
      type: 'get_record',
      label: '操作人是本公司在职联系人？',
      config: {
        objectName: 'srm_supplier_contact',
        filter: {
          supplier: cel`issue != null ? issue.supplier : ''`,
          portal_user: cel`current_user != null ? current_user.id : ''`,
          active: true,
        },
        fields: ['id'],
        outputVariable: 'membership',
      },
    },
    { id: 'gate', type: 'decision', label: '可以确认？' },
    {
      id: 'refuse_member',
      type: 'end',
      label: '不是本公司门户用户',
      config: { outcome: 'refused', message: '索赔由供应商在门户确认；线下确认的由 SQE 直接在整改单上记录索赔状态' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是已提出',
      config: { outcome: 'refused', message: '只有已提出、还没确认的索赔可以接受或提出异议' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认索赔',
      config: {
        title: '确认索赔：{{ issue.issue_no }}',
        description: '索赔金额 {{ issue.claim_amount }}。接受后由采购方财务在结算时扣款；有异议请写明理由，SQE 会与你联系。',
        fields: [
          {
            name: 'decision',
            label: '确认结果',
            type: 'select',
            required: true,
            options: [
              { label: '接受索赔', value: 'accept' },
              { label: '提出异议', value: 'dispute' },
            ],
          },
          { name: 'response_text', label: '意见', type: 'textarea', required: true, visibleWhen: "decision == 'dispute'" },
        ],
      },
    },
    {
      id: 'respond',
      type: 'update_record',
      label: '写入确认结果',
      config: {
        objectName: 'srm_quality_issue',
        filter: { id: cel`issue.id` },
        fields: {
          claim_status: c(`decision == 'accept' ? 'supplier_accepted' : 'disputed'`),
          claim_response: c(`has(vars.response_text) && vars.response_text != null ? vars.response_text : ''`),
        },
      },
    },
    { id: 'accepted', type: 'decision', label: '接受了？' },
    {
      id: 'load_accountants',
      type: 'get_record',
      label: '读取应付会计',
      config: { objectName: 'sys_user_position', filter: { position: 'srm_ap_accountant' }, limit: 50, outputVariable: 'accountants' },
    },
    notify(
      'notify_accepted',
      '通知 SQE 与应付会计：供应商已接受索赔',
      `(has(issue.sqe) && issue.sqe != null ? [issue.sqe] : []) + accountants.map(p, p.user_id)`,
      '整改单 {{ issue.issue_no }} 的索赔供应商已接受',
      '供应商已接受索赔（金额 {{ issue.claim_amount }}）。请财务在 ERP 结算时扣款，扣款后由应付会计在整改单上标记「已扣款」。',
    ),
    notify(
      'notify_disputed',
      '通知 SQE：供应商对索赔有异议',
      `has(issue.sqe) && issue.sqe != null ? issue.sqe : null`,
      '整改单 {{ issue.issue_no }} 的索赔供应商有异议',
      '供应商对索赔（金额 {{ issue.claim_amount }}）提出异议，意见见整改单。请与供应商协商，调整后可重新提出索赔。',
    ),
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'load_membership', type: 'default' },
    { id: 'e2', source: 'load_membership', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_member', type: 'conditional', condition: c(`!(${member})`), label: '不是本公司' },
    { id: 'e4', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${member} && !(${proposed})`), label: '不是已提出' },
    { id: 'e5', source: 'gate', target: 'confirm', type: 'conditional', condition: c(`${member} && ${proposed}`), label: '可以' },
    { id: 'e6', source: 'confirm', target: 'respond', type: 'default' },
    { id: 'e7', source: 'respond', target: 'accepted', type: 'default' },
    { id: 'e8', source: 'accepted', target: 'load_accountants', type: 'conditional', condition: c(`decision == 'accept'`), label: '接受' },
    { id: 'e9', source: 'accepted', target: 'notify_disputed', type: 'conditional', condition: c(`decision != 'accept'`), label: '异议' },
    { id: 'e10', source: 'load_accountants', target: 'notify_accepted', type: 'default' },
    { id: 'e11', source: 'notify_accepted', target: 'end', type: 'default' },
    { id: 'e12', source: 'notify_disputed', target: 'end', type: 'default' },
  ],
};
