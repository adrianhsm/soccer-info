#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
更新JC近一个月的比赛比分

按天循环调用 /firo/text/match-results 接口，获取近 N 天的所有比赛结果。
- 只保留 matchResultStatus="2" 或 poolStatus="Payout" 的已结束比赛
- 显示比分、半场比分、win_flag 等信息
- 可选：自动调用 Worker 端点更新数据库

使用示例：
  python3 update_jc_results_monthly.py                          # 默认 30 天
  python3 update_jc_results_monthly.py --days 7                 # 近 7 天
  python3 update_jc_results_monthly.py --days 60                # 近 60 天
  python3 update_jc_results_monthly.py --update-db              # 同时更新数据库
  python3 update_jc_results_monthly.py --csv jc_results.csv     # 导出 CSV
"""

import argparse
import base64
import csv
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import urlencode

import requests

# ==================== Firo API 配置 ====================
FIRO_API_KEY = "JDSiSnXpJ61pi162VEkjSFH80FgJtmAR"
FIRO_PRIVATE_KEY_PEM = """-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAl2II1jO1uOvxKbJHHzXtVDWEDrcYdz7GTalf62wQxJ+VUNGW
L7PsyIgGzmUzbMxwj8N7SEe+F3hmrHuaED6u+Zfv2QNcG3L9f1O0QvRZVe3W4faA
UFpfnXrUHmBqT9QNtBnq32x/JaaWoOhO7Bv4q6ABBszHDLVuBXVjgbIddVlbYylq
GytAu7sP8uU0GkEHALpXSl1vua871TQ05jRWx9b9G9s2futqUiw8IBLXgWNIltJz
2wcRwFlW3IjTdAUEk5/1kjE7Y7YeMPt77vIieq1Q4Z/g9xEpB5ncJnSCpvBcR1g9
QF33KWfI4f2yCIwIyfa/YWYwkTAt0b9lJCiCAQIDAQABAoIBAESjY6RTr9qXyDIC
rnK9Tc13slfFtuciZGGEIYSp6/Rq8xXA4drhNsQ5wPRGOInlLEhS9wvv04XqxosA
Q/uHoGh09oAsINAlVEEuH7aX+gWXIG42CTnlsCLENXdMegeV+1ykv7TsCb51iSiO
DHLLv/V5R93gbYQaozcAYczFiMvSsjQlNIxYxcNvMfGZClvD2dlfJek5+7Ql7sz1
GMGNxEJZXSdo/gEagfsErWCSWFIP2cO3oVhb/STC2qIxf9C95WsKNfs9pDexb1dc
x9bNshS7rTCIkz6ABjhcXB1wXr3YzB6Km9p4HpRUL9v1nFhH3WP08yFZe7GdHKmH
aKfSzxECgYEA6KYeqoZXT0buJMirZM7Vn0FZb2SiVPXW3QJNk/i7obgG0S0hk+cY
EhbSX3V5wq/avXt7lYEV2UYPs8yvaVy3xQ2Pk2TXf9Tb/w2ZSmQVSRBNvMYwMFZR
Qji/7evD1QE+rJuXVkMLDbWPbN/wxxLWp7HZvH9sZ4Q3RRkBGYHDzdUCgYEAppPM
MAWbPundJXcz22aOOPcZ/exUvVdFcGHsHnQqUcMh+hzmtvv/maAH62wLqgM7nIEq
1fo7vwXnvUKgQK0AZj2oGLqXSvI2wHEibkzc/yndcDbrtRTR0KEVHN1tOoDnEyOK
klPYqYG+Up2/nqxf0yS5F3htB7ve5cCkkaXcfX0CgYAT9gTVjrc5BxXxtAH4oUJ0
6o943kKLVZh81/C+DG5U3sw+8EdcQEyxaKHeLN8olBwJe+nLlwq/3KIGRD6cpKbj
0lkKRXGz9xh1Fr6bQmENJsf0tXB3BUDtlJ7rE/p2cSfmeWcPsKrnHzfSGJi5C+W8
96Z95NTxQMfZNt8ASED7jQKBgHydrO9wAkf6pJpWptDH1DYBhcxUdMCA/U2ps/7E
YLRyCoUWAfN6aij/c21HkyJI8NuQNf+GCBRL0qXfpgs8YUQbdBmr3WsP8K3e9ScX
EW1CYIqGS6dYP+6X0zeY3xIZRMUonY4Cc9+7VCpyINwPkFBg9Kb+THKwtXujtnnP
XzfxAoGBANVIVr55NxTkmweLDH/j/nQ0K/12D0ulYgkCUFAW0spL7sQD4JSNfqIc
Gfnq1jvmINiJ/pJiZjYNeAafpvGJtKYDq1vnGLF4AasnHDGxN9yVG6OzbjdDbIjF
kw7q470TbKbjQsleeKImMSEonkqWkXUNzhnmp4gO+zv/xL4RhzFn
-----END RSA PRIVATE KEY-----"""
FIRO_BASE_URL = "https://www.firoapi.com"

# ==================== Worker 配置 ====================
WORKER_URL = "https://soccer-info-worker.adrianhsm.workers.dev"
API_SECRET = "a8272bab12c11e8e00ca15101b054af7"


# ==================== 签名 ====================
def build_string_to_sign(api_key: str, params: dict, timestamp_ms: str) -> str:
    parts = [f"apiKey={api_key}", f"timestamp={timestamp_ms}"]
    for key, value in sorted((params or {}).items()):
        if value is not None:
            parts.append(f"{key}={value}")
    return "&".join(parts)


def generate_signature(private_key_pem: str, string_to_sign: str) -> str:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode('utf-8'),
        password=None
    )
    signature = private_key.sign(
        string_to_sign.encode('utf-8'),
        padding.PKCS1v15(),
        hashes.SHA256()
    )
    return base64.b64encode(signature).decode('utf-8')


def call_firo_api(path: str, params: dict = None) -> dict:
    params = params or {}
    timestamp_ms = str(int(time.time() * 1000))
    string_to_sign = build_string_to_sign(FIRO_API_KEY, params, timestamp_ms)
    signature = generate_signature(FIRO_PRIVATE_KEY_PEM, string_to_sign)

    headers = {
        "X-API-Key": FIRO_API_KEY,
        "X-Timestamp": timestamp_ms,
        "X-Signature": signature
    }

    url = FIRO_BASE_URL + path + "?" + urlencode(params) if params else FIRO_BASE_URL + path
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ==================== 主逻辑 ====================
def fetch_day_results(date_str: str) -> list:
    """获取某一天的所有比赛结果（已结束的比赛）"""
    try:
        data = call_firo_api("/firo/text/match-results", {
            "startDate": date_str,
            "endDate": date_str
        })
        if data.get("code") != 200:
            return []
        results = (data.get("data") or {}).get("results", []) or []
        # 只保留已结束的比赛
        return [r for r in results if r.get("matchResultStatus") == "2" or r.get("poolStatus") == "Payout"]
    except Exception as e:
        print(f"  ⚠️  {date_str} 调用失败: {e}")
        return []


def trigger_worker_sync() -> dict:
    """触发 Worker 端 syncFiroMatchResults 同步"""
    url = f"{WORKER_URL}/api/firo/match-results/sync"
    headers = {"x-api-secret": API_SECRET}
    resp = requests.post(url, headers=headers, timeout=120)
    resp.raise_for_status()
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description='更新JC近一个月的比赛比分')
    parser.add_argument('--days', type=int, default=30, help='更新近多少天（默认 30）')
    parser.add_argument('--update-db', action='store_true', help='同时调用 Worker 同步到数据库')
    parser.add_argument('--csv', type=str, metavar='PATH', help='导出到 CSV 文件')
    parser.add_argument('--start-date', type=str, metavar='YYYY-MM-DD', help='自定义起始日期')
    parser.add_argument('--end-date', type=str, metavar='YYYY-MM-DD', help='自定义结束日期（默认昨天）')
    args = parser.parse_args()

    today = datetime.now()
    if args.end_date:
        end_date = datetime.strptime(args.end_date, "%Y-%m-%d")
    else:
        end_date = today - timedelta(days=1)

    if args.start_date:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d")
    else:
        start_date = today - timedelta(days=args.days)

    print("=" * 80)
    print(f"JC 开奖结果更新 - {start_date.strftime('%Y-%m-%d')} ~ {end_date.strftime('%Y-%m-%d')}")
    print(f"  共 {(end_date - start_date).days + 1} 天")
    print("=" * 80)

    all_results = []
    total_days = (end_date - start_date).days + 1
    current = start_date

    for i in range(total_days):
        date_str = current.strftime("%Y-%m-%d")
        sys.stdout.write(f"\r  进度: [{i+1}/{total_days}] {date_str} ... ")
        sys.stdout.flush()

        results = fetch_day_results(date_str)
        all_results.extend(results)

        # 防止 API 限流
        if i < total_days - 1:
            time.sleep(0.3)

        current += timedelta(days=1)

    print(f"\n\n✅ 共拉取到 {len(all_results)} 场已结束比赛")

    # 显示
    if all_results:
        print("\n" + "=" * 80)
        print(f"{'日期':12s} {'主队':12s} {'客队':12s} {'比分':6s} {'半场':6s} {'胜平负':6s}")
        print("-" * 80)
        for r in all_results:
            date = r.get("matchDate", "")
            home = r.get("homeTeam", r.get("allHomeTeam", ""))
            away = r.get("awayTeam", r.get("allAwayTeam", ""))
            full = r.get("sectionsNo999", "-")
            half = r.get("sectionsNo1", "-")
            win = r.get("winFlag", "-")
            print(f"{date:12s} {home:12s} {away:12s} {full:6s} {half:6s} {win:6s}")

    # 导出 CSV
    if args.csv and all_results:
        keys = ["matchDate", "homeTeam", "allHomeTeam", "awayTeam", "allAwayTeam",
                "sectionsNo999", "sectionsNo1", "winFlag", "h", "d", "a",
                "matchResultStatus", "poolStatus", "matchNumStr", "matchId"]
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(all_results)
        print(f"\n📁 已导出到 {args.csv}")

    # 同步数据库
    if args.update_db:
        print("\n" + "=" * 80)
        print("触发 Worker 同步数据库...")
        try:
            result = trigger_worker_sync()
            print(f"  ✅ {result}")
        except Exception as e:
            print(f"  ❌ 失败: {e}")
            sys.exit(1)

    print("\n✅ 完成")


if __name__ == "__main__":
    main()
