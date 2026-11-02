import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

const expire = (key: string): Automation.FlowNode => ({
  id: `expire_${key}`,
  type: 'update_record',
  label: '置为已到期',
  config: { objectName: 'srm_contract', filter: { id: cel`contract.id` }, fields: { status: 'expired' } },
});

// P4 到期（03 §6 第 6 步）：每日追赶式扫描，end_date 已过而仍为「生效」的合同置为「已到期」；
// 设置了自动续签的，先置为已到期，再经 srm_contract_renew 生成续签草稿。只处理仍为「生效」的合同，
// 重复运行不重复处理、不重复续签（03 §2.3 R2）。每份合同单独处理，失败只跳过该份；续签失败
// （多为供应商已不合格）时通知所有者，原合同照样到期。
export const ContractExpireSweepFlow: Automation.Flow = {
  name: 'srm_contract_expire_sweep',
  label: '合同到期扫描',
  type: 'schedule',
  status: 'active',
  runAs: 'system',

  nodes: [
    { id: 'start', type: 'start', label: '每日 01:10', config: { schedule: '10 1 * * *' } },
    {
      id: 'find_renew',
      type: 'get_record',
      label: '已到期、要续签',
      config: {
        objectName: 'srm_contract',
        filter: { status: 'active', auto_renew: true, end_date: { $lt: cel`isoDate(today())` } },
        limit: 500,
        outputVariable: 'renewList',
      },
    },
    {
      id: 'each_renew',
      type: 'loop',
      label: '逐份到期并续签',
      config: {
        collection: cel`renewList`,
        iteratorVariable: 'contract',
        body: {
          nodes: [
            {
              id: 'guard_renew',
              type: 'try_catch',
              label: '单份合同',
              config: {
                try: {
                  nodes: [
                    expire('renew'),
                    {
                      id: 'renew_guard',
                      type: 'try_catch',
                      label: '续签',
                      config: {
                        try: {
                          nodes: [
                            {
                              id: 'renew',
                              type: 'subflow',
                              label: '生成续签草稿',
                              config: { flowName: 'srm_contract_renew', input: { recordId: cel`contract.id` } },
                            },
                          ],
                        },
                        catch: {
                          nodes: [
                            {
                              id: 'renew_failed',
                              type: 'notify',
                              label: '通知所有者：续签未生成',
                              config: {
                                recipients: cel`has(contract.owner_id) && contract.owner_id != null ? contract.owner_id : contract.created_by`,
                                title: '合同 {{ contract.contract_no }} 已到期，续签草稿未能生成',
                                message: '「{{ contract.title }}」设置了自动续签，但续签草稿未能生成（常见原因：供应商已不是「合格」状态）。如需续签请手工新建。',
                                severity: 'warning',
                                sourceObject: 'srm_contract',
                                sourceId: cel`contract.id`,
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                  edges: [{ id: 'e_expire_renew', source: 'expire_renew', target: 'renew_guard', type: 'default' }],
                },
                catch: { nodes: [{ id: 'skip_renew', type: 'assignment', label: '跳过该份' }] },
              },
            },
          ],
        },
      },
    },
    {
      id: 'find_expired',
      type: 'get_record',
      label: '已到期、未标记',
      config: {
        objectName: 'srm_contract',
        filter: { status: 'active', end_date: { $lt: cel`isoDate(today())` } },
        limit: 500,
        outputVariable: 'expiredList',
      },
    },
    {
      id: 'each_expired',
      type: 'loop',
      label: '逐份置为已到期',
      config: {
        collection: cel`expiredList`,
        iteratorVariable: 'contract',
        body: {
          nodes: [
            {
              id: 'guard_expired',
              type: 'try_catch',
              label: '单份合同',
              config: {
                try: { nodes: [expire('expired')] },
                catch: { nodes: [{ id: 'skip_expired', type: 'assignment', label: '跳过该份' }] },
              },
            },
          ],
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'find_renew', type: 'default' },
    { id: 'e2', source: 'find_renew', target: 'each_renew', type: 'default' },
    { id: 'e3', source: 'each_renew', target: 'find_expired', type: 'default' },
    { id: 'e4', source: 'find_expired', target: 'each_expired', type: 'default' },
    { id: 'e5', source: 'each_expired', target: 'end', type: 'default' },
  ],
};
