#!/bin/bash
curl -s "https://live.500.com/wanchang.php" | iconv -f GBK -t UTF-8 2>/dev/null | grep -i "class=.*比分" | head -20