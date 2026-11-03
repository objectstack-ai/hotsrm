import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 门户「补充完成，重新提交」（03 §3 第 4 步，04 §3.2，v0.6）：品类经理把准入申请「退回补充」后，供应商在门户补齐资料、
// 证书和银行账户（这些都在供应商档案下，门户可以直接维护），再在申请上写明补了什么、重新提交：申请回到「资料审核」，
// 通知初审人（还没指定时通知退回申请的人）。申请本身的品类、初审人等由内部维护，门户不直接改。
//
// 以系统身份运行：门户对准入申请只有读共享（ADR-0010 两把锁）。flow 进门判断启动人持门户岗位、并且是这张申请所属供应商
// 在职联系人上登记的门户账号（与成员键同一份名册），伪造别家申请的 recordId 时名册对不上，直接结束。18.3.0 起启动入口先以启动人身份读 recordId（objectstack#29050），别家的申请到不了这里，名册检查保留作第二道防线；
// 谁可以启动见 objectstack#25481。
const uid = `current_user != null ? current_user.id : ''`;
const allowed = `current_user != null && 'srm_portal_user' in current_user.positions && application != null && membership != null`;
const returned = `application.status == 'returned'`;
const c = (source: string) => ({ dialect: 'cel' as const, source });

export const ApplicationResubmitFlow: Automation.Flow = {
  name: 'srm_application_resubmit',
  label: '补充完成，重新提交',
  type: 'screen',
  status: 'active',
  runAs: 'system',
  successMessage: '已重新提交，等待资料审核',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取准入申请',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`recordId` }, outputVariable: 'application' },
    },
    {
      id: 'load_membership',
      type: 'get_record',
      label: '启动人是这家供应商的门户账号？',
      config: {
        objectName: 'srm_supplier_contact',
        filter: { supplier: c(`application != null ? application.supplier : ''`), portal_user: c(uid), active: true },
        outputVariable: 'membership',
      },
    },
    { id: 'gate', type: 'decision', label: '可以重新提交？' },
    {
      id: 'refuse_position',
      type: 'end',
      label: '不是本公司门户用户',
      config: { outcome: 'refused', message: '只有申请所属供应商的门户用户可以重新提交准入申请' },
    },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是退回补充',
      config: { outcome: 'refused', message: '只有「退回补充」的准入申请需要重新提交' },
    },
    {
      id: 'confirm',
      type: 'screen',
      label: '说明补充内容',
      config: {
        title: '重新提交准入申请：{{ application.application_no }}',
        description: '请先在「公司资料」里补齐资料、证书和银行账户，再写明补充了哪些内容，提交后回到资料审核。',
        fields: [{ name: 'note', label: '补充说明', type: 'textarea', required: true }],
      },
    },
    {
      id: 'resubmit',
      type: 'update_record',
      label: '回到资料审核',
      config: {
        objectName: 'srm_supplier_application',
        filter: { id: cel`application.id` },
        fields: { status: 'doc_review', supplement_note: cel`note` },
      },
    },
    {
      id: 'notify_guard',
      type: 'try_catch',
      label: '通知',
      config: {
        try: {
          nodes: [
            {
              id: 'notify_reviewer',
              type: 'notify',
              // 没有初审人时通知退回它的人：申请停在「退回补充」，最后一次改它的就是退回的品类经理。门户提交的申请
              // 新建人是门户用户本人（系统身份代建），不能退回到新建人
              label: '通知初审人（没有初审人时通知退回申请的人）',
              config: {
                recipients: c(
                  `has(application.reviewer) && application.reviewer != null ? [application.reviewer]`
                  + ` : has(application.updated_by) && application.updated_by != null ? [application.updated_by] : [application.created_by]`,
                ),
                title: '准入申请 {{ application.application_no }} 已补充，待资料审核',
                message: '供应商在门户补充了资料并重新提交，补充说明：{{ note }}',
                severity: 'info',
                sourceObject: 'srm_supplier_application',
                sourceId: cel`application.id`,
              },
            },
          ],
        },
        catch: { nodes: [{ id: 'skip_notify', type: 'assignment', label: '跳过通知' }] },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'load_membership', type: 'default' },
    { id: 'e2', source: 'load_membership', target: 'gate', type: 'default' },
    { id: 'e3', source: 'gate', target: 'refuse_position', type: 'conditional', condition: c(`!(${allowed})`), label: '不可以' },
    { id: 'e4', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`${allowed} && !(${returned})`), label: '不是退回补充' },
    { id: 'e5', source: 'gate', target: 'confirm', type: 'conditional', condition: c(`${allowed} && ${returned}`), label: '可以' },
    { id: 'e6', source: 'confirm', target: 'resubmit', type: 'default' },
    { id: 'e7', source: 'resubmit', target: 'notify_guard', type: 'default' },
    { id: 'e8', source: 'notify_guard', target: 'end', type: 'default' },
  ],
};
