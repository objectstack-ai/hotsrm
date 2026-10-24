import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 执行供应商处置（02 §5.1，03 §5）：审批全部通过后由 srm_disposition_approval 调用，以系统身份改供应商
// 状态和品类资格，处置单置为「已执行」。
// - 冻结：全部品类时供应商→冻结；全部（或所选）未暂停的品类资格→暂停，记下暂停前的状态和冻结范围；
// - 解冻：只恢复同一范围冻结的资格（全部解冻恢复「全部品类」冻结的，指定品类解冻恢复所选品类中
//   「指定品类」冻结的），原本就暂停的资格不动；全部品类时供应商→合格；
// - 淘汰 / 拉入黑名单：供应商→淘汰 / 黑名单，品类资格全部暂停并清掉冻结记录，重新准入时按申请品类恢复；
// - 解除黑名单：供应商→淘汰，之后只能重新走准入（FR-208）。

const setSupplier = (id: string, label: string, status: string) => ({
  id,
  type: 'update_record' as const,
  label,
  config: { objectName: 'srm_supplier', filter: { id: cel`disp.supplier` }, fields: { status } },
});

// 指定品类时只动所选品类的资格
const inScope = (scope: 'all' | 'category') =>
  scope === 'category' ? { category: { $in: cel`disp.categories` } } : {};

const freeze = (id: string, scope: 'all' | 'category', from: 'qualified' | 'trial') => ({
  id,
  type: 'update_record' as const,
  label: `暂停${from === 'qualified' ? '合格' : '试供'}的品类资格`,
  config: {
    objectName: 'srm_supplier_category',
    filter: { supplier: cel`disp.supplier`, status: from, ...inScope(scope) },
    multi: true,
    fields: { status: 'suspended', status_before_freeze: from, freeze_scope: scope, freeze_disposition: cel`disp.id` },
  },
});

const unfreeze = (id: string, scope: 'all' | 'category', to: 'qualified' | 'trial') => ({
  id,
  type: 'update_record' as const,
  label: `恢复冻结前${to === 'qualified' ? '合格' : '试供'}的品类资格`,
  config: {
    objectName: 'srm_supplier_category',
    filter: { supplier: cel`disp.supplier`, status: 'suspended', status_before_freeze: to, freeze_scope: scope, ...inScope(scope) },
    multi: true,
    fields: { status: to, status_before_freeze: null, freeze_scope: null, freeze_disposition: null },
  },
});

const suspendAll = (id: string) => ({
  id,
  type: 'update_record' as const,
  label: '暂停全部品类资格',
  config: {
    objectName: 'srm_supplier_category',
    filter: { supplier: cel`disp.supplier` },
    multi: true,
    fields: { status: 'suspended', status_before_freeze: null, freeze_scope: null, freeze_disposition: null },
  },
});

export const DispositionApplyFlow: Automation.Flow = {
  name: 'srm_disposition_apply',
  label: '执行供应商处置',
  type: 'autolaunched',
  status: 'active',
  runAs: 'system',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取处置单',
      config: { objectName: 'srm_supplier_disposition', filter: { id: cel`recordId` }, outputVariable: 'disp' },
    },
    { id: 'by_action', type: 'decision', label: '按处置动作执行' },

    // 冻结
    setSupplier('freeze_supplier', '供应商冻结', 'frozen'),
    freeze('freeze_all_qualified', 'all', 'qualified'),
    freeze('freeze_all_trial', 'all', 'trial'),
    freeze('freeze_some_qualified', 'category', 'qualified'),
    freeze('freeze_some_trial', 'category', 'trial'),

    // 解冻
    setSupplier('unfreeze_supplier', '供应商恢复合格', 'qualified'),
    unfreeze('unfreeze_all_qualified', 'all', 'qualified'),
    unfreeze('unfreeze_all_trial', 'all', 'trial'),
    unfreeze('unfreeze_some_qualified', 'category', 'qualified'),
    unfreeze('unfreeze_some_trial', 'category', 'trial'),

    // 淘汰 / 黑名单 / 解除黑名单
    setSupplier('eliminate_supplier', '供应商淘汰', 'eliminated'),
    setSupplier('blacklist_supplier', '供应商拉入黑名单', 'blacklisted'),
    suspendAll('suspend_all'),
    setSupplier('remove_blacklist_supplier', '解除黑名单（转为淘汰）', 'eliminated'),

    {
      id: 'done',
      type: 'update_record',
      label: '处置单已执行',
      config: {
        objectName: 'srm_supplier_disposition',
        filter: { id: cel`disp.id` },
        fields: { status: 'applied', applied_at: cel`isoDatetime(now())` },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'by_action', type: 'default' },

    {
      id: 'e_freeze_all',
      source: 'by_action',
      target: 'freeze_supplier',
      type: 'conditional',
      condition: P`disp.action == 'freeze' && disp.scope == 'all'`,
      label: '冻结全部品类',
    },
    { id: 'e_fa1', source: 'freeze_supplier', target: 'freeze_all_qualified', type: 'default' },
    { id: 'e_fa2', source: 'freeze_all_qualified', target: 'freeze_all_trial', type: 'default' },
    { id: 'e_fa3', source: 'freeze_all_trial', target: 'done', type: 'default' },
    {
      id: 'e_freeze_some',
      source: 'by_action',
      target: 'freeze_some_qualified',
      type: 'conditional',
      condition: P`disp.action == 'freeze' && disp.scope == 'category'`,
      label: '冻结指定品类',
    },
    { id: 'e_fs1', source: 'freeze_some_qualified', target: 'freeze_some_trial', type: 'default' },
    { id: 'e_fs2', source: 'freeze_some_trial', target: 'done', type: 'default' },

    {
      id: 'e_unfreeze_all',
      source: 'by_action',
      target: 'unfreeze_supplier',
      type: 'conditional',
      condition: P`disp.action == 'unfreeze' && disp.scope == 'all'`,
      label: '全部解冻',
    },
    { id: 'e_ua1', source: 'unfreeze_supplier', target: 'unfreeze_all_qualified', type: 'default' },
    { id: 'e_ua2', source: 'unfreeze_all_qualified', target: 'unfreeze_all_trial', type: 'default' },
    { id: 'e_ua3', source: 'unfreeze_all_trial', target: 'done', type: 'default' },
    {
      id: 'e_unfreeze_some',
      source: 'by_action',
      target: 'unfreeze_some_qualified',
      type: 'conditional',
      condition: P`disp.action == 'unfreeze' && disp.scope == 'category'`,
      label: '解冻指定品类',
    },
    { id: 'e_us1', source: 'unfreeze_some_qualified', target: 'unfreeze_some_trial', type: 'default' },
    { id: 'e_us2', source: 'unfreeze_some_trial', target: 'done', type: 'default' },

    { id: 'e_eliminate', source: 'by_action', target: 'eliminate_supplier', type: 'conditional', condition: P`disp.action == 'eliminate'`, label: '淘汰' },
    { id: 'e_el1', source: 'eliminate_supplier', target: 'suspend_all', type: 'default' },
    { id: 'e_blacklist', source: 'by_action', target: 'blacklist_supplier', type: 'conditional', condition: P`disp.action == 'blacklist'`, label: '拉入黑名单' },
    { id: 'e_bl1', source: 'blacklist_supplier', target: 'suspend_all', type: 'default' },
    { id: 'e_suspended', source: 'suspend_all', target: 'done', type: 'default' },
    {
      id: 'e_remove_blacklist',
      source: 'by_action',
      target: 'remove_blacklist_supplier',
      type: 'conditional',
      condition: P`disp.action == 'remove_blacklist'`,
      label: '解除黑名单',
    },
    { id: 'e_rb1', source: 'remove_blacklist_supplier', target: 'done', type: 'default' },

    { id: 'e_done', source: 'done', target: 'end', type: 'default' },
  ],
};
