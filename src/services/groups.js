import { HttpError } from '../lib/http.js';

const NAME_MAX = 40;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** 分组（项目）：给短链按用途归堆，删除分组不删链，只把链放回未分组 */
export class GroupService {
  constructor({ store, logger = console }) {
    this.store = store;
    this.logger = logger;
  }

  normalizeName(input) {
    const name = String(input ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new HttpError(400, '请填写分组名称', 'group_name_required');
    if (name.length > NAME_MAX) throw new HttpError(400, `分组名称最多 ${NAME_MAX} 个字符`, 'group_name_too_long');
    return name;
  }

  normalizeColor(input) {
    const color = String(input ?? '').trim();
    if (!color) return '';
    if (!COLOR_RE.test(color)) throw new HttpError(400, '颜色需为 #RRGGBB 格式', 'group_color_invalid');
    return color.toLowerCase();
  }

  list() {
    return {
      items: this.store.listGroupsWithCounts(),
      ungrouped: this.store.countUngrouped(),
    };
  }

  /** 支持按 id 或名称解析，前端两种都方便 */
  resolve(ref) {
    if (ref === undefined || ref === null || ref === '' || ref === 0 || ref === '0' || ref === 'none') return null;
    const id = Number(ref);
    const row = Number.isInteger(id) && id > 0 ? this.store.sql.getGroupById.get(id) : this.store.sql.getGroupByName.get(String(ref).trim());
    if (!row) throw new HttpError(404, `分组「${ref}」不存在`, 'group_not_found');
    return row;
  }

  create(input, { actor = 'admin' } = {}) {
    const name = this.normalizeName(input.name);
    const color = this.normalizeColor(input.color);
    const note = String(input.note ?? '').slice(0, 200);
    if (this.store.sql.getGroupByName.get(name)) throw new HttpError(409, `分组「${name}」已存在`, 'group_exists');
    const ts = Date.now();
    this.store.sql.insertGroup.run(name, color, note, ts, ts);
    const row = this.store.sql.getGroupByName.get(name);
    this.audit(actor, 'group.create', name);
    return row;
  }

  update(id, patch, { actor = 'admin' } = {}) {
    const group = this.store.sql.getGroupById.get(Number(id));
    if (!group) throw new HttpError(404, '分组不存在', 'group_not_found');
    const name = patch.name !== undefined ? this.normalizeName(patch.name) : group.name;
    const color = patch.color !== undefined ? this.normalizeColor(patch.color) : group.color;
    const note = patch.note !== undefined ? String(patch.note).slice(0, 200) : group.note;
    const same = this.store.sql.getGroupByName.get(name);
    if (same && same.id !== group.id) throw new HttpError(409, `分组「${name}」已存在`, 'group_exists');
    this.store.sql.updateGroup.run(name, color, note, Date.now(), group.id);
    this.audit(actor, 'group.update', name);
    return this.store.sql.getGroupById.get(group.id);
  }

  /** 删除分组：链保留，group_id 置空，避免误删数据 */
  remove(id, { actor = 'admin' } = {}) {
    const group = this.store.sql.getGroupById.get(Number(id));
    if (!group) throw new HttpError(404, '分组不存在', 'group_not_found');
    let freed = 0;
    this.store.tx(() => {
      freed = this.store.db.prepare('SELECT COUNT(*) AS n FROM links WHERE group_id = ?').get(group.id).n;
      this.store.sql.clearGroupRefs.run(group.id);
      this.store.sql.deleteGroup.run(group.id);
    });
    this.audit(actor, 'group.delete', `${group.name}:${freed}`);
    return { id: group.id, name: group.name, ungrouped: freed };
  }

  audit(actor, action, detail) {
    try {
      this.store.sql.insertAudit.run(Date.now(), actor, action, detail);
    } catch {
      /* 审计失败不影响主流程 */
    }
  }
}
