/**
 * 「可核验性」区块里三句对外承诺的文案。
 *
 * 为什么要把它们从 JSX 里搬出来：这三句说的是「别人拿到文件能验什么」，而原来的写法
 * 超过了文件真实的证明力（对照 docs/manifest.md 的「两类哈希」与「代价要说清楚」两节）：
 *
 * 1. 「只包含哈希」不成立——manifest 的 acceptance[].item 是清单条目原文（例如 contains
 *    项的 value、manual 项的 note，见 src/server/services/commands/tasks/manifest.ts 的
 *    readChecklist），验收契约更是整份文字（title、criteria、每条的 statement，见
 *    src/lib/domain/acceptance-export.ts）。真正只以哈希出现的是提示词：steps 存的是
 *    inputHash/outputHash。
 * 2. 「对方不需要登录这套系统也能重算一遍」容易读成能重算步骤内容——步骤与产物的原文
 *    不在文件里，离线能重算的只有 digest 与 merkle 根，也就是哈希之间的对应关系。
 * 3. 「重算 digest 与 merkle 根，就能判断它有没有被改过」只对「导出之后被改了」成立。
 *    digest 是文件自述的摘要：改内容的人把 digest 一起重算，文件依然自洽
 *    （src/lib/domain/manifest.ts 的 manifestDigest 只覆盖文件自身）。要证明「这份文件
 *    出自本系统」必须让 auditHead 对上审计链，而那需要对方的链路数据。
 *
 * 三句都只改说法，不改导出的字段：改字段会变 digest，等于让所有已导出的文件失效。
 */

export const EXPORT_CONTENT_NOTE =
  "导出的 manifest 里只有步骤与产物的哈希，但验收逐条判定带的是清单条目原文；验收契约整份都是文字（标题、你写的验收标准、每条的表述）。两者共同的一点是：都不含你的提示词原文——提示词只以哈希出现。";

export const OFFLINE_CHECK_NOTE =
  "离线可自洽校验：文件里带着每一步的输入/输出哈希、产物哈希、验收逐条判定和审计头位置，对方不用登录这套系统就能重算 digest 与 merkle 根，确认这份 JSON 内部一致。步骤与产物的原文不在文件里，所以能重算的是哈希之间的对应关系，不是内容本身。";

export const DIGEST_PROOF_NOTE =
  "对方重算 digest 与 merkle 根，能确认文件在导出之后没有再被改动；但如果改内容的人把 digest 一起重算，单靠文件本身是验不出来的——它证明的是自洽，不是这份文件出自本系统。审计头是否接得上需要对方的链路数据，对上了才说明这份文件是链上那一次运行产出的。";
