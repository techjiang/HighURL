import fs from 'node:fs';
import path from 'node:path';
import { todayKey } from '../lib/util.js';
import { buildBackup, KEEP_AUTO_BACKUPS } from './backup.js';

/** 后台维护：把内存计数刷盘、清理过期数据、生成每日备份 */
export function startMaintenance(ctx) {
  const { store, counter, uaFilter, settings, logger, config } = ctx;
  let lastBackupDay = '';
  // 巡检按「距上次跑了多久」判断，而不是攒到下一个 30s 心跳——
  // 间隔可能是几小时，用墙钟时间算才不会漏跑也不会重复跑
  let lastHealthAt = 0;
  let healthBusy = false;
  // 到期提醒按天推一次就够。挂在 30s 心跳上不设闸，等于每半分钟提醒一遍同一件事
  let lastExpireDay = '';
  // 静默期结束要补发。挂在 30s 心跳上没问题：releaseHeld 没东西可放时立刻返回，
  // 而且它自己会看「现在是否仍在静默期」，改时段后也不会提前放出来
  let quietBusy = false;
  // 摘要推送同一分钟内可能被心跳撞两次，用忙碌位挡一下；
  // 真正的幂等靠投递记录里那条 subject 槽位
  let digestBusy = false;

  const tick = async () => {
    try {
      await counter.flush();
      uaFilter.flushHits();
      maybeBackup();
      sweepExpired();
      purgeTrash();
      cleanup();
      maybeHealthCheck();
      maybeNotifyExpiring();
      releaseQuiet();
      pushDigest();
    } catch (err) {
      logger.error('[maintenance]', err);
    }
  };

  const timer = setInterval(tick, 30000);
  timer.unref?.();

  // 进程退出前落盘
  const flushAll = () => {
    try {
      counter.flush();
      uaFilter.flushHits();
    } catch {
      /* ignore */
    }
  };

  /**
   * 过期短链回收：按策略自动停用或删除。
   * 宽限期从 expire_at 起算，避免刚过期就被清掉、管理员来不及延长。
   */
  function sweepExpired() {
    const policy = String(settings.get('expiredPolicy') || 'none');
    if (policy === 'none') return { archived: 0, removed: 0 };
    const grace = Math.max(0, Number(settings.get('expiredGraceDays')) || 0);
    const cutoff = Date.now() - grace * 86400000;
    const rows = store.db
      .prepare("SELECT id, code FROM links WHERE expire_at IS NOT NULL AND expire_at < ? AND status = 'active' AND deleted_at IS NULL")
      .all(cutoff);
    if (!rows.length) return { archived: 0, removed: 0 };

    let archived = 0;
    let removed = 0;
    store.tx(() => {
      for (const row of rows) {
        if (policy === 'delete') {
          store.sql.deleteLinkById.run(row.id);
          store.purgeLinkData(row.code);
          removed += 1;
        } else {
          // 停用前把原状态记下来：续期时才知道该恢复成启用还是保持停用。
          // 不记这一笔，续期就只能一律改回 active——那等于替管理员
          // 把他自己关掉的链接又打开了
          store.db
            .prepare("UPDATE links SET status = 'disabled', status_before_expire = ?, updated_at = ? WHERE id = ?")
            .run('active', Date.now(), row.id);
          archived += 1;
        }
      }
    });
    ctx.cache?.invalidate();
    const detail = `${policy}:${archived + removed}`;
    try {
      store.sql.insertAudit.run(Date.now(), 'system', 'link.expire_sweep', detail);
    } catch {
      /* 审计失败不影响清理 */
    }
    logger.info(`[maintenance] 过期短链回收 ${detail}`);
    return { archived, removed };
  }

  /** 回收站清理：超过保留天数的记录连统计一起删掉 */
  function purgeTrash() {
    const days = Number(settings.get('trashRetentionDays')) || 0;
    if (days <= 0) return { purged: 0 };
    const cutoff = Date.now() - days * 86400000;
    const rows = store.db.prepare('SELECT id, code FROM links WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
    if (!rows.length) return { purged: 0 };
    store.tx(() => {
      for (const row of rows) {
        store.sql.deleteLinkById.run(row.id);
        store.purgeLinkData(row.code);
      }
    });
    try {
      store.sql.insertAudit.run(Date.now(), 'system', 'link.purge_expired', `${rows.length} 条`);
    } catch {
      /* 审计失败不影响清理 */
    }
    logger.info(`[maintenance] 回收站清理 ${rows.length} 条（超过 ${days} 天）`);
    return { purged: rows.length };
  }

  /**
   * 目标链接巡检。默认关闭（间隔 0），因为这是唯一会主动往外发请求的功能，
   * 该不该开由部署的人决定。
   */
  function maybeHealthCheck() {
    const minutes = Number(settings.get('healthCheckIntervalMin')) || 0;
    if (minutes <= 0) return;
    if (healthBusy) return;
    const due = lastHealthAt + minutes * 60000;
    if (Date.now() < due) return;
    lastHealthAt = Date.now();
    if (!ctx.health) return;
    healthBusy = true;
    ctx.health
      .run({ timeout: Number(settings.get('healthCheckTimeout')) || 8000 })
      .catch((err) => logger.warn('[health] 巡检失败', err?.message || err))
      .finally(() => {
        healthBusy = false;
      });
  }

  /**
   * 到期提醒：把「N 天内到期」的短链合成一条通知推出去。
   *
   * 一条链一条通知是反效果：真有 40 条快到期时，手机上会收到 40 条，
   * 于是这个功能第二天就会被关掉。合成一条，点进去就是筛好的列表。
   */
  function maybeNotifyExpiring() {
    const day = todayKey();
    if (lastExpireDay === day) return;
    lastExpireDay = day;
    const days = Number(settings.get('notifyExpireDays')) || 0;
    if (days <= 0) return;
    const { rows } = store.expiringLinks({ days, limit: 200 });
    if (!rows.length) return;
    const preview = rows.slice(0, 5).map((r) => `/${r.code}`).join('、');
    ctx.notify?.emit('link.expiring', {
      subject: `expiring-${day}`,
      text: `${rows.length} 条短链将在 ${days} 天内到期${rows.length > 5 ? `，包括 ${preview} 等` : `：${preview}`}`,
      link: `${String(settings.get('baseUrl') || '').replace(/\/+$/, '')}/admin#/links?expiring=${days}`,
      data: { days, count: rows.length, codes: rows.slice(0, 20).map((r) => r.code) },
    });
  }

  /**
   * 静默时段结束就补发。静默期内的通知在 emit 时就挂进库里了，
   * 这里只负责挑一个「已经不在静默期」的时刻把攒下的一批合成一条发出去。
   */
  function releaseQuiet() {
    if (quietBusy || !ctx.notify?.releaseHeld) return { released: 0, dropped: 0 };
    quietBusy = true;
    try {
      const out = ctx.notify.releaseHeld();
      if (out.released || out.dropped) {
        logger.info?.(`[notify] 静默结束，补发 ${out.released} 条${out.dropped ? `，丢弃 ${out.dropped} 条` : ''}`);
      }
      return out;
    } catch (err) {
      logger.warn?.('[notify] 静默补发失败', err?.message || err);
      return { released: 0, dropped: 0 };
    } finally {
      quietBusy = false;
    }
  }

  /**
   * 定期摘要：到点把「本期要点」推一次。
   *
   * 挂在 30 秒心跳上，但真正决定推不推的是 tick() 里的三道闸：
   * 是不是到了设定的小时、是不是该推的那天、这个槽位是不是已经推过。
   * 推送失败由通知服务自己退避重试并留底，这里不吞也不重来。
   */
  function pushDigest() {
    if (digestBusy || !ctx.digestPush?.tick) return { pushed: 0, skipped: 'absent' };
    digestBusy = true;
    try {
      return ctx.digestPush.tick(new Date());
    } catch (err) {
      logger.warn?.('[digest] 推送失败', err?.message || err);
      return { pushed: 0, skipped: 'error' };
    } finally {
      digestBusy = false;
    }
  }

  function cleanup() {
    const retention = Number(settings.get('retentionDays')) || 0;
    if (retention > 0) {
      const cutoff = new Date(Date.now() - retention * 86400000);
      const key = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
      store.db.prepare('DELETE FROM click_daily WHERE day < ?').run(key);
    }
    // 每条短链的历史版本数由 historyKeep 控制，改设置时立刻生效，
    // 不必等到下一次改动才顺便裁
    const keep = Number(settings.get('historyKeep'));
    if (Number.isFinite(keep) && keep >= 0) {
      const stale = store.db
        .prepare(`SELECT id FROM link_history WHERE id NOT IN (
            SELECT id FROM link_history h2 WHERE h2.link_id = link_history.link_id ORDER BY h2.id DESC LIMIT ?
          )`)
        .all(Math.max(0, keep));
      if (stale.length) {
        const stmt = store.db.prepare('DELETE FROM link_history WHERE id = ?');
        store.tx(() => {
          for (const r of stale) stmt.run(r.id);
        });
      }
    }
    // 审计日志最多保留 5000 条
    const maxId = store.db.prepare('SELECT MAX(id) AS m FROM audit_log').get().m || 0;
    if (maxId > 5000) store.sql.trimAudit.run(maxId - 5000);
  }

  function maybeBackup() {
    const day = todayKey();
    if (lastBackupDay === day) return;
    lastBackupDay = day;
    try {
      fs.mkdirSync(config.backupDir, { recursive: true });
      const file = path.join(config.backupDir, `highurl-${day}.json`);
      if (fs.existsSync(file)) return;
      // 先写临时文件再 rename：中途崩掉只会留下一个 .tmp，
      // 不会把一个截断的 JSON 顶到「今天的备份」这个位置上
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(buildBackup(store, { hostname: config.hostname })));
      fs.renameSync(tmp, file);
      pruneBackups(config.backupDir, KEEP_AUTO_BACKUPS);
    } catch (err) {
      logger.warn('[backup] 自动备份失败', err.message);
      // 备份失败是最静默的一种故障：站点照常跑，直到真需要恢复那天才发现没有备份。
      // 这条通知的价值就在「在你还不需要它的时候告诉你」
      ctx.notify?.emit('backup.failed', {
        subject: 'auto-backup',
        text: `自动备份失败：${err.message}`,
        data: { dir: config.backupDir, error: String(err.message || err) },
      });
    }
  }

  return {
    stop: () => {
      clearInterval(timer);
      flushAll();
    },
    tick,
    sweepExpired,
    purgeTrash,
    maybeHealthCheck,
    maybeNotifyExpiring,
    releaseQuiet,
    pushDigest,
  };
}

export function pruneBackups(dir, keep) {
  try {
    const all = fs.readdirSync(dir);
    // 上一轮写临时文件时进程被杀，会留下 .json.tmp；它永远不该被保留，
    // 也不该被当成一份备份参与轮转计数
    for (const f of all.filter((n) => n.endsWith('.json.tmp'))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* ignore */
      }
    }
    const files = all
      .filter((f) => /^highurl-.*\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch {
    /* ignore */
  }
}
