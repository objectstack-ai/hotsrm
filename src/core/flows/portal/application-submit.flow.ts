import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 提交准入申请（03 §3 第 1 步，FR-202，v0.6）：受邀供应商开通门户、补齐资料后，在门户的公司资料上提交准入申请。
// 以系统身份运行：门户不授准入申请的新建权，也看不到品类表。系统身份读得到任何记录，而任何成员都能经 trigger 入口直接
// 启动系统身份的 screen flow（objectstack#25481），所以隔离只能靠 flow 自己查名册：调用者必须是页面这家供应商的在职联系人
// （与成员键 portal_supplier_ids 同一条件：portal_user = 调用者、active），否则直接结束；申请品类取门户邀请上品类经理填的品类，
// 来源记为「邀请」，申请回填到邀请。邀请要是发给调用者本人（联系人 = 调用者的名册行）、已开通、还没提交过申请的。之后受理照常由 srm_application_intake 处理（黑名单驳回、淘汰重新准入）。
const c = (source: string) => ({ dialect: 'cel' as const, source });
const portal = `current_user != null && membership != null`;
const invited = `invite != null && has(invite.categories) && invite.categories != null && size(invite.categories) > 0`;
const admissible = `vendor != null && (vendor.status == 'potential' || vendor.status == 'eliminated')`;

export const ApplicationSubmitFlow: Automation.Flow = {
  name: 'srm_application_submit',
  label: '提交准入申请',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '准入申请已提交，品类经理审核资料后会通知您',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load_membership',
      type: 'get_record',
      label: '调用者是这家供应商的门户用户？',
      config: {
        objectName: 'srm_supplier_contact',
        filter: { portal_user: c(`current_user != null ? current_user.id : ''`), supplier: cel`recordId`, active: true },
        outputVariable: 'membership',
      },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取本公司',
      config: { objectName: 'srm_supplier', filter: { id: c(`membership != null ? membership.supplier : ''`) }, outputVariable: 'vendor' },
    },
    {
      id: 'load_invitation',
      type: 'get_record',
      label: '读取待提交申请的邀请',
      config: {
        objectName: 'srm_supplier_invitation',
        filter: { contact: c(`membership != null ? membership.id : ''`), status: 'accepted', application: null },
        outputVariable: 'invite',
      },
    },
    { id: 'gate', type: 'decision', label: '可以提交？' },
    {
      id: 'refuse_portal',
      type: 'end',
      label: '不是门户用户',
      config: { outcome: 'refused', message: '准入申请由受邀供应商在门户提交；内部登记请在准入申请里新建' },
    },
    {
      id: 'refuse_invitation',
      type: 'end',
      label: '没有待提交的邀请',
      config: { outcome: 'refused', message: '没有待提交的准入邀请：申请已经提交，或邀请没有填申请品类' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '供应商状态不可申请',
      config: { outcome: 'refused', message: '贵公司当前状态不能提交准入申请，请联系对接的品类经理' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '确认提交',
      config: {
        title: '提交准入申请：{{ vendor.name }}',
        description: '申请品类按邀请填写。提交前请先补齐公司资料、资质证书与银行账户；提交后由品类经理审核资料。',
        waitForInput: true,
      },
    },
    {
      id: 'create',
      type: 'create_record',
      label: '新建准入申请',
      config: {
        objectName: 'srm_supplier_application',
        fields: { supplier: cel`vendor.id`, applied_categories: cel`invite.categories`, source: 'invited' },
        outputVariable: 'app',
      },
    },
    {
      id: 'backfill',
      type: 'update_record',
      label: '回填邀请',
      config: { objectName: 'srm_supplier_invitation', filter: { id: cel`invite.id` }, fields: { application: cel`app.id` } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load_membership', type: 'default' },
    { id: 'e1', source: 'load_membership', target: 'load_supplier', type: 'default' },
    { id: 'e2', source: 'load_supplier', target: 'load_invitation', type: 'default' },
    { id: 'e3', source: 'load_invitation', target: 'gate', type: 'default' },
    { id: 'e_portal', source: 'gate', target: 'refuse_portal', type: 'conditional', condition: c(`!(${portal})`), label: '不是门户用户' },
    { id: 'e_invite', source: 'gate', target: 'refuse_invitation', type: 'conditional', condition: c(`${portal} && !(${invited})`), label: '没有邀请' },
    {
      id: 'e_status',
      source: 'gate',
      target: 'refuse_status',
      type: 'conditional',
      condition: c(`${portal} && ${invited} && !(${admissible})`),
      label: '状态不可申请',
    },
    { id: 'e_ok', source: 'gate', target: 'confirm', type: 'conditional', condition: c(`${portal} && ${invited} && ${admissible}`), label: '可以' },
    { id: 'e4', source: 'confirm', target: 'create', type: 'default' },
    { id: 'e5', source: 'create', target: 'backfill', type: 'default' },
    { id: 'e6', source: 'backfill', target: 'end', type: 'default' },
  ],
};
