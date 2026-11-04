#!/bin/sh
set -eu
umask 077
mkdir -p /run/sshd /root/.ssh "$FIXTURE_TARGET"
cp /fixture/client.pub /root/.ssh/authorized_keys
password=$(head -c 32 /dev/urandom | base64)
printf 'root:%s\n' "$password" | chpasswd
unset password
python3 -m http.server 8080 --bind 0.0.0.0 --directory "$FIXTURE_TARGET" >/tmp/http.log 2>&1 &
exec /usr/sbin/sshd -D -e -f /fixture/sshd_config
