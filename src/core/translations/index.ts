import { defineTranslationBundle } from '@objectstack/spec/system';
import { en } from './en.js';

// 源语言（zh-CN）就是源码里的中文标签和帮助文字，翻译包只放英文
export const SrmTranslations = defineTranslationBundle({ en });
