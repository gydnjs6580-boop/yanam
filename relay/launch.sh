#!/bin/bash
# 라이트세일 인스턴스 만들 때 "시작 스크립트(launch script)"에 그대로 붙여넣기 (Ubuntu 22.04/24.04)
set -e
mkdir -p /opt/relay
curl -fsSL https://raw.githubusercontent.com/gydnjs6580-boop/yanam/main/relay/relay.py -o /opt/relay/relay.py
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=yanam-relay" \
  -keyout /opt/relay/key.pem -out /opt/relay/cert.pem
cat > /etc/systemd/system/relay.service <<'UNIT'
[Unit]
Description=yanam sms relay
After=network-online.target
[Service]
ExecStart=/usr/bin/python3 /opt/relay/relay.py
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now relay
