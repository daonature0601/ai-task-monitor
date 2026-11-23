import json
import os
import sqlite3
import sys
from bisect import bisect_right

DB = os.path.expanduser('~/Library/Application Support/AI Task Monitor/monitor.db')
ROOT = os.path.expanduser('~/.codex/sessions')


def find_model(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == 'model' and isinstance(value, str) and value:
                return value
            hit = find_model(value)
            if hit:
                return hit
    elif isinstance(node, list):
        for item in node:
            hit = find_model(item)
            if hit:
                return hit
    return None


def scan_file(path):
    """返回 [(offset, model)]，按 offset 升序，只在模型变化处记录"""
    marks = []
    last = None
    offset = 0
    try:
        with open(path, 'rb') as handle:
            for line in handle:
                if b'"model"' in line:
                    try:
                        obj = json.loads(line)
                    except Exception:
                        obj = None
                    model = find_model(obj) if obj else None
                    if model and model != last:
                        marks.append((offset, model))
                        last = model
                offset += len(line)
    except FileNotFoundError:
        return None
    return marks


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT e.id, e.dedupe_key
          FROM usage_events e
          JOIN tasks t ON t.id = e.task_id
         WHERE e.model IS NULL AND t.tool = 'codex' AND e.dedupe_key LIKE 'tok:%'
        """
    ).fetchall()
    print(f'待回填事件: {len(rows)}')

    # dedupe_key: tok:<relpath>:<offset>
    grouped = {}
    for row in rows:
        key = row['dedupe_key']
        if key.count(':') < 2:
            continue
        _, rest = key.split(':', 1)
        relpath, offset = rest.rsplit(':', 1)
        grouped.setdefault(relpath, []).append((row['id'], int(offset)))

    total = 0
    for relpath, items in grouped.items():
        path = os.path.join(ROOT, relpath)
        marks = scan_file(path)
        if not marks:
            print(f'  跳过（无模型信息 / 文件不存在）: {relpath}')
            continue
        offsets = [m[0] for m in marks]
        models = [m[1] for m in marks]
        updates = []
        for event_id, off in items:
            idx = bisect_right(offsets, off) - 1
            if idx < 0:
                continue
            updates.append((models[idx], event_id))
        if updates:
            conn.executemany('UPDATE usage_events SET model = ? WHERE id = ?', updates)
            conn.commit()
            total += len(updates)
        print(f'  {relpath}: {len(updates)}/{len(items)} 条')

    print(f'共回填 {total} 条事件模型')

    # 让应用在下次启动时按事件模型重算费用
    conn.execute(
        "UPDATE settings SET value = json_set(value, '$.eventsCostVersion', 0) WHERE key = 'app'"
    )
    conn.commit()
    print('已标记需要重算（eventsCostVersion → 0）')


if __name__ == '__main__':
    sys.exit(main())
