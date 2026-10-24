import { defineTranslationBundle } from '@objectstack/spec/system';
import { KpiHelp } from '../objects/kpi.object.js';
import { en } from './en.js';

// zh-CN 只补源语言里检查认不到的帮助文字（见 kpi.object.ts 的 KpiHelp），标签等仍以源码中文为准
export const SrmTranslations = defineTranslationBundle({
  en,
  'zh-CN': {
    objects: {
      srm_kpi: {
        fields: {
          full_score_value: { help: KpiHelp.full_score_value },
          zero_score_value: { help: KpiHelp.zero_score_value },
        },
      },
    },
  },
});
