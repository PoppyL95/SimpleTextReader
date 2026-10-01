/** Questionnaire values are shared by the card, archive, import and API validation. */
export const REVIEW_FIELDS = [
    { key: 'characters', label: '角色', type: 'text' },
    { key: 'rating', label: '阅读进度及评价', type: 'single', options: ['值得多刷', '可圈可点', '文荒可看', '看不下去', '踩我雷点 滚'] },
    { key: 'perspective', label: '性向视角', type: 'single', options: ['女主', '男主', '主受', '主攻', '双视角'] },
    { key: 'relationship', label: '情感关系', type: 'single', options: ['1v1', 'np', '无cp'] },
    { key: 'background', label: '时代背景', type: 'single', options: ['现代', '古代', '未来', '民国', '架空(衍生)', '其他'] },
    { key: 'modern', label: '现代', type: 'multi', when: '现代', options: ['娱乐圈', '网红', '豪门', '职场', '校园', '电竞', '竞体', '键盘网游', '穿越（互换身体、古穿今等）', '现代西方', '其他'] },
    { key: 'ancient', label: '古代', type: 'multi', when: '古代', options: ['架空王朝', '修仙', '武侠江湖', '古代西方', '其他', '朝堂权谋'] },
    { key: 'future', label: '未来', type: 'multi', when: '未来', options: ['末世', '无限流', 'ABO', '哨向', '星际', '全息网游', '其他'] },
    { key: 'fanfiction', label: '同人', type: 'multi', when: '架空(衍生)', options: ['其他综漫', '其他游戏', '英美剧', '西方名著', '其他'] },
    { key: 'style', label: '故事风格', type: 'multi', options: ['论坛体', '小甜饼', '暗恋酸涩', '直男受', '年龄差（年下/年上）', '背德：骨科、小妈、第三者等', '追妻火葬场', '青梅竹马', '天降', '豪车我大吃特吃', '人外、双性等', '心理疾病、失忆', '替身/白月光', '其他'] },
    { key: 'extraTags', label: '补充标签', type: 'text' },
    { key: 'platform', label: '平台', type: 'single', options: ['晋江', '长佩', '废文', '番茄', '其他'] },
    { key: 'completed', label: '是否看完', type: 'single', options: ['已看完', '未看完'] },
];

export function emptyReviewFields() {
    return Object.fromEntries(REVIEW_FIELDS.map(field => [field.key, field.type === 'multi' ? [] : '']));
}
export function reviewTags(fields) {
    const tags = REVIEW_FIELDS.flatMap(field => field.options ? (Array.isArray(fields[field.key]) ? fields[field.key] : [fields[field.key]]) : []);
    return [...new Set([...tags, ...(fields.extraTags || '').split(/[\s,，]+/u)].filter(Boolean))];
}

/** Charge only the visible portion of an interval before the two-minute idle cutoff. */
export function activeReadingMs(previousTick, now, lastInteraction, visible) {
    if (!visible || !lastInteraction || now <= previousTick) return 0;
    return Math.max(0, Math.min(now, lastInteraction + 120000) - Math.max(previousTick, lastInteraction));
}
