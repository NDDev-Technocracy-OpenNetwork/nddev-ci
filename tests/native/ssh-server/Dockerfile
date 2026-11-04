FROM nginxinc/nginx-unprivileged@sha256:782bb89768cc87b7f95c18b95baa1af250e5d451f26794f59363540161147c01
USER 0
RUN apk add --no-cache openssh-server python3 py3-yaml \
    && apk add --no-cache --upgrade libexpat=2.10.0-r0 libx11=1.8.14-r0
COPY serve.sh /serve.sh
ENTRYPOINT ["/bin/sh", "/serve.sh"]
