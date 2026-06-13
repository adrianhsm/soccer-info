#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Juhe API 调试脚本
用于测试世界杯赛程查询接口 (apis.juhe.cn)
"""

import json
import sys
import time
from urllib.parse import urlencode

import requests

# ==================== 配置 ====================
BASE_URL = "https://apis.juhe.cn/fapigw/worldcup2026"

# 3 个 API Key (顺序使用，与项目一致)
API_KEYS = [
    "3ab88d882bc6bfc7876522e5d4312cdc",
    "0bb962e79db05889e8f0cc80c0001c71",
    "abf6c6f15996b6dc166817d9452c56f9",
]

WORLDCUP_API_KEY = "09b351bedd9e04db624c5b03841d2e1a"


# ==================== 接口调用 ====================
def call_juhe_api(path: str, params: dict = None, api_key: str = None) -> dict:
    """通用 Juhe API 调用"""
    if api_key is None:
        api_key = API_KEYS[0]
    if params is None:
        params = {}
    params['key'] = api_key

    url = BASE_URL + path + "?" + urlencode(params)
    print(f"\n{'='*80}")
    print(f"Request: GET {url[:120]}...")
    print(f"Key: {api_key[:8]}***")
    print(f"{'='*80}")

    resp = requests.get(url, timeout=30)
    print(f"Status: {resp.status_code}")

    try:
        data = resp.json()
        # 完整显示
        print(f"Response: {json.dumps(data, ensure_ascii=False, indent=2)[:3000]}")
        return data
    except Exception:
        print(f"Response (raw): {resp.text[:1000]}")
        return {"_raw": resp.text, "_status": resp.status_code}


# ==================== 1. 世界杯赛程查询 ====================
def test_worldcup_schedule(api_key: str = None):
    """
    GET /fapigw/worldcup2026/schedule
    文档: https://www.juhe.cn/docs/api/id/616
    返回世界杯全部 104 场比赛信息（包含已结束和未开始的）
    """
    if api_key is None:
        api_key = WORLDCUP_API_KEY
    return call_juhe_api("/schedule", api_key=api_key)


# ==================== 2. 解析比分和结果 ====================
def parse_schedule_results(data: dict):
    """从 schedule 接口返回的数据中提取比赛结果"""
    if data.get("error_code") != 0 or not data.get("result"):
        print("❌ 数据无效")
        return

    result = data["result"]
    schedule_list = result.get("data", [])
    if not isinstance(schedule_list, list):
        print("❌ 异常数据结构")
        return

    print(f"\n📅 共 {len(schedule_list)} 天的比赛")

    finished = []
    upcoming = []
    in_progress = []

    for day in schedule_list:
        for m in day.get("schedule_list", []):
            home = m.get("host_team_name") or m.get("host_team")
            away = m.get("guest_team_name") or m.get("guest_team")
            home_score = m.get("host_team_score")
            away_score = m.get("guest_team_score")
            match_time = m.get("date_time") or m.get("match_time")
            status_text = m.get("match_des") or m.get("status")
            match_status = m.get("match_status")
            stage = m.get("match_type_name") or m.get("stage")
            stage_detail = m.get("match_type_des", "")
            group_name = m.get("group_name")
            venue = m.get("venue") or m.get("stadium")
            match_id = m.get("team_id") or m.get("match_id")

            # 根据 match_status 字段判断: "1" 未开赛, "2" 进行中, "3" 完赛
            has_score = home_score not in (None, "", "-")
            status = match_status

            match_info = {
                "match_id": match_id,
                "home": home,
                "away": away,
                "score": f"{home_score}-{away_score}" if has_score else "-",
                "time": match_time,
                "status_code": status,
                "status_text": status_text,
                "stage": f"{stage} {stage_detail} {group_name}".strip(),
                "venue": venue
            }

            if status == "3" or has_score:
                finished.append(match_info)
            elif status == "2" or status_text == "进行中":
                in_progress.append(match_info)
            else:
                upcoming.append(match_info)

    print(f"\n✅ 已结束: {len(finished)} 场")
    if finished:
        print("\n最近 10 场已结束比赛:")
        for m in finished[:10]:
            print(f"  • {m['time']} | {m['home']} {m['score']} {m['away']} | {m['stage']}")

    print(f"\n🔴 进行中: {len(in_progress)} 场")
    for m in in_progress[:5]:
        print(f"  • {m['time']} | {m['home']} vs {m['away']} | {m['stage']}")

    print(f"\n⏰ 未开赛: {len(upcoming)} 场")
    if upcoming:
        print("\n即将开始的 5 场比赛:")
        for m in upcoming[:5]:
            print(f"  • {m['time']} | {m['home']} vs {m['away']} | {m['stage']}")

    return {
        "total": len(finished) + len(in_progress) + len(upcoming),
        "finished": finished,
        "in_progress": in_progress,
        "upcoming": upcoming
    }


# ==================== 3. 全部 keys 测试 ====================
def test_with_all_keys():
    """用所有 3 个 key 测试，验证是否有可用 key"""
    print("\n" + "="*80)
    print("🧪 测试所有 API Key")
    print("="*80)

    results = []
    for i, key in enumerate(API_KEYS, 1):
        print(f"\n--- Key #{i} ---")
        data = call_juhe_api("/schedule", api_key=key)
        code = data.get("error_code")
        count = 0
        if code == 0 and data.get("result"):
            schedule_list = data["result"].get("data", [])
            count = sum(len(day.get("schedule_list", [])) for day in schedule_list)
        results.append({
            "key_index": i,
            "key_prefix": key[:8] + "***",
            "error_code": code,
            "reason": data.get("reason", ""),
            "matches_count": count
        })
        # 避免速率限制
        time.sleep(1)

    print(f"\n\n{'='*80}")
    print("📊 测试汇总")
    print("="*80)
    for r in results:
        status = "✅" if r["error_code"] == 0 else "❌"
        print(f"{status} Key #{r['key_index']} ({r['key_prefix']}): code={r['error_code']}, msg={r['reason']}, matches={r['matches_count']}")


# ==================== 主函数 ====================
def main():
    print("Juhe 世界杯 API 调试脚本")
    print(f"Base URL: {BASE_URL}")

    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "schedule":
            data = test_worldcup_schedule()
            parse_schedule_results(data)
        elif arg == "all-keys":
            test_with_all_keys()
        elif arg == "summary":
            data = test_worldcup_schedule()
            parse_schedule_results(data)
        else:
            print(f"未知参数: {arg}")
            print("可用: schedule, all-keys, summary")
    else:
        # 默认：测试 schedule 接口并解析结果
        data = test_worldcup_schedule()
        parse_schedule_results(data)


if __name__ == "__main__":
    main()
