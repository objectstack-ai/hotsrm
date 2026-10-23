import { composeStacks } from '@objectstack/spec';
import { stacks } from './objectstack.composition.js';

// 把选中的模块合成一个发布制品（ADR-0002）；`preserve` 保留每个包各自的身份。
export default composeStacks(stacks, { manifest: 'preserve' });
