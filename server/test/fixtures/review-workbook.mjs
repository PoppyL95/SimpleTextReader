import writeExcelFile from 'write-excel-file/node';
import { REVIEW_FIELDS } from '../../../shared/core/reader/review-fields.js';

// Exact Tencent questionnaire export headers; all record values below are invented.
export const TENCENT_HEADERS = ['提交时间（自动）', '书名（必填）', '作者（必填）', '角色（必填）',
    '阅读进度及评价（必填）', '性向视角（必填）', '情感关系（必填）', '时代背景（必填）',
    '现代（必填）', '古代（必填）', '未来（必填）', '同人（必填）', '故事风格（必填）',
    '补充标签', '平台（必填）', '是否看完（必填）', '提交者（自动）'];

/** Only invented records. The date cell exercises Excel's typed date format. */
export async function sampleWorkbook({ headers = TENCENT_HEADERS, extraColumns = false } = {}) {
    headers = [...headers, ...(extraColumns ? ['感想', '保留测试列'] : [])];
    const first = { title: '测试书', author: '测试作者', characters: '虚构主角', rating: '值得多刷', perspective: '女主',
        relationship: '1v1', background: '古代', ancient: '修仙, 武侠江湖', style: '小甜饼, 年龄差（年下/年上）',
        extraTags: '测试 标签, 甲', platform: '晋江', completed: '已看完' };
    const second = { title: '未上传书', author: '原作者', rating: '自定义评价', perspective: '双视角',
        relationship: '无cp', background: '未来', future: '星际, 未知未来选项', style: '论坛体, 自定义风格', platform: '其他', completed: '未看完' };
    const row = (record, timestamp, reflection = '') => [timestamp, record.title, record.author,
        ...REVIEW_FIELDS.map(field => record[field.key] || ''), '虚构提交者',
        ...(extraColumns ? [reflection, '  原始空白也要保留  '] : [])];
    const data = [headers, row(first, { value: new Date('2026-09-30T12:30:00Z'), format: 'yyyy-mm-dd hh:mm:ss' }, '导入的感想'),
        row(second, '2026-10-01 13:30:00'), row({ ...first, title: '错误行', author: '' }, '错误日期'),
        row(first, '2026-09-30T12:30:00Z', '重复导入不能覆盖原感想')];
    return writeExcelFile(data).toBuffer();
}
