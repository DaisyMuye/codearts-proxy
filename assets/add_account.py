"""把 CSV 里的 AK 合并进现有账号池，并逐个验证有效性。"""
import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
CFG = HERE / 'codearts-aksk.json'

sys.path.insert(0, str(HERE))
from verify_ak import check


def load_cfg():
    if not CFG.exists():
        return []
    d = json.loads(CFG.read_text(encoding='utf-8'))
    if isinstance(d, list):
        return d
    if 'accounts' in d:
        return d['accounts']
    if d.get('access_key_id'):
        return [d]
    return []


def from_csv(path):
    text = Path(path).read_text(encoding='utf-8-sig')
    return [{'access_key_id': (r.get('Access Key Id') or '').strip(),
             'secret_access_key': (r.get('Secret Access Key') or '').strip()}
            for r in csv.DictReader(text.splitlines())
            if (r.get('Access Key Id') or '').strip()]


def main():
    paths = sys.argv[1:]
    if not paths:
        print('用法: python add_account.py <credentials.csv> [more.csv ...]')
        print('CSV 从华为云控制台「我的凭证 → 访问密钥」下载')
        return 1

    candidates = []
    seen = set()
    for p in paths:
        if not Path(p).exists():
            print(f'跳过（不存在）: {p}')
            continue
        for a in from_csv(p):
            if a['access_key_id'] not in seen:
                seen.add(a['access_key_id'])
                candidates.append(a)
                print(f'新增候选: {a["access_key_id"]}  ({Path(p).name})')

    for a in load_cfg():
        if a['access_key_id'] not in seen:
            seen.add(a['access_key_id'])
            candidates.append(a)
            print(f'已有账号: {a["access_key_id"]}')

    print('\n验证中…')
    good = []
    for a in candidates:
        ok, msg = check(a['access_key_id'], a['secret_access_key'])
        print(f'  {"✓" if ok else "✗"} {a["access_key_id"]}  {msg}')
        if ok:
            good.append(a)

    if not good:
        print('\n没有可用账号', file=sys.stderr)
        return 1

    out = good[0] if len(good) == 1 else {'accounts': good}
    CFG.write_text(json.dumps(out, indent=2), encoding='utf-8')
    print(f'\n已写入 {len(good)} 个可用账号 → {CFG.name}')
    print(f'并发上限: {len(good)} × 3 = {len(good) * 3} 会话/60秒')
    return 0


if __name__ == '__main__':
    sys.exit(main())
