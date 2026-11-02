import { cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// 生成续签草稿（03 §6 第 6 步）：到期扫描对 auto_renew 的合同调用。复制合同与明细，新合同期限紧接原合同、
// 长度相同，状态为草稿，所有者不变，renewed_from 指回原合同；续签合同照常走提交、审批、签署。
// 供应商已不合格时，新建被校验规则 supplier_qualified 拒绝，由扫描通知所有者。
const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
const keep = (v: string, k: string) => cel$(`has(${v}.${k}) ? ${v}.${k} : null`);
const contractKeys = ['contract_type', 'supplier', 'category', 'legal_entity', 'amount', 'currency', 'legal_reviewer'];
const lineKeys = ['line_no', 'material', 'description', 'quantity', 'uom', 'unit_price', 'tax_rate'];

export const ContractRenewFlow: Automation.Flow = {
  name: 'srm_contract_renew',
  label: '生成续签草稿',
  type: 'autolaunched',
  status: 'active',
  runAs: 'system',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load',
      type: 'get_record',
      label: '读取原合同',
      config: { objectName: 'srm_contract', filter: { id: cel`recordId` }, outputVariable: 'old' },
    },
    {
      id: 'create',
      type: 'create_record',
      label: '建续签草稿',
      config: {
        objectName: 'srm_contract',
        fields: {
          title: cel`old.title + '（续签）'`,
          ...Object.fromEntries(contractKeys.map((k) => [k, keep('old', k)])),
          start_date: cel`isoDate(addDays(old.end_date, 1))`,
          end_date: cel`isoDate(addDays(old.end_date, daysBetween(old.start_date, old.end_date) + 1))`,
          auto_renew: true,
          status: 'draft',
          renewed_from: cel`old.id`,
          owner_id: keep('old', 'owner_id'),
        },
        outputVariable: 'renewal',
      },
    },
    {
      id: 'load_lines',
      type: 'get_record',
      label: '读取原合同明细',
      config: { objectName: 'srm_contract_line', filter: { contract: cel`old.id` }, limit: 500, outputVariable: 'lines' },
    },
    {
      id: 'copy_lines',
      type: 'loop',
      label: '逐行复制明细',
      config: {
        collection: cel`lines`,
        iteratorVariable: 'line',
        body: {
          nodes: [
            {
              // 一行复制失败只跳过该行；通知里请所有者核对明细
              id: 'guard_line',
              type: 'try_catch',
              label: '单行明细',
              config: {
                try: {
                  nodes: [
                    {
                      id: 'copy_line',
                      type: 'create_record',
                      label: '复制一行',
                      config: {
                        objectName: 'srm_contract_line',
                        fields: {
                          contract: cel`renewal.id`,
                          ...Object.fromEntries(lineKeys.map((k) => [k, keep('line', k)])),
                        },
                      },
                    },
                  ],
                },
                catch: { nodes: [{ id: 'skip_line', type: 'assignment', label: '跳过该行' }] },
              },
            },
          ],
        },
      },
    },
    {
      id: 'notify',
      type: 'notify',
      label: '通知所有者',
      config: {
        recipients: cel`has(old.owner_id) && old.owner_id != null ? old.owner_id : old.created_by`,
        title: '合同 {{ old.contract_no }} 已到期，已生成续签草稿',
        message: '「{{ old.title }}」设置了到期自动续签，续签草稿已生成，请核对金额与明细后提交审批。',
        sourceObject: 'srm_contract',
        sourceId: cel`renewal.id`,
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load', type: 'default' },
    { id: 'e1', source: 'load', target: 'create', type: 'default' },
    { id: 'e2', source: 'create', target: 'load_lines', type: 'default' },
    { id: 'e3', source: 'load_lines', target: 'copy_lines', type: 'default' },
    { id: 'e4', source: 'copy_lines', target: 'notify', type: 'default' },
    { id: 'e5', source: 'notify', target: 'end', type: 'default' },
  ],
};
