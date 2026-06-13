#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Firo API 调试脚本
用于调用 5 个 Firo 接口测试签名和数据
"""

import base64
import hashlib
import json
import sys
import time
from urllib.parse import urlencode

import requests

# ==================== 配置 ====================
API_KEY = "JDSiSnXpJ61pi162VEkjSFH80FgJtmAR"
PRIVATE_KEY_PEM = """-----BEGIN RSA PRIVATE KEY-----
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

BASE_URL = "https://www.firoapi.com"

# ==================== 签名 ====================
def generate_signature(private_key_pem: str, timestamp_ms: str, api_key: str) -> str:
    """生成 RSA-SHA256 签名"""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    string_to_sign = f"apiKey={api_key}&timestamp={timestamp_ms}"
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


def call_firo_api(path: str, params: dict = None, method: str = "GET") -> dict:
    """通用 Firo API 调用"""
    timestamp_ms = str(int(time.time() * 1000))
    signature = generate_signature(PRIVATE_KEY_PEM, timestamp_ms, API_KEY)

    headers = {
        "X-API-Key": API_KEY,
        "X-Timestamp": timestamp_ms,
        "X-Signature": signature
    }

    url = BASE_URL + path
    if params:
        url += "?" + urlencode(params)

    print(f"\n{'='*80}")
    print(f"Request: {method} {url}")
    print(f"Headers: {json.dumps(headers, indent=2)}")
    print(f"{'='*80}")

    if method.upper() == "GET":
        resp = requests.get(url, headers=headers, timeout=30)
    else:
        resp = requests.post(url, headers=headers, timeout=30)

    print(f"Status: {resp.status_code}")
    try:
        data = resp.json()
        print(f"Response: {json.dumps(data, ensure_ascii=False, indent=2)[:2000]}")
        return data
    except Exception:
        print(f"Response (raw): {resp.text[:1000]}")
        return {"_raw": resp.text, "_status": resp.status_code}


# ==================== 5 个接口 ====================
def test_sports_lottery_list():
    """1. 竞彩列表 (无参数)"""
    return call_firo_api("/firo/sports-lottery/list")


def test_bd_issue_detail():
    """2. 北单期详情 (无参数)"""
    return call_firo_api("/firo/bd/issue-detail")


def test_text_match_results():
    """3. 竞彩开奖结果 (查询前天到昨天)"""
    import datetime
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=2)).strftime("%Y-%m-%d")
    end = (today - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    return call_firo_api("/firo/text/match-results", {
        "startDate": start,
        "endDate": end
    })


def test_text_match_results_single():
    """4. 竞彩开奖结果 (按日期 - 测试单日)"""
    return call_firo_api("/firo/text/match-results", {
        "date": "2026-06-09"
    })


def test_sports_lottery_all_list():
    """5. 竞彩按日期列表"""
    return call_firo_api("/firo/sports-lottery/all-list", {
        "date": "2026-06-09"
    })


# ==================== 主函数 ====================
def main():
    print("Firo API 调试脚本")
    print(f"API Key: {API_KEY[:8]}***")

    tests = [
        ("1. /firo/sports-lottery/list", test_sports_lottery_list),
        ("2. /firo/bd/issue-detail", test_bd_issue_detail),
        ("3. /firo/text/match-results (startDate/endDate)", test_text_match_results),
        ("4. /firo/text/match-results (date)", test_text_match_results_single),
        ("5. /firo/sports-lottery/all-list (date)", test_sports_lottery_all_list),
    ]

    results = {}
    for name, fn in tests:
        try:
            print(f"\n>>> 测试: {name}")
            data = fn()
            results[name] = {"success": True, "code": data.get("code"), "data_count": len(data.get("data") or [])}
        except Exception as e:
            print(f"错误: {e}")
            results[name] = {"success": False, "error": str(e)}

    print(f"\n\n{'='*80}")
    print("测试结果汇总:")
    print(f"{'='*80}")
    for name, r in results.items():
        status = "✅" if r.get("success") and r.get("code") == 200 else "❌"
        print(f"{status} {name}: {r}")


if __name__ == "__main__":
    # 也支持单独测试某个接口
    if len(sys.argv) > 1:
        arg = sys.argv[1]
        if arg == "list":
            test_sports_lottery_list()
        elif arg == "bd":
            test_bd_issue_detail()
        elif arg == "match-results":
            test_text_match_results()
        elif arg == "match-results-single":
            test_text_match_results_single()
        elif arg == "all-list":
            test_sports_lottery_all_list()
        else:
            print(f"未知参数: {arg}")
            print("可用: list, bd, match-results, match-results-single, all-list")
    else:
        main()
