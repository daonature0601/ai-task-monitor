import json
import os
import sqlite3
import sys
from bisect import bisect_right

DB = os.path.expanduser('~/Library/Application Support/AI Task Monitor/monitor.db')
WB_ROOT = os.path.expanduser('~/.workbuddy/projects')
CLAUDE_ROOT = os.path.expanduser('~/.claude/projects')


def find_model(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ('model', 'modelId', 'modelIdName') and isinstance(value, str) and value:
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


def walk_jsonl_files(root):
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith('.jsonl'):
                yield os.path.join(base, name)


def collect_workbuddy():
    """messageId -> model"""
    mapping = {}
    for path in walk_jsonl_files(WB_ROOT):
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as handle:
                for line in handle:
                    if '"model' not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    message_id = obj.get('id') or obj.get('messageId')
                    provider = obj.get('providerData') or {}
                    model = provider.get('model') or obj.get('requestModelName') or find_model(obj)
                    if message_id and model:
                        mapping[str(message_id)] = str(model)
        except OSError:
            continue
    return mapping


def collect_claude():
    """message uuid -> model"""
    mapping = {}
    for path in walk_jsonl_files(CLAUDE_ROOT):
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as handle:
                for line in handle:
                    if '"model"' not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    message = obj.get('message') or {}
                    model = message.get('model') if isinstance(message, dict) else None
                    uid = obj.get('uuid') or (message.get('id') if isinstance(message, dict) else None)
                    if uid and model:
                        mapping[str(uid)] = str(model)
        except OSError:
            continue
    return mapping


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # --- WorkBuddy：wb:usage:<workspace>:<messageId>
    wb = collect_workbuddy()
    print(f'WorkBuddy 消息模型: {len(wb)}')
    rows = conn.execute(
        """
        SELECT e.id, e.dedupe_key FROM usage_events e JOIN tasks t ON t.id = e.task_id
         WHERE e.model IS NULL AND t.tool = 'workbuddy' AND e.dedupe_key LIKE 'wb:usage:%'
        """
    ).fetchall()
    updates = []
    for row in rows:
        message_id = row['dedupe_key'].rsplit(':', 1)[-1]
        model = wb.get(message_id)
        if model:
            updates.append((model, row['id']))
    if updates:
        conn.executemany('UPDATE usage_events SET model = ? WHERE id = ?', updates)
        conn.commit()
    print(f'WorkBuddy 回填 {len(updates)}/{len(rows)}')

    # --- Claude：msg:<uuid>
    claude = collect_claude()
    print(f'Claude 消息模型: {len(claude)}')
    rows = conn.execute(
        """
        SELECT e.id, e.dedupe_key FROM usage_events e JOIN tasks t ON t.id = e.task_id
         WHERE e.model IS NULL AND t.tool = 'claude-code' AND e.dedupe_key LIKE 'msg:%'
        """
    ).fetchall()
    updates = []
    for row in rows:
        message_id = row['dedupe_key'].split(':', 1)[1]
        model = claude.get(message_id)
        if model:
            updates.append((model, row['id']))
    if updates:
        conn.executemany('UPDATE usage_events SET model = ? WHERE id = ?', updates)
        conn.commit()
    print(f'Claude 回填 {len(updates)}/{len(rows)}')

    conn.execute(
        "UPDATE settings SET value = json_set(value, '$.eventsCostVersion', 0) WHERE key = 'app'"
    )
    conn.commit()
    print('已标记需要重算（eventsCostVersion → 0）')


if __name__ == '__main__':
    sys.exit(main())
